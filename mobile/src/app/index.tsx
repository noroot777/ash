import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { View, Text, Pressable, SectionList, RefreshControl } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TaskListItem, Group } from "@ash/shared";
import { workersOf } from "@ash/shared/team";
import { getBaseURL } from "@/lib/config";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { refreshAll } from "@/lib/data";
import {
  advanceHiddenReveal,
  buildTaskTree,
  keepVisibleFor,
  previewTasksByAge,
  sortForList,
  visibleOnThisMachine,
} from "@/lib/taskTree";
import { useTheme, radius, fonts } from "@/lib/theme";
import { groupLabel } from "@/lib/util";
import { Pill } from "@/components/ui";
import { SideDrawer } from "@/components/SideDrawer";
import { TaskListRow } from "@/components/TaskListRow";
import { PreviewMoreRow, SectionHeader } from "@/components/TaskSectionHeader";
import { Ionicons } from "@expo/vector-icons";

// 列表 section 的元信息。两种视图:
//   默认视图——置顶区 + 「任务」区(更新时间倒序,不按状态切块) + 底部可折叠「已归档」区;
//   分组视图——每个分组一区(带整组运行/暂停) + 末尾「未分组」区。
//
// 每一节都过同一道年龄闸(见 lib/taskTree),`hidden` 是被闸住的那几条,由尾行负责放出来。
type SectionMeta =
  | { kind: "tree"; key: string; label: string; hidden: TaskListItem[] }
  | { kind: "archived"; key: "archived"; count: number; hidden: TaskListItem[] }
  | { kind: "group"; key: string; group: Group; hidden: TaskListItem[] }
  | { kind: "ungrouped"; key: "ungrouped"; hidden: TaskListItem[] };

// 分组视图 section 头里的「运行/继续」按钮。
function GroupRunChip({ label, groupName, onPress }: { label: string; groupName: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}分组：${groupName}`}
      onPress={onPress}
      hitSlop={10}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: radius.md,
        backgroundColor: theme.accent,
      }}
    >
      <Ionicons name="play" size={12} color={theme.accentFg} />
      <Text style={{ color: theme.accentFg, fontSize: 12, fontFamily: fonts.bodySemi }}>{label}</Text>
    </Pressable>
  );
}

export default function TaskListScreen() {
  if (!getBaseURL()) return <Redirect href="/settings" />;
  return <TaskList />;
}

function TaskList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const projects = useStore((s) => s.projects);
  const projectId = useStore((s) => s.projectId);
  const tasks = useStore((s) => s.tasks);
  const groups = useStore((s) => s.groups);
  const upsertGroup = useStore((s) => s.upsertGroup);
  const [refreshing, setRefreshing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false); // 底部「已归档」区默认折叠
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());
  // 年龄闸：手动展开过的分节。超过一天没动的任务默认收在「显示另外 N 条」后面。
  const [previewOpen, setPreviewOpen] = useState<Set<string>>(new Set());
  // 最近从这张列表点进去的那条任务。它要是正被年龄闸藏着，回来时把那一节顶开一次。
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  const [view, setView] = useState<"all" | "group">("all"); // 列表视图:全部 / 按分组
  const currentProject = projects.find((p) => p.id === projectId) ?? null;

  // 整组运行/暂停(乐观更新 paused,随后 refreshAll 同步成员状态)。
  const runGroup = (g: Group) => {
    upsertGroup({ ...g, paused: false });
    api.runGroup(g.id).catch(() => {}).finally(() => refreshAll().catch(() => {}));
  };
  const pauseGroup = (g: Group) => {
    upsertGroup({ ...g, paused: true });
    api.pauseGroup(g.id).then(upsertGroup).catch(() => refreshAll().catch(() => {}));
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } catch {
      /* keep stale data on failure */
    }
    setRefreshing(false);
  }, []);

  const sections = useMemo<(SectionMeta & { data: TaskListItem[] })[]>(() => {
    const mine = tasks.filter((t) => t.projectId === projectId);
    // 星标/置顶/等你验收的行永不因旧被藏。判据跟 web 的 keepVisible 同源。
    const keepVisible = keepVisibleFor(tasks);
    const now = Date.now();
    // 每一节都过同一道年龄闸：手动展开过就整节放出来，`hidden` 始终是被闸住的那几条,
    // 尾行据此显示「显示另外 N 条 / 收起」。
    const fold = (key: string, all: TaskListItem[]) => {
      const preview = previewTasksByAge(all, now, keepVisible);
      return { data: previewOpen.has(key) ? all : preview.visible, hidden: preview.hidden };
    };

    // 分组视图:每个分组一区(含空组,便于整组运行/查看结构) + 末尾「未分组」区。归档任务不出现。
    if (view === "group") {
      const active = mine.filter(
        (t) => t.parentId === null && !t.archived && visibleOnThisMachine(t),
      );
      const projGroups = groups
        // team dispatch 自动建的内部组由团队卡管理，不进入普通分组视图。
        .filter((g) => g.projectId === projectId && !g.ownerTaskId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const groupSections = projGroups.map((g) => ({
        kind: "group" as const,
        key: g.id,
        group: g,
        ...fold(g.id, sortForList(active.filter((t) => t.groupId === g.id))),
      }));
      const ungrouped = sortForList(active.filter((t) => !t.groupId));
      return ungrouped.length
        ? [...groupSections, { kind: "ungrouped" as const, key: "ungrouped" as const, ...fold("ungrouped", ungrouped) }]
        : groupSections;
    }

    // 默认视图：置顶区 +「任务」区。**不按状态切块** —— 排序只认更新时间倒序，刚出事的
    // 任务永远在最上面。等你答复 / 验证未通过这些靠行内的颜色和标识认（TaskStatusChips），
    // 不靠位置：按状态提升某一档，就等于把「最近发生了什么」这条唯一可靠的线索打散。
    // 规则与 web 的 taskTreeModel 完全一致，逐条搬在 lib/taskTree.ts。
    const treeSections = buildTaskTree(mine).map((section) => ({
      kind: "tree" as const,
      key: section.key,
      label: section.label,
      ...fold(section.key, section.tasks),
    }));
    const archived = mine
      .filter((t) => t.parentId === null && t.archived)
      .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
    return archived.length
      ? [
          ...treeSections,
          {
            kind: "archived" as const,
            key: "archived" as const,
            count: archived.length,
            hidden: [],
            data: archivedOpen ? archived : [],
          },
        ]
      : treeSections;
  }, [tasks, groups, projectId, view, archivedOpen, previewOpen]);

  const togglePreview = useCallback(
    (key: string) =>
      setPreviewOpen((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  // 点开过的那条任务正被年龄闸藏着时，把它那一节顶开 —— 但**只顶一次**：用户随后手动
  // 收起，不能再被同一条揭示反复扒开，否则收起按钮看起来是坏的（advanceHiddenReveal）。
  const hiddenSection = useMemo(() => {
    if (!lastOpened) return null;
    const hit = sections.find((section) => section.hidden.some((task) => task.id === lastOpened));
    return hit ? hit.key : null;
  }, [sections, lastOpened]);
  const revealKey = hiddenSection ? `${hiddenSection}:${lastOpened}` : null;
  const lastRevealKey = useRef<string | null>(null);
  useEffect(() => {
    const next = advanceHiddenReveal(lastRevealKey.current, revealKey);
    lastRevealKey.current = next.lastKey;
    if (next.reveal && hiddenSection) {
      setPreviewOpen((current) => current.has(hiddenSection) ? current : new Set(current).add(hiddenSection));
    }
  }, [hiddenSection, revealKey]);

  const openTask = useCallback(
    (taskId: string) => {
      setLastOpened(taskId);
      router.push(`/task/${taskId}`);
    },
    [router],
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {/* Custom header — hamburger (drawer) + title + current project label */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingTop: insets.top + 6,
          paddingHorizontal: 16,
          paddingBottom: 10,
        }}
      >
        <Pressable accessibilityRole="button" accessibilityLabel="打开项目菜单" onPress={() => setDrawerOpen(true)} hitSlop={10}>
          <Ionicons name="menu" size={26} color={theme.ink} />
        </Pressable>
        <Text style={{ color: theme.ink, fontSize: 26, fontFamily: fonts.display }}>Tasks</Text>
        {currentProject ? (
          <Text style={{ color: theme.muted, fontSize: 14, fontFamily: fonts.mono, flex: 1 }} numberOfLines={1}>
            {currentProject.name}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
      </View>

      {/* 视图切换:全部(更新时间倒序) / 按分组;分组视图右侧进入分组管理 */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
        <Pill label="全部" active={view === "all"} onPress={() => setView("all")} />
        <Pill label="分组" active={view === "group"} onPress={() => setView("group")} />
        <View style={{ flex: 1 }} />
        {view === "group" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="管理分组"
            onPress={() => router.push("/groups")}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 10,
              paddingVertical: 7,
              borderRadius: radius.md,
              backgroundColor: pressed ? theme.raised : "transparent",
            })}
          >
            <Ionicons name="settings-outline" size={15} color={theme.muted} />
            <Text style={{ color: theme.muted, fontSize: 13 }}>管理</Text>
          </Pressable>
        ) : null}
      </View>

      <SectionList<TaskListItem, SectionMeta>
        sections={sections}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => {
          const workers = item.mode === "team" ? workersOf(tasks, item.id) : [];
          return (
            <TaskListRow
              task={item}
              workers={workers}
              expanded={openTeams.has(item.id)}
              onToggle={() =>
                setOpenTeams((current) => {
                  const next = new Set(current);
                  next.has(item.id) ? next.delete(item.id) : next.add(item.id);
                  return next;
                })
              }
              onPress={() => openTask(item.id)}
              onWorkerPress={(worker) => openTask(worker.id)}
            />
          );
        }}
        // 展开的团队 + 展开的年龄闸分节都要能让行重画：Set 的引用变了但 VirtualizedList
        // 只按 extraData 判脏，摊平成字符串才不会漏掉「换了一个团队展开」这种同尺寸变化。
        extraData={`${[...openTeams].join(",")}|${[...previewOpen].join(",")}`}
        renderSectionHeader={({ section }) =>
          section.kind === "archived" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${archivedOpen ? "收起" : "展开"}已归档任务，共 ${section.count} 个`}
              accessibilityState={{ expanded: archivedOpen }}
              onPress={() => setArchivedOpen((v) => !v)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                marginHorizontal: 16,
                marginTop: 20,
                paddingHorizontal: 12,
                paddingVertical: 11,
                borderRadius: radius.md,
                backgroundColor: pressed ? theme.raised : theme.overlay,
              })}
            >
              <Ionicons name="archive-outline" size={14} color={theme.faint} />
              <Text style={{ color: theme.muted, fontSize: 11, fontFamily: fonts.monoMed, letterSpacing: 1 }}>已归档</Text>
              <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>· {section.count}</Text>
              <View style={{ flex: 1 }} />
              <Ionicons name={archivedOpen ? "chevron-up" : "chevron-down"} size={16} color={theme.faint} />
            </Pressable>
          ) : section.kind === "group" ? (
            <SectionHeader
              icon="layers-outline"
              label={groupLabel(section.group)}
              labelColor={theme.ink}
              count={section.data.length + section.hidden.length}
              right={section.group.paused ? (
                <GroupRunChip label="继续" groupName={groupLabel(section.group)} onPress={() => runGroup(section.group)} />
              ) : (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <GroupRunChip label="运行" groupName={groupLabel(section.group)} onPress={() => runGroup(section.group)} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`暂停分组：${groupLabel(section.group)}`}
                    onPress={() => pauseGroup(section.group)}
                    hitSlop={10}
                    style={{
                      minHeight: 32,
                      minWidth: 34,
                      alignItems: "center",
                      justifyContent: "center",
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: theme.line,
                    }}
                  >
                    <Ionicons name="pause" size={12} color={theme.muted} />
                  </Pressable>
                </View>
              )}
            />
          ) : section.kind === "ungrouped" ? (
            <SectionHeader
              icon="ellipsis-horizontal"
              label="未分组"
              count={section.data.length + section.hidden.length}
            />
          ) : (
            <SectionHeader
              icon={section.key === "pinned" ? "pin" : "list-outline"}
              iconColor={section.key === "pinned" ? theme.accent : theme.faint}
              label={section.label}
              labelColor={section.key === "pinned" ? theme.accent : theme.muted}
              count={section.data.length + section.hidden.length}
            />
          )
        }
        renderSectionFooter={({ section }) => (
          <PreviewMoreRow
            hiddenCount={section.hidden.length}
            expanded={previewOpen.has(section.key)}
            onToggle={() => togglePreview(section.key)}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96, flexGrow: 1 }}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80, gap: 10 }}>
            <Text style={{ color: theme.muted, fontSize: 15 }}>
              {projects.length === 0 ? "还没有项目" : view === "group" ? "还没有分组——点上方「管理」新建" : "这个项目还没有任务"}
            </Text>
            {projects.length === 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="新建项目"
                onPress={() => router.push("/project-new")}
                style={{
                  paddingHorizontal: 18,
                  paddingVertical: 10,
                  borderRadius: radius.md,
                  backgroundColor: theme.accent,
                }}
              >
                <Text style={{ color: theme.accentFg, fontSize: 14, fontWeight: "600" }}>＋ 新建项目</Text>
              </Pressable>
            ) : (
              <Text style={{ color: theme.faint, fontSize: 13 }}>点右下角 ＋ 新建任务</Text>
            )}
          </View>
        }
      />

      {/* Floating action button — new task */}
      {projects.length > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建任务"
          onPress={() => router.push("/new")}
          style={({ pressed }) => ({
            position: "absolute",
            right: 20,
            bottom: insets.bottom + 20,
            width: 56,
            height: 56,
            borderRadius: 28,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.accent,
            opacity: pressed ? 0.85 : 1,
            shadowColor: "#000",
            shadowOpacity: 0.25,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 3 },
            elevation: 5,
          })}
        >
          <Text style={{ color: theme.accentFg, fontSize: 30, fontWeight: "300", marginTop: -3 }}>＋</Text>
        </Pressable>
      )}

      <SideDrawer open={drawerOpen} setOpen={setDrawerOpen} />
    </View>
  );
}

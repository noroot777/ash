import { useState, useMemo, useCallback } from "react";
import { View, Text, Pressable, SectionList, RefreshControl } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Task, TaskStatus } from "@harness/shared";
import { getBaseURL } from "@/lib/config";
import { useStore } from "@/lib/store";
import { refreshAll } from "@/lib/data";
import { STATUSES, STATUS_META } from "@/lib/constants";
import { useTheme, radius, fonts } from "@/lib/theme";
import { TaskTimeChip } from "@/lib/time";
import { PriorityBars } from "@/components/ui";
import { SignalBar } from "@/components/SignalBar";
import { SideDrawer } from "@/components/SideDrawer";
import { Ionicons } from "@expo/vector-icons";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

// 列表 section 的元信息:活跃任务按状态分区,外加底部一个可折叠的「已归档」区。
// (单元三的分组视图会再扩展出 group / ungrouped 两种 kind。)
type SectionMeta =
  | { kind: "status"; key: string }
  | { kind: "archived"; key: "archived"; count: number };

function TaskRow({ task, onPress }: { task: Task; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 13,
        marginHorizontal: 16,
        paddingHorizontal: 14,
        paddingVertical: 14,
        borderRadius: radius.lg,
        backgroundColor: pressed ? theme.raised : theme.panel,
        borderWidth: 1,
        borderColor: theme.line,
      })}
    >
      <SignalBar status={task.status} height={38} />
      <View style={{ flex: 1, gap: 5 }}>
        <Text style={{ color: theme.ink, fontSize: 15, fontFamily: fonts.bodySemi }} numberOfLines={2}>
          {task.title || "(无标题)"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          {task.agentType ? (
            <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>@{task.agentType}</Text>
          ) : null}
          {task.labels.slice(0, 2).map((l) => (
            <Text key={l} style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>
              #{l}
            </Text>
          ))}
          <TaskTimeChip task={task} />
        </View>
      </View>
      <PriorityBars priority={task.priority} />
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
  const [refreshing, setRefreshing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false); // 底部「已归档」区默认折叠
  const currentProject = projects.find((p) => p.id === projectId) ?? null;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } catch {
      /* keep stale data on failure */
    }
    setRefreshing(false);
  }, []);

  const sections = useMemo<(SectionMeta & { data: Task[] })[]>(() => {
    const mine = tasks.filter((t) => t.projectId === projectId && t.mode !== "debate");
    const byPriority = (a: Task, b: Task) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      b.updatedAt.localeCompare(a.updatedAt);
    // 活跃任务按状态分区(排除已归档);归档任务收进底部可折叠的「已归档」区。
    const statusSections = STATUSES.map((s) => ({
      kind: "status" as const,
      key: s.key,
      data: mine.filter((t) => !t.archived && t.status === s.key).sort(byPriority),
    })).filter((s) => s.data.length > 0);
    const archived = mine
      .filter((t) => t.archived)
      .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
    return archived.length
      ? [
          ...statusSections,
          { kind: "archived" as const, key: "archived", count: archived.length, data: archivedOpen ? archived : [] },
        ]
      : statusSections;
  }, [tasks, projectId, archivedOpen]);

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
        <Pressable onPress={() => setDrawerOpen(true)} hitSlop={10}>
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

      <SectionList<Task, SectionMeta>
        sections={sections}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <TaskRow task={item} onPress={() => router.push(`/task/${item.id}`)} />}
        renderSectionHeader={({ section }) =>
          section.kind === "archived" ? (
            <Pressable
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
          ) : (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 16,
                paddingTop: 18,
                paddingBottom: 8,
                backgroundColor: theme.bg,
              }}
            >
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  backgroundColor: STATUS_META[section.key as TaskStatus]?.color,
                }}
              />
              <Text style={{ color: theme.muted, fontSize: 11, fontFamily: fonts.monoMed, letterSpacing: 1 }}>
                {section.key.toUpperCase().replace(/_/g, " ")}
              </Text>
              <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>· {section.data.length}</Text>
            </View>
          )
        }
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 96, flexGrow: 1 }}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80, gap: 10 }}>
            <Text style={{ color: theme.muted, fontSize: 15 }}>
              {projects.length === 0 ? "还没有项目" : "这个项目还没有任务"}
            </Text>
            {projects.length === 0 ? (
              <Pressable
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

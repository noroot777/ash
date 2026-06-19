import { useState, useMemo, useCallback } from "react";
import { View, Text, Pressable, SectionList, RefreshControl } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Task, TaskStatus } from "@harness/shared";
import { getBaseURL } from "@/lib/config";
import { useStore } from "@/lib/store";
import { refreshAll } from "@/lib/data";
import { STATUSES, STATUS_META } from "@/lib/constants";
import { useTheme, radius } from "@/lib/theme";
import { StatusDot, PriorityBars } from "@/components/ui";
import { SideDrawer } from "@/components/SideDrawer";
import { Ionicons } from "@expo/vector-icons";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function TaskRow({ task, onPress }: { task: Task; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginHorizontal: 16,
        paddingHorizontal: 14,
        paddingVertical: 14,
        borderRadius: radius.lg,
        backgroundColor: pressed ? theme.raised : theme.panel,
        borderWidth: 1,
        borderColor: theme.line,
      })}
    >
      <StatusDot status={task.status} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: theme.ink, fontSize: 15, fontWeight: "500" }} numberOfLines={2}>
          {task.title || "(无标题)"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {task.agentType ? <Text style={{ color: theme.faint, fontSize: 12 }}>@{task.agentType}</Text> : null}
          {task.labels.slice(0, 2).map((l) => (
            <Text key={l} style={{ color: theme.faint, fontSize: 12 }}>
              #{l}
            </Text>
          ))}
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

  const sections = useMemo(() => {
    const mine = tasks.filter((t) => t.projectId === projectId && t.mode !== "debate");
    const byStatus = (st: TaskStatus) =>
      mine
        .filter((t) => t.status === st)
        .sort(
          (a, b) =>
            (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
            b.updatedAt.localeCompare(a.updatedAt),
        );
    return STATUSES.map((s) => ({ key: s.key, label: s.label, data: byStatus(s.key) })).filter(
      (s) => s.data.length > 0,
    );
  }, [tasks, projectId]);

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
        <Text style={{ color: theme.ink, fontSize: 26, fontWeight: "700" }}>Tasks</Text>
        {currentProject ? (
          <Text style={{ color: theme.muted, fontSize: 15, fontWeight: "500", flex: 1 }} numberOfLines={1}>
            {currentProject.name}
          </Text>
        ) : (
          <View style={{ flex: 1 }} />
        )}
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => <TaskRow task={item} onPress={() => router.push(`/task/${item.id}`)} />}
        renderSectionHeader={({ section }) => (
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
            <Text style={{ color: theme.muted, fontSize: 12, fontWeight: "600" }}>{section.label}</Text>
            <Text style={{ color: theme.faint, fontSize: 12 }}>{section.data.length}</Text>
          </View>
        )}
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

      <SideDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}

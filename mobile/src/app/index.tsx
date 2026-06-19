import { useState, useMemo, useCallback } from "react";
import { View, Text, Pressable, SectionList, RefreshControl, ScrollView } from "react-native";
import { Redirect, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Task, TaskStatus } from "@harness/shared";
import { getBaseURL } from "@/lib/config";
import { useStore } from "@/lib/store";
import { refreshAll } from "@/lib/data";
import { STATUSES, STATUS_META } from "@/lib/constants";
import { useTheme } from "@/lib/theme";
import { StatusDot, PriorityBars, Pill } from "@/components/ui";

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function TaskRow({ task, onPress }: { task: Task; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 11,
        paddingHorizontal: 16,
        paddingVertical: 13,
        backgroundColor: pressed ? theme.raised : "transparent",
      })}
    >
      <StatusDot status={task.status} />
      <View style={{ flex: 1, gap: 3 }}>
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
  const setProjectId = useStore((s) => s.setProjectId);
  const tasks = useStore((s) => s.tasks);
  const [refreshing, setRefreshing] = useState(false);

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
      {/* Project selector */}
      {projects.length > 0 && (
        <View style={{ borderBottomWidth: 1, borderBottomColor: theme.line }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 10 }}
          >
            {projects.map((p) => (
              <Pill key={p.id} label={p.name} active={p.id === projectId} onPress={() => setProjectId(p.id)} />
            ))}
          </ScrollView>
        </View>
      )}

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
              paddingTop: 16,
              paddingBottom: 6,
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
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: theme.line, marginLeft: 16 }} />}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24, flexGrow: 1 }}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80, gap: 6 }}>
            <Text style={{ color: theme.muted, fontSize: 15 }}>
              {projects.length === 0 ? "还没有项目" : "这个项目还没有任务"}
            </Text>
            <Text style={{ color: theme.faint, fontSize: 13 }}>点右上角 ＋ 新建任务</Text>
          </View>
        }
      />
    </View>
  );
}

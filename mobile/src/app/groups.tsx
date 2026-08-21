import { useState } from "react";
import { View, Text, ScrollView, Pressable, TextInput, Alert } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { Group } from "@ash/shared";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { refreshAll } from "@/lib/data";
import { useTheme, radius, fonts } from "@/lib/theme";
import { Button } from "@/components/ui";

// 分组管理(移植自 web/src/GroupsPanel.tsx):重命名、并行↔串行、看成员数、整组运行/
// 暂停、删除(成员保留,只解绑)。底部内联新建。分组是临时批容器,无归档概念。
export default function GroupsScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const projectId = useStore((s) => s.projectId);
  const groups = useStore((s) => s.groups);
  const tasks = useStore((s) => s.tasks);
  const upsertGroup = useStore((s) => s.upsertGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const [newName, setNewName] = useState("");

  const mine = groups.filter((g) => g.projectId === projectId);
  const count = (id: string) => tasks.filter((t) => t.groupId === id && !t.archived).length;

  const patch = (id: string, p: Partial<Pick<Group, "name" | "mode">>) => {
    const g = mine.find((x) => x.id === id);
    if (g) upsertGroup({ ...g, ...p }); // 乐观
    api.patchGroup(id, p).then(upsertGroup).catch(() => refreshAll().catch(() => {}));
  };
  const run = (id: string) => {
    const g = mine.find((x) => x.id === id);
    if (g) upsertGroup({ ...g, paused: false });
    api.runGroup(id).catch(() => {}).finally(() => refreshAll().catch(() => {}));
  };
  const pause = (id: string) => {
    const g = mine.find((x) => x.id === id);
    if (g) upsertGroup({ ...g, paused: true });
    api.pauseGroup(id).then(upsertGroup).catch(() => refreshAll().catch(() => {}));
  };
  const del = (g: Group) =>
    Alert.alert("删除分组", `确定删除分组「${g.name}」?组内 ${count(g.id)} 个任务不会被删除,只会取消分组。`, [
      { text: "取消", style: "cancel" },
      {
        text: "删除",
        style: "destructive",
        onPress: () => {
          removeGroup(g.id);
          api.deleteGroup(g.id).catch(() => {}).finally(() => refreshAll().catch(() => {}));
        },
      },
    ]);
  const create = async () => {
    const name = newName.trim();
    if (!name || !projectId) return;
    setNewName("");
    try {
      upsertGroup(await api.createGroup({ name, mode: "parallel", projectId }));
    } catch (e) {
      Alert.alert("新建失败", e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: insets.bottom + 24 }}
      keyboardShouldPersistTaps="handled"
    >
      {mine.length === 0 ? (
        <Text style={{ color: theme.faint, fontSize: 13, lineHeight: 20 }}>
          还没有分组。分组用来把同质化的任务打包,按并行或串行整组运行。
        </Text>
      ) : null}

      {mine.map((g) => (
        <GroupRow
          key={g.id}
          group={g}
          count={count(g.id)}
          onPatch={(p) => patch(g.id, p)}
          onRun={() => run(g.id)}
          onPause={() => pause(g.id)}
          onDelete={() => del(g)}
        />
      ))}

      {/* 内联新建 */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={create}
          placeholder="新建分组名…(默认并行)"
          placeholderTextColor={theme.faint}
          style={{
            flex: 1,
            color: theme.ink,
            backgroundColor: theme.raised,
            borderRadius: radius.lg,
            paddingHorizontal: 14,
            paddingVertical: 11,
            fontSize: 15,
            fontFamily: fonts.body,
          }}
        />
        <Button label="新建" onPress={create} disabled={!newName.trim()} />
      </View>
    </ScrollView>
  );
}

function GroupRow({
  group,
  count,
  onPatch,
  onRun,
  onPause,
  onDelete,
}: {
  group: Group;
  count: number;
  onPatch: (p: Partial<Pick<Group, "name" | "mode">>) => void;
  onRun: () => void;
  onPause: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const [name, setName] = useState(group.name);
  const commit = () => {
    const v = name.trim();
    if (v && v !== group.name) onPatch({ name: v });
    else setName(group.name);
  };
  return (
    <View
      style={{
        gap: 10,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: theme.line,
        backgroundColor: theme.panel,
        padding: 12,
      }}
    >
      {/* 行1:图标 + 名称(可改) + 删除 */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons name="layers-outline" size={16} color={theme.faint} />
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={commit}
          onBlur={commit}
          placeholder="分组名"
          placeholderTextColor={theme.faint}
          style={{ flex: 1, color: theme.ink, fontSize: 15, fontFamily: fonts.bodySemi, paddingVertical: 2 }}
        />
        <Pressable onPress={onDelete} hitSlop={8}>
          <Ionicons name="trash-outline" size={18} color={theme.faint} />
        </Pressable>
      </View>

      {/* 行2:模式切换 + 任务数 + 运行/暂停 */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View
          style={{
            flexDirection: "row",
            borderRadius: radius.sm,
            overflow: "hidden",
            borderWidth: 1,
            borderColor: theme.line,
          }}
        >
          {(["parallel", "serial"] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => group.mode !== m && onPatch({ mode: m })}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                backgroundColor: group.mode === m ? theme.accent : "transparent",
              }}
            >
              <Text
                style={{ color: group.mode === m ? theme.accentFg : theme.muted, fontSize: 12, fontFamily: fonts.mono }}
              >
                {m === "parallel" ? "并行" : "串行"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>{count} 个任务</Text>
        <View style={{ flex: 1 }} />
        {group.paused ? (
          <RunBtn label="继续" onPress={onRun} />
        ) : (
          <>
            <RunBtn label="运行" onPress={onRun} />
            <Pressable
              onPress={onPause}
              hitSlop={6}
              style={{
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: theme.line,
              }}
            >
              <Ionicons name="pause" size={13} color={theme.muted} />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

function RunBtn({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: radius.md,
        backgroundColor: theme.accent,
      }}
    >
      <Ionicons name="play" size={13} color={theme.accentFg} />
      <Text style={{ color: theme.accentFg, fontSize: 12, fontFamily: fonts.bodySemi }}>{label}</Text>
    </Pressable>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { canArchive, normalizeDuetConfig, type Task } from "@harness/shared";
import {
  api,
  type DuetTranscriptEntry,
  type DuetTranscriptGate,
  type DuetTranscriptTurn,
} from "@/lib/api";
import { refreshAll } from "@/lib/data";
import { STATUS_META } from "@/lib/constants";
import { formatInstant, TaskTimeChip } from "@/lib/time";
import { fonts, radius, useTheme, type Theme } from "@/lib/theme";
import { MarkdownText } from "@/components/MarkdownText";
import { PriorityBars } from "@/components/ui";
import { SignalBar } from "@/components/SignalBar";

const DUET_COLOR = "#8B5CF6";
const TRANSCRIPT_POLL_MS = 3000;

export function DuetTaskDetail({
  task,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  task: Task;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const cfg = normalizeDuetConfig(task.duet);
  const meta = STATUS_META[task.status];
  const [entries, setEntries] = useState<DuetTranscriptEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const stickToBottomRef = useRef(true);

  const loadTranscript = useCallback(async () => {
    setEntries(await api.duetTranscript(task.id));
  }, [task.id]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const pull = () => loadTranscript().catch(() => {});
    pull();
    if (task.status === "running" || task.status === "queued") {
      timer = setInterval(pull, TRANSCRIPT_POLL_MS);
    }
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") pull();
    });
    return () => {
      if (timer) clearInterval(timer);
      sub.remove();
    };
  }, [loadTranscript, task.status]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadTranscript().catch(() => {}), refreshAll().catch(() => {})]);
    setRefreshing(false);
  }, [loadTranscript]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    stickToBottomRef.current = contentSize.height - layoutMeasurement.height - contentOffset.y < 80;
  }, []);

  const conclusions = useMemo(() => {
    const turns = entries.filter(isTurn);
    return {
      a: [...turns].reverse().find((entry) => entry.speaker === "A")?.conclusion,
      b: [...turns].reverse().find((entry) => entry.speaker === "B")?.conclusion,
    };
  }, [entries]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen
        options={{
          title: "",
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 18 }}>
              {task.archived ? (
                <Pressable onPress={onUnarchive} hitSlop={10}>
                  <Ionicons name="archive" size={20} color={theme.accent} />
                </Pressable>
              ) : canArchive(task.status) ? (
                <Pressable onPress={onArchive} hitSlop={10}>
                  <Ionicons name="archive-outline" size={20} color={theme.muted} />
                </Pressable>
              ) : null}
              <Pressable onPress={onDelete} hitSlop={10}>
                <Text style={{ color: theme.danger, fontSize: 17 }}>🗑</Text>
              </Pressable>
            </View>
          ),
        }}
      />

      <View
        style={{
          flexDirection: "row",
          paddingHorizontal: 16,
          paddingTop: 12,
          paddingBottom: 14,
          borderBottomWidth: 1,
          borderBottomColor: theme.line,
          gap: 13,
        }}
      >
        <SignalBar status={task.status} height={58} />
        <View style={{ flex: 1, gap: 9 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <DuetBadge />
            <Text style={{ color: meta?.color, fontSize: 11, fontFamily: fonts.monoMed, letterSpacing: 1 }}>
              {task.status.toUpperCase().replace(/_/g, " ")}
            </Text>
            {task.archived ? <Text style={{ color: theme.faint, fontSize: 11 }}>· 已归档</Text> : null}
          </View>
          <Text style={{ color: theme.ink, fontSize: 21, fontFamily: fonts.display, lineHeight: 27 }} numberOfLines={2}>
            {task.title || "(无标题)"}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>
              A @{cfg.voiceA} ↔ B @{cfg.voiceB}
            </Text>
            <PriorityBars priority={task.priority} />
            <TaskTimeChip task={task} />
          </View>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 28 }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={() => {
          if (stickToBottomRef.current) scrollRef.current?.scrollToEnd({ animated: true });
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.muted} />}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 8,
            borderRadius: radius.md,
            backgroundColor: `${DUET_COLOR}12`,
            borderWidth: 1,
            borderColor: `${DUET_COLOR}40`,
            padding: 11,
          }}
        >
          <Ionicons name="eye-outline" size={16} color={DUET_COLOR} />
          <Text style={{ flex: 1, color: theme.muted, fontSize: 12, lineHeight: 18 }}>
            手机端为只读讨论记录。运行、停止、重试和收敛门裁决请在网页端操作；这里会自动刷新发言与状态。
          </Text>
        </View>

        {task.body || cfg.topic ? (
          <View
            style={{
              backgroundColor: theme.panel,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: theme.line,
              padding: 12,
              gap: 7,
            }}
          >
            <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.monoMed }}>讨论议题</Text>
            <MarkdownText value={task.body || cfg.topic} style={{ color: theme.muted, fontSize: 14, lineHeight: 20 }} />
          </View>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <Text style={{ color: theme.ink, fontSize: 13, fontFamily: fonts.bodySemi }}>讨论记录</Text>
          <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>
            {cfg.maxRounds == null ? "轮数不设限" : `最多 ${cfg.maxRounds} 轮`} · 收敛门{cfg.gateG1 === "on" ? "开启" : "关闭"}
          </Text>
        </View>

        {entries.map((entry, index) =>
          isGate(entry) ? (
            <GateEntry key={`${index}-${entry.gate}-${entry.open ? "open" : "close"}`} entry={entry} theme={theme} />
          ) : (
            <TurnEntry key={`${index}-${entry.round}-${entry.speaker}`} entry={entry} cfg={cfg} theme={theme} />
          ),
        )}

        {entries.length === 0 ? (
          <Text style={{ color: theme.faint, fontSize: 13, textAlign: "center", paddingVertical: 24 }}>
            {task.status === "running" || task.status === "queued"
              ? "讨论正在开始，首轮记录写入后会显示在这里…"
              : "还没有持久化的讨论记录"}
          </Text>
        ) : null}

        {task.status === "done" && (conclusions.a || conclusions.b) ? (
          <View
            style={{
              backgroundColor: `${theme.ok}10`,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: `${theme.ok}40`,
              padding: 12,
              gap: 8,
            }}
          >
            <Text style={{ color: theme.ok, fontSize: 12, fontFamily: fonts.bodySemi }}>讨论结论</Text>
            {conclusions.a ? <ConclusionLine label="A" value={conclusions.a} color={theme.accent} theme={theme} /> : null}
            {conclusions.b ? <ConclusionLine label="B" value={conclusions.b} color={DUET_COLOR} theme={theme} /> : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function DuetBadge() {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: radius.pill,
        backgroundColor: `${DUET_COLOR}20`,
      }}
    >
      <Ionicons name="chatbubbles-outline" size={12} color={DUET_COLOR} />
      <Text style={{ color: DUET_COLOR, fontSize: 10, fontFamily: fonts.monoMed }}>讨论</Text>
    </View>
  );
}

function TurnEntry({
  entry,
  cfg,
  theme,
}: {
  entry: DuetTranscriptTurn;
  cfg: ReturnType<typeof normalizeDuetConfig>;
  theme: Theme;
}) {
  if (entry.speaker === "user") {
    const target = entry.target ? ` → 讨论者${entry.target}` : " → 双方";
    return (
      <View style={{ alignSelf: "flex-end", width: "90%", gap: 4 }}>
        <Text style={{ color: theme.faint, fontSize: 11, textAlign: "right", fontFamily: fonts.mono }}>
          你{target} · 第 {entry.round} 轮{entry.at ? ` · ${formatInstant(entry.at)}` : ""}
        </Text>
        <View
          style={{
            backgroundColor: theme.raised,
            borderRadius: radius.lg,
            borderBottomRightRadius: 4,
            borderWidth: 1,
            borderColor: theme.line,
            paddingHorizontal: 12,
            paddingVertical: 9,
          }}
        >
          <MarkdownText value={entry.text} style={{ color: theme.ink, fontSize: 14, lineHeight: 21 }} />
        </View>
      </View>
    );
  }

  const side = entry.speaker === "B" ? "B" : entry.speaker === "A" ? "A" : entry.speaker;
  const color = side === "B" ? DUET_COLOR : theme.accent;
  const agent = side === "A" ? cfg.voiceA : side === "B" ? cfg.voiceB : undefined;
  const label = side === "impl" ? "执行者（历史）" : side === "review" ? "审阅者（历史）" : side === "synthesis" ? "共同方案" : `讨论者 ${side}`;
  return (
    <View
      style={{
        alignSelf: "stretch",
        backgroundColor: theme.panel,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: theme.line,
        borderLeftWidth: 3,
        borderLeftColor: color,
        paddingHorizontal: 12,
        paddingVertical: 10,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
        <Text style={{ color, fontSize: 12, fontFamily: fonts.bodySemi }}>{label}</Text>
        {agent ? <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>@{agent}</Text> : null}
        <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>· 第 {entry.round} 轮</Text>
      </View>
      {entry.text ? (
        <MarkdownText value={entry.text} selectable style={{ color: theme.ink, fontSize: 14, lineHeight: 21 }} />
      ) : null}
      {entry.error ? (
        <View style={{ borderRadius: radius.sm, backgroundColor: `${theme.danger}10`, padding: 8 }}>
          <Text selectable style={{ color: theme.danger, fontSize: 12, lineHeight: 18 }}>{entry.error}</Text>
        </View>
      ) : null}
      {entry.raised || entry.conclusion ? (
        <View style={{ gap: 5, paddingTop: 2 }}>
          {entry.raised ? (
            <Text style={{ color: entry.agrees ? theme.ok : theme.muted, fontSize: 11, fontFamily: fonts.monoMed }}>
              {entry.agrees ? "已举手 · 与对方一致" : "已举手 · 仍有分歧"}
            </Text>
          ) : null}
          {entry.conclusion ? <ConclusionLine label={String(side)} value={entry.conclusion} color={color} theme={theme} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function GateEntry({ entry, theme }: { entry: DuetTranscriptGate; theme: Theme }) {
  const verdict = entry.consensus === true ? " · 已达成共识" : entry.consensus === false ? " · 分歧待裁决" : "";
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 12, height: 1, backgroundColor: theme.line }} />
        <View style={{ flexShrink: 1, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 5 }}>
          <Ionicons name={entry.open ? "pause-circle-outline" : "checkmark-circle-outline"} size={13} color={DUET_COLOR} />
          <Text style={{ flexShrink: 1, color: theme.faint, fontSize: 11, textAlign: "center" }}>
            {entry.open ? `收敛门等待裁决${verdict}` : "收敛门已关闭"}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: 12, height: 1, backgroundColor: theme.line }} />
      </View>
      {entry.open && (entry.conclusionA || entry.conclusionB) ? (
        <View style={{ backgroundColor: theme.raised, borderRadius: radius.md, padding: 10, gap: 6 }}>
          {entry.conclusionA ? <ConclusionLine label="A" value={entry.conclusionA} color={theme.accent} theme={theme} /> : null}
          {entry.conclusionB ? <ConclusionLine label="B" value={entry.conclusionB} color={DUET_COLOR} theme={theme} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function ConclusionLine({ label, value, color, theme }: { label: string; value: string; color: string; theme: Theme }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 7 }}>
      <Text style={{ color, fontSize: 11, fontFamily: fonts.monoMed }}>结论 {label}</Text>
      <Text selectable style={{ flex: 1, color: theme.muted, fontSize: 12, lineHeight: 18 }}>{value}</Text>
    </View>
  );
}

function isGate(entry: DuetTranscriptEntry): entry is DuetTranscriptGate {
  return entry.type === "duet.gate";
}

function isTurn(entry: DuetTranscriptEntry): entry is DuetTranscriptTurn {
  return !isGate(entry);
}

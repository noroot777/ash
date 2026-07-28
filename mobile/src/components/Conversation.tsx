// Renders a task's streamed output as a conversation, the way web/src/TaskDetail
// does: consecutive streamed text from the same run is merged into one markdown
// bubble; thinking / tool / error / done / user / system get their own
// treatment. Input is the flat LogLine[] accumulated from agent.events.
//
// Time: the .md carries no per-line timestamp for agent prose (shared ConvSeg's
// agent segment has no `at`), so per-turn 开始时刻·用时 is reconstructed from the
// surrounding 你→/〔系统〕 markers (their `at`) + the Session's startedAt/endedAt.
// Every agent bubble carries ITS OWN time — a resumed session prints one 用时 per
// turn, never repeating the whole-session span. Mirrors web's buildConversation.
import { Fragment, useRef, useState, type ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@harness/shared";
import { mergeFeed } from "@harness/shared/team";
import type { LogLine } from "@/lib/log";
import { useTheme, radius, fonts, type Theme } from "@/lib/theme";
import { formatInstant, Duration } from "@/lib/time";
import { SelectableText } from "./SelectableText";
import { MarkdownText } from "./MarkdownText";
import { SelectSheet } from "./SelectSheet";

type Block =
  | { kind: "agentText"; text: string; agent?: string; sessionId?: string; endedAt?: string; key: string }
  | { kind: "thinking"; text: string; agent?: string; sessionId?: string; key: string }
  | { kind: "tool"; name: string; detail: string; agent?: string; sessionId?: string; key: string }
  | { kind: "error"; text: string; agent?: string; sessionId?: string; key: string }
  | { kind: "done"; text: string; at?: string; key: string }
  | { kind: "user"; text: string; at?: string; key: string }
  | { kind: "system"; text: string; at?: string; key: string };

type Timing = { time: string | null; endedAt: string | null };

export type ConversationInsertion = {
  key: string;
  at?: string | null;
  content: ReactNode;
};

// Flatten LogLines into render blocks, concatenating runs of streamed text.
function toBlocks(lines: LogLine[]): Block[] {
  const out: Block[] = [];
  let buf: { text: string; agent?: string; sessionId?: string; endedAt?: string; key: string } | null = null;
  const flush = () => {
    if (buf && buf.text.trim()) out.push({ kind: "agentText", ...buf });
    buf = null;
  };
  lines.forEach((l, i) => {
    const key = `${l.sessionId ?? "s"}-${i}`;
    if (l.kind === "text") {
      // Same run AND same agent merges; a different session starts a fresh bubble
      // (keeps each run's sessionId intact so its time tags the right bubble). The
      // turn's exec end (endedAt, set on the last seg) rides the merged bubble.
      if (buf && buf.agent === l.agent && buf.sessionId === l.sessionId) {
        buf.text += l.text;
        if (l.endedAt) buf.endedAt = l.endedAt;
      } else {
        flush();
        buf = { text: l.text, agent: l.agent, sessionId: l.sessionId, endedAt: l.endedAt, key };
      }
      return;
    }
    flush();
    if (l.kind === "thinking") out.push({ kind: "thinking", text: l.text, agent: l.agent, sessionId: l.sessionId, key });
    else if (l.kind === "tool") out.push({ kind: "tool", name: l.name ?? "tool", detail: l.text, agent: l.agent, sessionId: l.sessionId, key });
    else if (l.kind === "error") out.push({ kind: "error", text: l.text, agent: l.agent, sessionId: l.sessionId, key });
    else if (l.kind === "done") out.push({ kind: "done", text: l.text, at: l.at, key });
    else if (l.kind === "user") out.push({ kind: "user", text: l.text, at: l.at, key });
    else if (l.kind === "system") out.push({ kind: "system", text: l.text, at: l.at, key });
  });
  flush();
  return out;
}

export function Conversation({
  lines,
  sessions = [],
  taskEndedAt,
  insertions = [],
}: {
  lines: LogLine[];
  sessions?: Session[];
  taskEndedAt?: string | null;
  insertions?: ConversationInsertion[];
}) {
  const theme = useTheme();
  const blocks = toBlocks(lines);
  const [selText, setSelText] = useState<string | null>(null);
  // Tail fallback for a run's LAST turn when nothing follows it in-stream: the
  // session's own endedAt, else the next run's start, else the task's endedAt.
  // Never "now", so finished historical views don't tick.
  const byStart = [...sessions].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const runEnd = new Map<string, string | null>(
    byStart.map((s, i) => [s.id, s.endedAt ?? byStart[i + 1]?.startedAt ?? taskEndedAt ?? null]),
  );
  const startOf = new Map(sessions.map((s) => [s.id, s.startedAt] as const));

  // Per-turn timing. A resumed session shows as several agent bubbles; each must
  // carry ITS OWN 用时 (not the whole session's span). Two ordered passes:
  //   ① forward — time = session.startedAt for the run's FIRST agent bubble,
  //     else the preceding 你→/〔系统〕 marker's `at`.
  //   ② reverse — endedAt = the next 你→/〔系统〕 marker's `at` within the same
  //     run; a sessionId change resets the bracket so one run's clock never
  //     bleeds into the next. Falls back to runEnd for the tail bubble.
  // Mirrors web/src/TaskDetail.tsx buildConversation.
  const timings = new Map<string, Timing>();
  const seen = new Set<string>();
  let prevAt: string | null = null;
  for (const b of blocks) {
    if (b.kind === "user" || b.kind === "system") {
      if (b.at) prevAt = b.at;
      continue;
    }
    if (b.kind !== "agentText") continue;
    const sid = b.sessionId;
    const firstOfRun = !sid || !seen.has(sid);
    if (sid) seen.add(sid);
    const sessStart = sid ? startOf.get(sid) ?? null : null;
    const time = firstOfRun ? sessStart : prevAt ?? sessStart;
    timings.set(b.key, { time, endedAt: null });
  }
  let nextAt: string | null = null;
  let rightRun: string | undefined;
  let rightRunSet = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "user" || b.kind === "system" || b.kind === "done") {
      const at = (b as { at?: string }).at;
      if (at) nextAt = at;
      continue;
    }
    if (b.kind !== "agentText") continue;
    if (!rightRunSet || b.sessionId !== rightRun) {
      nextAt = null;
      rightRun = b.sessionId;
      rightRunSet = true;
    }
    const t = timings.get(b.key);
    // Prefer the agentEnd marker (real exec end, idle excluded); fall back to the
    // wall-clock estimate (next marker / runEnd) for historical turns without it.
    if (t) t.endedAt = b.endedAt ?? nextAt ?? (b.sessionId ? runEnd.get(b.sessionId) ?? null : null);
  }

  // Feed boundaries attach a turn's start to its first visual block and its end
  // to its last one. This prevents a dispatch card from landing between an agent
  // bubble and a tool/thinking row that belongs to the same turn.
  const feedBounds = conversationFeedBounds(blocks, timings);
  const rows = mergeFeed(blocks, insertions, {
    itemStartTime: (block) => feedBounds.get(block.key)?.time,
    itemEndTime: (block) => feedBounds.get(block.key)?.endedAt,
    batchTime: (insertion) => insertion.at,
    itemKey: (block) => block.key,
    batchKey: (insertion) => insertion.key,
  });

  return (
    <>
      <View style={{ gap: 10 }}>
        {rows.map((row) => (
          <Fragment key={row.key}>
            {row.kind === "batch"
              ? row.batch.content
              : renderBlock(
                  row.item,
                  theme,
                  row.item.kind === "agentText" ? timings.get(row.item.key) : undefined,
                  setSelText,
                )}
          </Fragment>
        ))}
      </View>
      {selText != null && <SelectSheet text={selText} onClose={() => setSelText(null)} />}
    </>
  );
}

function conversationFeedBounds(blocks: Block[], timings: Map<string, Timing>): Map<string, Timing> {
  const bounds = new Map<string, Timing>();
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    if (block.kind === "user" || block.kind === "system" || block.kind === "done") {
      const at = block.at ?? null;
      bounds.set(block.key, { time: at, endedAt: at });
      index += 1;
      continue;
    }

    const groupKey = block.sessionId ? `session:${block.sessionId}` : `agent:${block.agent ?? ""}`;
    let end = index + 1;
    while (end < blocks.length) {
      const next = blocks[end]!;
      if (next.kind === "user" || next.kind === "system" || next.kind === "done") break;
      const nextGroupKey = next.sessionId ? `session:${next.sessionId}` : `agent:${next.agent ?? ""}`;
      if (nextGroupKey !== groupKey) break;
      end += 1;
    }

    const groupTimings = blocks
      .slice(index, end)
      .flatMap((item) => item.kind === "agentText" ? [timings.get(item.key)] : [])
      .filter((timing): timing is Timing => !!timing);
    const time = groupTimings[0]?.time ?? null;
    const endedAt = groupTimings.reduce<string | null>(
      (latest, timing) => timing.endedAt ?? timing.time ?? latest,
      null,
    );
    const first = blocks[index]!;
    const last = blocks[end - 1]!;
    bounds.set(first.key, { time, endedAt: first.key === last.key ? endedAt : null });
    if (first.key !== last.key) bounds.set(last.key, { time: null, endedAt });
    index = end;
  }
  return bounds;
}

const bubbleStyle = (theme: Theme) => ({
  backgroundColor: theme.panel,
  borderWidth: 1,
  borderColor: theme.line,
  borderRadius: radius.lg,
  borderTopLeftRadius: 4,
  paddingHorizontal: 12,
  paddingVertical: 8,
  alignSelf: "flex-start" as const,
  maxWidth: "100%" as const,
});

// One agent text bubble: renders markdown (non-selectable — iOS UILabel gives no
// drag handles anyway), and a double-tap OR long-press opens the raw text in a
// full-screen SelectSheet whose UITextView-backed TextInput DOES give handles.
// Pretty in the thread, freely selectable on demand. Mirrors the WeChat pattern.
function AgentBubble({
  b,
  theme,
  timing,
  onSelect,
}: {
  b: Extract<Block, { kind: "agentText" }>;
  theme: Theme;
  timing?: Timing;
  onSelect?: (t: string) => void;
}) {
  const lastTap = useRef(0);
  const metaText = { color: theme.faint, fontSize: 11, fontFamily: fonts.mono } as const;
  const onTap = () => {
    const n = Date.now();
    if (n - lastTap.current < 300) onSelect?.(b.text);
    lastTap.current = n;
  };
  return (
    <View>
      {b.agent || timing?.time ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 3, marginLeft: 2 }}>
          {b.agent ? <Text style={metaText}>@{b.agent}</Text> : null}
          {timing?.time ? (
            <>
              <Text style={{ color: theme.faint, fontSize: 11 }}>·</Text>
              <Text style={metaText}>{formatInstant(timing.time)}</Text>
              <Text style={{ color: theme.faint, fontSize: 11 }}>·</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Ionicons name="time-outline" size={11} color={theme.faint} />
                <Duration from={timing.time} to={timing.endedAt} style={metaText} />
                <Text style={metaText}> 用时</Text>
              </View>
            </>
          ) : null}
        </View>
      ) : null}
      <Pressable onPress={onTap} onLongPress={() => onSelect?.(b.text)} delayLongPress={350} style={bubbleStyle(theme)}>
        <MarkdownText value={b.text} selectable={false} style={{ color: theme.ink, fontSize: 14, lineHeight: 21 }} />
      </Pressable>
    </View>
  );
}

function renderBlock(b: Block, theme: Theme, timing?: Timing, onSelect?: (t: string) => void) {
  const agentBubble = bubbleStyle(theme);
  const metaText = { color: theme.faint, fontSize: 11, fontFamily: fonts.mono } as const;
  switch (b.kind) {
    case "agentText":
      return <AgentBubble b={b} theme={theme} timing={timing} onSelect={onSelect} />;
    case "thinking":
      return (
        <View style={[agentBubble, { backgroundColor: "transparent", borderColor: theme.line }]}>
          <Text style={{ color: theme.faint, fontSize: 11, marginBottom: 3 }}>思考</Text>
          <SelectableText value={b.text} style={{ color: theme.muted, fontSize: 13, fontStyle: "italic", lineHeight: 19 }} />
        </View>
      );
    case "tool":
      return (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            alignSelf: "flex-start",
            maxWidth: "100%",
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: radius.sm,
            backgroundColor: theme.overlay,
            borderWidth: 1,
            borderColor: theme.line,
          }}
        >
          <Text style={{ flexShrink: 1, color: theme.accent, fontSize: 12, fontWeight: "600", fontFamily: "ui-monospace" }}>
            {b.name}
          </Text>
          {b.detail ? (
            <Text style={{ flexShrink: 1, color: theme.muted, fontSize: 12 }} numberOfLines={1}>
              {b.detail}
            </Text>
          ) : null}
        </View>
      );
    case "error":
      return (
        <View style={[agentBubble, { borderColor: theme.danger, backgroundColor: "transparent" }]}>
          <SelectableText value={b.text} style={{ color: theme.danger, fontSize: 13, lineHeight: 19 }} />
        </View>
      );
    case "done":
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 }}>
          <View style={{ flex: 1, minWidth: 12, height: 1, backgroundColor: theme.line }} />
          <Text style={{ flexShrink: 1, color: theme.faint, fontSize: 11, textAlign: "center" }}>{b.text}</Text>
          <View style={{ flex: 1, minWidth: 12, height: 1, backgroundColor: theme.line }} />
        </View>
      );
    case "user":
      return (
        <View style={{ alignSelf: "flex-end", maxWidth: "88%", gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 2 }}>
            <Text style={{ color: theme.ink, fontSize: 11, fontWeight: "600" }}>你</Text>
            {b.at ? (
              <>
                <Text style={{ color: theme.faint, fontSize: 11 }}>·</Text>
                <Text style={metaText}>{formatInstant(b.at)}</Text>
              </>
            ) : null}
          </View>
          <View
            style={{
              backgroundColor: theme.accent,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: radius.lg,
              borderBottomRightRadius: 4,
            }}
          >
            <SelectableText value={b.text} style={{ color: theme.accentFg, fontSize: 14, lineHeight: 20 }} />
          </View>
        </View>
      );
    case "system":
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 2 }}>
          <View style={{ flex: 1, minWidth: 12, height: 1, backgroundColor: theme.line }} />
          <View
            style={{
              flexShrink: 1,
              maxWidth: "100%",
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <Ionicons name="refresh" size={11} color={theme.faint} />
            <Text
              style={{
                flexShrink: 1,
                minWidth: 0,
                color: theme.faint,
                fontSize: 12,
                fontStyle: "italic",
                textAlign: "center",
              }}
            >
              {b.text}
            </Text>
            {b.at ? <Text style={metaText}>· {formatInstant(b.at)}</Text> : null}
          </View>
          <View style={{ flex: 1, minWidth: 12, height: 1, backgroundColor: theme.line }} />
        </View>
      );
  }
}

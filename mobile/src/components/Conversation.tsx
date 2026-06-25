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
import { Fragment } from "react";
import { View, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Session } from "@harness/shared";
import type { LogLine } from "@/lib/log";
import { useTheme, radius, fonts, type Theme } from "@/lib/theme";
import { formatInstant, Duration } from "@/lib/time";
import { SelectableText } from "./SelectableText";

type Block =
  | { kind: "agentText"; text: string; agent?: string; sessionId?: string; endedAt?: string; key: string }
  | { kind: "thinking"; text: string; key: string }
  | { kind: "tool"; name: string; detail: string; key: string }
  | { kind: "error"; text: string; key: string }
  | { kind: "done"; text: string; key: string }
  | { kind: "user"; text: string; at?: string; key: string }
  | { kind: "system"; text: string; at?: string; key: string };

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
    if (l.kind === "thinking") out.push({ kind: "thinking", text: l.text, key });
    else if (l.kind === "tool") out.push({ kind: "tool", name: l.name ?? "tool", detail: l.text, key });
    else if (l.kind === "error") out.push({ kind: "error", text: l.text, key });
    else if (l.kind === "done") out.push({ kind: "done", text: l.text, key });
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
}: {
  lines: LogLine[];
  sessions?: Session[];
  taskEndedAt?: string | null;
}) {
  const theme = useTheme();
  const blocks = toBlocks(lines);
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
  const timings = new Map<string, { time: string | null; endedAt: string | null }>();
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

  return (
    <View style={{ gap: 10 }}>
      {blocks.map((b) => (
        <Fragment key={b.key}>
          {renderBlock(b, theme, b.kind === "agentText" ? timings.get(b.key) : undefined)}
        </Fragment>
      ))}
    </View>
  );
}

function renderBlock(b: Block, theme: Theme, timing?: { time: string | null; endedAt: string | null }) {
  const agentBubble = {
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: radius.lg,
    borderTopLeftRadius: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignSelf: "flex-start" as const,
    maxWidth: "100%" as const,
  };
  const metaText = { color: theme.faint, fontSize: 11, fontFamily: fonts.mono } as const;
  switch (b.kind) {
    case "agentText":
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
          <View style={agentBubble}>
            <SelectableText value={b.text} style={{ color: theme.ink, fontSize: 14, lineHeight: 21 }} />
          </View>
        </View>
      );
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
            paddingHorizontal: 9,
            paddingVertical: 5,
            borderRadius: radius.sm,
            backgroundColor: theme.overlay,
            borderWidth: 1,
            borderColor: theme.line,
          }}
        >
          <Text style={{ color: theme.accent, fontSize: 12, fontWeight: "600", fontFamily: "ui-monospace" }}>
            {b.name}
          </Text>
          {b.detail ? (
            <Text style={{ color: theme.muted, fontSize: 12 }} numberOfLines={1}>
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
          <View style={{ flex: 1, height: 1, backgroundColor: theme.line }} />
          <Text style={{ color: theme.faint, fontSize: 11 }}>{b.text}</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: theme.line }} />
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
          <View style={{ flex: 1, height: 1, backgroundColor: theme.line }} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Ionicons name="refresh" size={11} color={theme.faint} />
            <Text style={{ color: theme.faint, fontSize: 12, fontStyle: "italic" }}>{b.text}</Text>
            {b.at ? <Text style={metaText}>· {formatInstant(b.at)}</Text> : null}
          </View>
          <View style={{ flex: 1, height: 1, backgroundColor: theme.line }} />
        </View>
      );
  }
}

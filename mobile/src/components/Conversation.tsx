// Renders a task's streamed output as a conversation, the way web/src/TaskDetail
// does: consecutive streamed text from the same run is merged into one markdown
// bubble; thinking / tool / error / done / user / system get their own
// treatment. Input is the flat LogLine[] accumulated from agent.events.
import { Fragment } from "react";
import { View, Text } from "react-native";
import type { LogLine } from "@/lib/log";
import { useTheme, radius, type Theme } from "@/lib/theme";
import { Markdown } from "./Markdown";

type Block =
  | { kind: "agentText"; text: string; agent?: string; key: string }
  | { kind: "thinking"; text: string; key: string }
  | { kind: "tool"; name: string; detail: string; key: string }
  | { kind: "error"; text: string; key: string }
  | { kind: "done"; text: string; key: string }
  | { kind: "user"; text: string; at?: string; key: string }
  | { kind: "system"; text: string; key: string };

// Flatten LogLines into render blocks, concatenating runs of streamed text.
function toBlocks(lines: LogLine[]): Block[] {
  const out: Block[] = [];
  let buf: { text: string; agent?: string; key: string } | null = null;
  const flush = () => {
    if (buf && buf.text.trim()) out.push({ kind: "agentText", ...buf });
    buf = null;
  };
  lines.forEach((l, i) => {
    const key = `${l.sessionId ?? "s"}-${i}`;
    if (l.kind === "text") {
      if (buf && buf.agent === l.agent) buf.text += l.text;
      else {
        flush();
        buf = { text: l.text, agent: l.agent, key };
      }
      return;
    }
    flush();
    if (l.kind === "thinking") out.push({ kind: "thinking", text: l.text, key });
    else if (l.kind === "tool") out.push({ kind: "tool", name: l.name ?? "tool", detail: l.text, key });
    else if (l.kind === "error") out.push({ kind: "error", text: l.text, key });
    else if (l.kind === "done") out.push({ kind: "done", text: l.text, key });
    else if (l.kind === "user") out.push({ kind: "user", text: l.text, at: l.at, key });
    else if (l.kind === "system") out.push({ kind: "system", text: l.text, key });
  });
  flush();
  return out;
}

export function Conversation({ lines }: { lines: LogLine[] }) {
  const theme = useTheme();
  const blocks = toBlocks(lines);
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((b) => (
        <Fragment key={b.key}>{renderBlock(b, theme)}</Fragment>
      ))}
    </View>
  );
}

function renderBlock(b: Block, theme: Theme) {
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
  const labelStyle = { color: theme.faint, fontSize: 11, marginBottom: 3, marginLeft: 2 } as const;
  switch (b.kind) {
    case "agentText":
      return (
        <View>
          {b.agent ? <Text style={labelStyle}>@{b.agent}</Text> : null}
          <View style={agentBubble}>
            <Markdown text={b.text} />
          </View>
        </View>
      );
    case "thinking":
      return (
        <View style={[agentBubble, { backgroundColor: "transparent", borderColor: theme.line }]}>
          <Text style={{ color: theme.faint, fontSize: 11, marginBottom: 3 }}>思考</Text>
          <Text style={{ color: theme.muted, fontSize: 13, fontStyle: "italic", lineHeight: 19 }}>{b.text}</Text>
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
          <Text style={{ color: theme.danger, fontSize: 13, lineHeight: 19 }}>{b.text}</Text>
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
                <Text style={{ color: theme.faint, fontSize: 11 }}>
                  {new Date(b.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </Text>
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
            <Text style={{ color: theme.accentFg, fontSize: 14, lineHeight: 20 }}>{b.text}</Text>
          </View>
        </View>
      );
    case "system":
      return (
        <Text style={{ color: theme.faint, fontSize: 12, textAlign: "center", fontStyle: "italic" }}>〔系统〕{b.text}</Text>
      );
  }
}

// Minimal markdown renderer for agent output. Deliberately dependency-free (no
// react-native-markdown-display, which lags new RN versions) — agent text is
// mostly paragraphs, fenced code, inline code and bold, which is all we handle.
import { Fragment, type ReactNode } from "react";
import { View, Text } from "react-native";
import { useTheme } from "@/lib/theme";

const mono = "ui-monospace";

// Inline: **bold** and `code` inside a single line of text.
function Inline({ text, color }: { text: string; color: string }) {
  const theme = useTheme();
  const parts: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Text key={i++}>{text.slice(last, m.index)}</Text>);
    if (m[2] != null) parts.push(<Text key={i++} style={{ fontWeight: "700" }}>{m[2]}</Text>);
    else if (m[3] != null)
      parts.push(
        <Text key={i++} style={{ fontFamily: mono, backgroundColor: theme.overlay, color: theme.ink }}>
          {" "}{m[3]}{" "}
        </Text>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Text key={i++}>{text.slice(last)}</Text>);
  return <Text style={{ color, fontSize: 14, lineHeight: 21 }}>{parts}</Text>;
}

function CodeBlock({ code }: { code: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.bg,
        borderColor: theme.line,
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        marginVertical: 6,
      }}
    >
      <Text style={{ fontFamily: mono, fontSize: 12.5, color: theme.ink, lineHeight: 18 }}>{code.replace(/\n$/, "")}</Text>
    </View>
  );
}

function TextBlock({ text, color }: { text: string; color: string }) {
  const theme = useTheme();
  const lines = text.replace(/\n+$/, "").split("\n");
  return (
    <View>
      {lines.map((line, idx) => {
        if (!line.trim()) return <View key={idx} style={{ height: 6 }} />;
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
          const size = 19 - (h[1].length - 1) * 1.5;
          return (
            <Text key={idx} style={{ color: theme.ink, fontSize: size, fontWeight: "700", marginVertical: 3 }}>
              {h[2]}
            </Text>
          );
        }
        const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
        if (bullet) {
          return (
            <View key={idx} style={{ flexDirection: "row", paddingLeft: bullet[1].length * 6 }}>
              <Text style={{ color, fontSize: 14, lineHeight: 21 }}>{"•  "}</Text>
              <View style={{ flex: 1 }}>
                <Inline text={bullet[2]} color={color} />
              </View>
            </View>
          );
        }
        return <Inline key={idx} text={line} color={color} />;
      })}
    </View>
  );
}

export function Markdown({ text, color }: { text: string; color?: string }) {
  const theme = useTheme();
  const c = color ?? theme.ink;
  const segments: { code: boolean; body: string }[] = [];
  const re = /```[^\n]*\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) segments.push({ code: false, body: text.slice(last, m.index) });
    segments.push({ code: true, body: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ code: false, body: text.slice(last) });

  return (
    <View>
      {segments.map((s, i) => (
        <Fragment key={i}>{s.code ? <CodeBlock code={s.body} /> : <TextBlock text={s.body} color={c} />}</Fragment>
      ))}
    </View>
  );
}

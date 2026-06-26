// Selectable Markdown renderer for native. Renders markdown styling (headings,
// bold, code, lists) with RN <Text>. iOS <Text> is UILabel-backed, so long-press
// only offers "Copy all" — there are NO drag handles to select a span. For free
// span selection, callers open the raw text in a SelectSheet (UITextView-backed
// TextInput) instead; pass `selectable={false}` on bubbles that do that, so the
// outer Pressable's long-press/double-tap isn't swallowed by Text's own gesture.
//
// Parsing lives in @/lib/markdown (pure, unit-tested); this file is the view only.
import { View, Text, type TextStyle } from "react-native";
import { useTheme, fonts, radius, type Theme } from "@/lib/theme";
import { parseBlocks, parseInline, type Span } from "@/lib/markdown";

function Inline({ spans, theme, codeSize }: { spans: Span[]; theme: Theme; codeSize: number }) {
  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          style={[
            s.bold ? { fontWeight: "700" as const } : null,
            s.italic ? { fontStyle: "italic" as const } : null,
            s.code ? { fontFamily: fonts.mono, fontSize: codeSize, color: theme.accent } : null,
            s.href ? { color: theme.accent, textDecorationLine: "underline" as const } : null,
          ]}
        >
          {s.text}
        </Text>
      ))}
    </>
  );
}

export function MarkdownText({
  value,
  style,
  selectable = true,
}: {
  value: string;
  style?: TextStyle;
  selectable?: boolean;
}) {
  const theme = useTheme();
  const base: TextStyle = { color: theme.ink, fontSize: 14, lineHeight: 21, ...style };
  const size = (base.fontSize as number) ?? 14;
  const blocks = parseBlocks(value);
  return (
    <View style={{ gap: 6 }}>
      {blocks.map((b, i) => {
        if (b.kind === "heading") {
          const hs = b.level === 1 ? size + 4 : b.level === 2 ? size + 2 : size + 1;
          return (
            <Text key={i} selectable={selectable} style={[base, { fontSize: hs, lineHeight: hs + 6, fontWeight: "700" }]}>
              <Inline spans={parseInline(b.text)} theme={theme} codeSize={size - 1} />
            </Text>
          );
        }
        if (b.kind === "code") {
          return (
            <View
              key={i}
              style={{
                backgroundColor: theme.overlay,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: theme.line,
                paddingHorizontal: 10,
                paddingVertical: 8,
              }}
            >
              <Text selectable={selectable} style={[base, { fontFamily: fonts.mono, fontSize: size - 1, lineHeight: 19 }]}>
                {b.text}
              </Text>
            </View>
          );
        }
        if (b.kind === "list") {
          return (
            <View key={i} style={{ gap: 3 }}>
              {b.items.map((it, j) => (
                <View key={j} style={{ flexDirection: "row", gap: 7 }}>
                  <Text style={[base, { color: theme.muted }]}>{b.ordered ? `${j + 1}.` : "•"}</Text>
                  <Text selectable={selectable} style={[base, { flex: 1 }]}>
                    <Inline spans={parseInline(it)} theme={theme} codeSize={size - 1} />
                  </Text>
                </View>
              ))}
            </View>
          );
        }
        if (b.kind === "quote") {
          return (
            <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: theme.line, paddingLeft: 10 }}>
              <Text selectable={selectable} style={[base, { color: theme.muted }]}>
                <Inline spans={parseInline(b.text)} theme={theme} codeSize={size - 1} />
              </Text>
            </View>
          );
        }
        return (
          <Text key={i} selectable={selectable} style={base}>
            <Inline spans={parseInline(b.text)} theme={theme} codeSize={size - 1} />
          </Text>
        );
      })}
    </View>
  );
}

// A read-only, natively-selectable text node. We use a non-editable multiline
// TextInput rather than <Text selectable> because RN's Text selection is
// unreliable — on Android and across nested Text it often won't grab or won't
// select the whole run. A read-only TextInput gives the real native selection
// handles + copy menu and selects a paragraph continuously.
//
// Trade-off: a TextInput is single-style plain text — no inline markdown (bold,
// code, links render as their raw markers). That's the deliberate choice for
// reliable select-to-copy on the conversation bubbles.
import { TextInput, Platform, StyleSheet, type TextStyle } from "react-native";

export function SelectableText({ value, style }: { value: string; style?: TextStyle }) {
  return (
    <TextInput
      // Trim trailing whitespace so a bubble doesn't gain blank lines at the end.
      value={value.replace(/\s+$/, "")}
      editable={false}
      multiline
      // Expand to fit content inside the outer ScrollView instead of scrolling
      // internally.
      scrollEnabled={false}
      contextMenuHidden={false}
      style={[styles.base, style]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    // Strip the TextInput's platform default chrome so it sits like a <Text>.
    padding: 0,
    margin: 0,
    ...Platform.select({
      android: { textAlignVertical: "top", includeFontPadding: false },
      default: {},
    }),
  },
});

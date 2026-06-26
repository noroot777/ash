// Full-screen text selection sheet (the WeChat trick). A markdown bubble can't be
// drag-selected on iOS (its <Text> is UILabel-backed → long-press only "Copy
// all", no handles). So a double-tap / long-press on a bubble opens its raw text
// HERE, in a read-only multiline TextInput — which IS UITextView-backed, so it
// gives real native selection handles + the copy menu, free selection of any
// span. Pure RN (Modal + TextInput): no native module, works in Expo Go.
import { Modal, View, Text, TextInput, Pressable, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, fonts } from "@/lib/theme";

export function SelectSheet({ text, onClose }: { text: string; onClose: () => void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: Platform.OS === "android" ? insets.top : 0 }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: theme.line,
          }}
        >
          <Text style={{ color: theme.faint, fontSize: 13 }}>长按拖动 · 可选取任意片段复制</Text>
          <Pressable onPress={onClose} hitSlop={10}>
            <Text style={{ color: theme.accent, fontSize: 15, fontWeight: "600" }}>完成</Text>
          </Pressable>
        </View>
        {/* Read-only multiline TextInput == UITextView on iOS == real drag handles.
            scrollEnabled so long output scrolls inside the sheet. */}
        <TextInput
          value={text}
          editable={false}
          multiline
          scrollEnabled
          style={{
            flex: 1,
            paddingHorizontal: 16,
            paddingVertical: 14,
            color: theme.ink,
            fontSize: 15,
            lineHeight: 23,
            fontFamily: fonts.mono,
            textAlignVertical: "top",
          }}
        />
      </View>
    </Modal>
  );
}

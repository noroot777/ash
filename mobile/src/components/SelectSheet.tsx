// Full-screen text selection sheet (the WeChat trick). A markdown bubble can't be
// drag-selected on iOS (its <Text> is UILabel-backed → long-press only "Copy
// all", no handles). So a double-tap / long-press on a bubble opens its raw text
// HERE, in a read-only multiline TextInput — which IS UITextView-backed, so it
// gives real native selection handles + the copy menu, free selection of any
// span. Pure RN (Modal + TextInput): no native module, works in Expo Go.
import type { ReactNode } from "react";
import { Modal, View, Text, TextInput, Pressable, Platform, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme, fonts } from "@/lib/theme";
import { Ionicons } from "@expo/vector-icons";

export type SelectSheetOption = {
  value: string;
  label: string;
  detail?: string;
};

type TextSelectSheetProps = {
  text: string;
  onClose: () => void;
};

type OptionSelectSheetProps = {
  title: string;
  options: SelectSheetOption[];
  value: string;
  onSelect: (value: string) => void;
  onClose: () => void;
  header?: ReactNode;
};

export function SelectSheet(props: TextSelectSheetProps | OptionSelectSheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const optionMode = "options" in props;
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
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
          <Text style={{ color: optionMode ? theme.ink : theme.faint, fontSize: optionMode ? 16 : 13, fontFamily: optionMode ? fonts.bodySemi : fonts.body }}>
            {optionMode ? props.title : "长按拖动 · 可选取任意片段复制"}
          </Text>
          <Pressable onPress={props.onClose} hitSlop={10}>
            <Text style={{ color: theme.accent, fontSize: 15, fontWeight: "600" }}>完成</Text>
          </Pressable>
        </View>
        {optionMode ? (
          <>
            {props.header ? (
              <View style={{ paddingHorizontal: 12, paddingTop: 12 }}>{props.header}</View>
            ) : null}
            <ScrollView contentContainerStyle={{ padding: 12, gap: 6, paddingBottom: insets.bottom + 20 }}>
              {props.options.map((option) => {
                const selected = option.value === props.value;
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => {
                      props.onSelect(option.value);
                      props.onClose();
                    }}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingHorizontal: 14,
                      paddingVertical: 12,
                      borderRadius: 12,
                      backgroundColor: pressed || selected ? theme.raised : "transparent",
                    })}
                  >
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={{ color: theme.ink, fontSize: 15, fontFamily: selected ? fonts.bodySemi : fonts.bodyMed }}>
                        {option.label}
                      </Text>
                      {option.detail ? (
                        <Text style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }} numberOfLines={2}>
                          {option.detail}
                        </Text>
                      ) : null}
                    </View>
                    {selected ? <Ionicons name="checkmark-circle" size={20} color={theme.accent} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </>
        ) : (
          /* Read-only multiline TextInput == UITextView on iOS == real drag handles. */
          <TextInput
            value={props.text}
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
        )}
      </View>
    </Modal>
  );
}

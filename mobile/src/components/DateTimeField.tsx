// 日期时间选择器 —— 封装 @react-native-community/datetimepicker，抹平 iOS / Android
// 差异。对外只进出 Date；调用方负责 .toISOString()。两个入口:
//   <DateTimeField>  —— inline 编辑（new.tsx 选「定时一次」时就地展开）。
//   <DateTimeButton> —— 点子元素弹出选择（会话里的 🕐 定时发送）。
// iOS 用 spinner（inline 或 Modal 里）；Android 没有 datetime 模式，用 imperative
// API 连开 date → time 两步。
import { useState, type ReactNode } from "react";
import { View, Text, Pressable, Platform, Modal, useColorScheme } from "react-native";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { useTheme, radius, fonts } from "@/lib/theme";
import { formatInstant } from "@/lib/time";

// Android：imperative 连开 date → time，两步合并成一个 Date 回调。type==="set" 才算选定，
// "dismissed"（取消任一步）直接放弃。imperative 不需手动卸载，比声明式干净。
function openAndroid(from: Date, min: Date, onPick: (d: Date) => void) {
  DateTimePickerAndroid.open({
    value: from,
    mode: "date",
    is24Hour: true,
    minimumDate: min,
    onChange: (e, dPicked) => {
      if (e.type !== "set" || !dPicked) return;
      const base = new Date(from);
      base.setFullYear(dPicked.getFullYear(), dPicked.getMonth(), dPicked.getDate());
      DateTimePickerAndroid.open({
        value: base,
        mode: "time",
        is24Hour: true,
        onChange: (e2, tPicked) => {
          if (e2.type !== "set" || !tPicked) return;
          base.setHours(tPicked.getHours(), tPicked.getMinutes(), 0, 0);
          onPick(new Date(base));
        },
      });
    },
  });
}

// inline 日期时间编辑（new.tsx）。iOS 常驻 spinner；Android 退化成「显示当前值的按钮 +
// 点击弹两步」（系统弹窗，不受 formSheet 裁剪）。
export function DateTimeField({
  value,
  onChange,
  minimumDate,
}: {
  value: Date;
  onChange: (d: Date) => void;
  minimumDate?: Date;
}) {
  const theme = useTheme();
  const scheme = useColorScheme();
  if (Platform.OS === "ios") {
    return (
      <DateTimePicker
        value={value}
        mode="datetime"
        display="spinner"
        minimumDate={minimumDate}
        themeVariant={scheme === "light" ? "light" : "dark"}
        style={{ alignSelf: "stretch" }}
        onChange={(_e, d) => d && onChange(d)}
      />
    );
  }
  return (
    <Pressable
      onPress={() => openAndroid(value, minimumDate ?? new Date(), onChange)}
      style={{
        backgroundColor: theme.raised,
        borderRadius: radius.lg,
        paddingHorizontal: 14,
        paddingVertical: 12,
        alignSelf: "flex-start",
      }}
    >
      <Text style={{ color: theme.ink, fontSize: 16, fontFamily: fonts.mono }}>
        {formatInstant(value.toISOString())}
      </Text>
    </Pressable>
  );
}

// 点子元素弹出选择（会话 🕐）。iOS 用底部 Modal 承载 spinner + 确定/取消（避免「滚动即
// 提交」）；Android 直接系统两步弹窗。
export function DateTimeButton({
  defaultValue,
  onPick,
  minimumDate,
  disabled,
  children,
}: {
  defaultValue: () => Date; // 点击瞬间求值，避免每次 render 都 new Date 抖动
  onPick: (d: Date) => void;
  minimumDate?: Date;
  disabled?: boolean;
  children: ReactNode;
}) {
  const theme = useTheme();
  const scheme = useColorScheme();
  const [draft, setDraft] = useState<Date | null>(null); // 非 null = iOS Modal 打开中

  const onPress = () => {
    if (disabled) return;
    const start = defaultValue();
    if (Platform.OS === "ios") setDraft(start);
    else openAndroid(start, minimumDate ?? new Date(), onPick);
  };

  return (
    <>
      <Pressable onPress={onPress} hitSlop={8}>
        {children}
      </Pressable>
      {Platform.OS === "ios" && draft !== null && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDraft(null)}>
          <Pressable
            style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "#0008" }}
            onPress={() => setDraft(null)}
          >
            <Pressable
              style={{ backgroundColor: theme.panel, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
              onPress={() => {}}
            >
              <DateTimePicker
                value={draft}
                mode="datetime"
                display="spinner"
                minimumDate={minimumDate}
                themeVariant={scheme === "light" ? "light" : "dark"}
                onChange={(_e, d) => d && setDraft(d)}
              />
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 18, marginTop: 4 }}>
                <Pressable onPress={() => setDraft(null)} hitSlop={8}>
                  <Text style={{ color: theme.muted, fontSize: 16 }}>取消</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    const d = draft;
                    setDraft(null);
                    onPick(d);
                  }}
                  hitSlop={8}
                >
                  <Text style={{ color: theme.accent, fontSize: 16, fontFamily: fonts.bodySemi }}>确定</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

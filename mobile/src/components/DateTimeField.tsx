// 日期时间选择器 —— 封装 @react-native-community/datetimepicker，抹平 iOS / Android
// 差异。对外只进出 Date；调用方负责 .toISOString()。两个入口:
//   <DateTimeField>  —— inline 编辑（new.tsx 选「定时一次」时就地展开）。
//   <DateTimeButton> —— 点子元素弹出选择（会话里的 🕐 定时发送）。
// iOS 用 spinner（inline 或 Modal 里）；Android 没有 datetime 模式，用 imperative
// API 连开 date → time 两步。
import { useState, type ReactNode } from "react";
import { View, Text, Pressable, Platform, Modal, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
    onValueChange: (_event, dPicked) => {
      const base = new Date(from);
      base.setFullYear(dPicked.getFullYear(), dPicked.getMonth(), dPicked.getDate());
      DateTimePickerAndroid.open({
        value: base,
        mode: "time",
        is24Hour: true,
        onValueChange: (_event, tPicked) => {
          base.setHours(tPicked.getHours(), tPicked.getMinutes(), 0, 0);
          onPick(new Date(base));
        },
        // 取消第二步时保留调用前的值，不提交只选了一半的日期。
        onDismiss: () => {},
      });
    },
    // 取消第一步时不打开时间选择器，也不写入值。
    onDismiss: () => {},
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
        onValueChange={(_event, date) => onChange(date)}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`修改日期和时间，当前为 ${formatInstant(value.toISOString())}`}
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
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState<Date | null>(null); // 非 null = iOS Modal 打开中

  const onPress = () => {
    if (disabled) return;
    const start = defaultValue();
    if (Platform.OS === "ios") setDraft(start);
    else openAndroid(start, minimumDate ?? new Date(), onPick);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="定时发送"
        accessibilityState={{ disabled: !!disabled }}
        onPress={onPress}
        hitSlop={8}
      >
        {children}
      </Pressable>
      {Platform.OS === "ios" && draft !== null && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDraft(null)}>
          <Pressable
            accessible={false}
            style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "#0008" }}
            onPress={() => setDraft(null)}
          >
            {/* 底部留白跟着手势条走：写死 32 时，34pt 手势条的机型上「确定」正好压在
                系统上划区里，一按就退出 app。 */}
            <Pressable
              accessible={false}
              style={{
                backgroundColor: theme.panel,
                paddingHorizontal: 16,
                paddingTop: 8,
                paddingBottom: insets.bottom + 16,
              }}
              onPress={() => {}}
            >
              <DateTimePicker
                value={draft}
                mode="datetime"
                display="spinner"
                minimumDate={minimumDate}
                themeVariant={scheme === "light" ? "light" : "dark"}
                onValueChange={(_event, date) => setDraft(date)}
              />
              <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="取消定时发送"
                  onPress={() => setDraft(null)}
                  hitSlop={8}
                  style={{ minWidth: 72, minHeight: 44, alignItems: "center", justifyContent: "center" }}
                >
                  <Text style={{ color: theme.muted, fontSize: 16 }}>取消</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="确定定时发送时间"
                  onPress={() => {
                    const d = draft;
                    setDraft(null);
                    onPick(d);
                  }}
                  hitSlop={8}
                  style={{ minWidth: 72, minHeight: 44, alignItems: "center", justifyContent: "center" }}
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

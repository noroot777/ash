// once / cron 的值编辑器（RN 版，对应 web/src/ScheduleFields.tsx）。被 new.tsx 的
// 「启动时机」inline 复用。对外:once 用 Date，cron 用裸 5 字段字符串（与 web 一致，
// 不做预设）。手机无 hover —— cron 示例可见地显示在输入框下方。
import { View, Text } from "react-native";
import { useTheme, fonts } from "@/lib/theme";
import { Input } from "@/components/ui";
import { DateTimeField } from "@/components/DateTimeField";
import { CRON_EXAMPLES } from "@/lib/constants";
import { formatInstant } from "@/lib/time";

export function ScheduleFields({
  kind,
  at,
  cron,
  onAt,
  onCron,
}: {
  kind: "once" | "cron";
  at: Date;
  cron: string;
  onAt: (d: Date) => void;
  onCron: (v: string) => void;
}) {
  const theme = useTheme();
  if (kind === "once") {
    return (
      <View style={{ gap: 8 }}>
        <DateTimeField value={at} onChange={onAt} minimumDate={new Date()} />
        <Text style={{ color: theme.faint, fontSize: 12, fontFamily: fonts.mono }}>
          将于 {formatInstant(at.toISOString())} 运行
        </Text>
      </View>
    );
  }
  return (
    <View style={{ gap: 6 }}>
      <Input
        value={cron}
        onChangeText={onCron}
        placeholder="分 时 日 月 周"
        autoCapitalize="none"
        autoCorrect={false}
        style={{ fontFamily: fonts.mono }}
      />
      <Text style={{ color: theme.faint, fontSize: 12 }}>{CRON_EXAMPLES}</Text>
    </View>
  );
}

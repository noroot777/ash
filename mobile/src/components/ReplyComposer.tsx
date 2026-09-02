// 单飞任务详情的底部回复区：待发送托盘（定时/排队消息）+ `/` 技能候选 + 输入行。
// 从 app/task/[id].tsx 拆出来 —— 那个文件已经贴着单文件行数上限，而这一块跟会话渲染
// 没有耦合，只吃 props。
import { Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ScheduledMessage, TaskListItem } from "@ash/shared";
import { useKeyboardVisible } from "@/lib/keyboard";
import { fonts, radius, useTheme } from "@/lib/theme";
import { DateTimeButton } from "@/components/DateTimeField";
import { PendingMessageTray } from "@/components/PendingMessageTray";
import { SkillSuggestions } from "@/components/SkillSuggestions";

export function ReplyComposer({
  task,
  input,
  pending,
  queueing,
  frozen,
  dispatchedWorker,
  bottomInset,
  onInputChange,
  onSend,
  onPendingRemoved,
  onPendingReload,
}: {
  task: TaskListItem;
  input: string;
  pending: ScheduledMessage[];
  /** 任务在跑：这一条会落成排队消息，按钮文案跟着改口。 */
  queueing: boolean;
  /** 已归档（只读）：整条输入区换成一句说明。 */
  frozen: boolean;
  dispatchedWorker: boolean;
  bottomInset: number;
  onInputChange: (next: string) => void;
  onSend: (sendAt?: Date) => void;
  onPendingRemoved: (messageId: string) => void;
  onPendingReload: () => void;
}) {
  const theme = useTheme();
  // 键盘顶上来之后手势条那一段已经被盖住，再留 insets.bottom 就是输入框和键盘之间一
  // 条谁也用不上的空隙（iPhone 上白白吃掉 34pt）。
  const keyboardVisible = useKeyboardVisible();
  const paddingBottom = (keyboardVisible ? 0 : bottomInset) + 8;

  if (frozen) {
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          paddingTop: 12,
          paddingBottom: bottomInset + 12,
          borderTopWidth: 1,
          borderTopColor: theme.line,
          backgroundColor: theme.panel,
        }}
      >
        <Ionicons name="archive" size={14} color={theme.faint} />
        <Text style={{ color: theme.faint, fontSize: 13, fontFamily: fonts.body }}>
          {dispatchedWorker ? "已由所属团队归档" : "已归档——取消归档后可继续对话"}
        </Text>
      </View>
    );
  }

  const enabled = !!input.trim();
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom,
        borderTopWidth: 1,
        borderTopColor: theme.line,
        backgroundColor: theme.panel,
        gap: 8,
      }}
    >
      <PendingMessageTray
        messages={pending}
        onRemoved={onPendingRemoved}
        onReload={onPendingReload}
        onRestoreText={(restored) => onInputChange(input.trim() ? `${restored}\n\n${input}` : restored)}
      />

      <SkillSuggestions
        agentType={task.agentType}
        projectId={task.projectId}
        value={input}
        onPick={(command) => onInputChange(`${command} `)}
      />

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          value={input}
          onChangeText={onInputChange}
          accessibilityLabel="回复这个任务"
          placeholder={queueing ? "任务进行中，发送即排队，跑完自动发出…" : "回复（续接会话）…"}
          placeholderTextColor={theme.faint}
          multiline
          style={{
            flex: 1,
            minHeight: 42,
            maxHeight: 120,
            color: theme.ink,
            backgroundColor: theme.bg,
            borderWidth: 1,
            borderColor: theme.line,
            borderRadius: radius.lg,
            paddingHorizontal: 12,
            paddingVertical: 9,
            fontSize: 15,
            fontFamily: fonts.body,
          }}
        />
        {/* 🕐 定时发送：对 running 任务也允许排定时（后端允许），故只看是否有文字 */}
        <DateTimeButton
          defaultValue={() => new Date(Date.now() + 3600_000)}
          minimumDate={new Date()}
          disabled={!enabled}
          onPick={(at) => onSend(at)}
        >
          <View
            style={{
              width: 44,
              height: 42,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: radius.lg,
              borderWidth: 1,
              borderColor: theme.line,
              opacity: enabled ? 1 : 0.4,
            }}
          >
            <Ionicons name="time-outline" size={18} color={theme.muted} />
          </View>
        </DateTimeButton>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={queueing ? "排队发送" : "发送回复"}
          onPress={() => onSend()}
          disabled={!enabled}
          style={{
            minWidth: 58,
            height: 42,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: 14,
            borderRadius: radius.lg,
            backgroundColor: theme.accent,
            opacity: enabled ? 1 : 0.4,
          }}
        >
          <Text style={{ color: theme.accentFg, fontSize: 14, fontFamily: fonts.bodySemi }}>
            {queueing ? "排队" : "发送"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

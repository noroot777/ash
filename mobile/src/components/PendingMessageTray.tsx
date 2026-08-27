import { Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ScheduledMessage } from "@ash/shared";
import { api } from "@/lib/api";
import { useTheme, radius, fonts } from "@/lib/theme";
import { formatInstant } from "@/lib/time";

/**
 * 待发送消息托盘（手机端）。每行两颗按钮，承诺各不相同，所以谁也不冒充谁：
 *
 * • **撤回** = 内容原样回到输入框。手机端这一屏没有附件通道（输入框只发正文），
 *   带附件的消息做不到这件事，就一次都不做：只提示去网页端撤回，**不发取消请求**，
 *   消息原样留在队列上，随时还能在网页端连图片、文件一起捞回来。
 * • **丢弃** = 明说什么都不留，且必须过一遍确认。
 *
 * web 那边输入框收得下附件，所以只有一颗撤回按钮（web/src/components/ScheduledMessages.tsx）。
 */
export function PendingMessageTray({
  messages,
  onRemoved,
  onReload,
  onRestoreText,
}: {
  messages: ScheduledMessage[];
  // 取消成功：这一行该从托盘上消失了。
  onRemoved: (messageId: string) => void;
  // 取消失败：消息还挂在队列上，界面不能自己少一行，重拉一次为准。
  onReload: () => void;
  // 撤回下来的正文，接回输入框。
  onRestoreText: (text: string) => void;
}) {
  const theme = useTheme();

  // 真正调用取消端点。撤回和丢弃都经它，区别只在取下来之后做什么。
  const cancelPending = async (message: ScheduledMessage): Promise<boolean> => {
    try {
      await api.cancelScheduledMessage(message.id);
    } catch (e) {
      Alert.alert("操作失败", e instanceof Error ? e.message : String(e));
      onReload();
      return false;
    }
    onRemoved(message.id);
    return true;
  };

  // 取消成功才回填——失败了消息还在队列上，再往输入框塞一份就成了两条。
  const withdraw = async (message: ScheduledMessage) => {
    if (message.attachments.length) {
      Alert.alert(
        "这条得去网页端撤回",
        `共 ${message.attachments.length} 个附件。手机端的输入框只放得下正文，附件没有落点，所以这里不做撤回——消息仍在队列上。到网页端撤回，正文和附件会一起回到对话框；只想扔掉它就点旁边的丢弃。`,
        [{ text: "知道了" }],
      );
      return;
    }
    if (!await cancelPending(message)) return;
    const restored = message.text.trim();
    if (restored) onRestoreText(restored);
  };

  const discard = (message: ScheduledMessage) => {
    Alert.alert(
      "丢弃这条待发送消息？",
      message.attachments.length
        ? `正文和 ${message.attachments.length} 个附件都不保留，也不会放回输入框。`
        : "正文不保留，也不会放回输入框。",
      [
        { text: "取消", style: "cancel" },
        { text: "丢弃", style: "destructive", onPress: () => void cancelPending(message) },
      ],
    );
  };

  return (
    <>
      {messages.map((m) => (
        <View
          key={m.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: theme.overlay,
            borderRadius: radius.sm,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          {/* 排队消息不看时间（跑完就发），所以那一列写「排队中」而不是一个骗人的时刻。 */}
          <Ionicons name={m.mode === "queued" ? "layers-outline" : "time-outline"} size={13} color={theme.faint} />
          <Text style={{ color: theme.muted, fontSize: 12, fontFamily: fonts.mono }}>
            {m.mode === "queued" ? "排队中" : formatInstant(m.sendAt)}
          </Text>
          <Text numberOfLines={1} style={{ flex: 1, color: theme.ink, fontSize: 13 }}>
            {m.text || "[附件]"}
          </Text>
          {/* 手机端撤不回附件（见 withdraw），所以按之前先让人看见这条带了几个。 */}
          {m.attachments.length > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <Ionicons name="attach-outline" size={12} color={theme.faint} />
              <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>{m.attachments.length}</Text>
            </View>
          )}
          <Pressable
            onPress={() => void withdraw(m)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={m.attachments.length
              ? `撤回这条待发送消息；它带了 ${m.attachments.length} 个附件，需要到网页端撤回`
              : "撤回这条待发送消息，内容放回输入框"}
          >
            <Ionicons name="arrow-undo-outline" size={15} color={theme.faint} />
          </Pressable>
          <Pressable
            onPress={() => discard(m)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="丢弃这条待发送消息，内容不保留"
          >
            <Ionicons name="trash-outline" size={15} color={theme.faint} />
          </Pressable>
        </View>
      ))}
    </>
  );
}

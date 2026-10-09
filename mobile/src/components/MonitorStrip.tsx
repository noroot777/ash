import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TaskMonitor } from "@ash/shared/monitor";
import { api } from "@/lib/api";
import { useTheme, radius, fonts } from "@/lib/theme";

/**
 * 哨兵条（手机端）。只做两件事：看见还有谁在盯，以及把跑飞了的那个停掉。
 *
 * 为什么手机上也要有：哨兵的进程是故意脱离 ash 的，它的每一条事件都会唤醒任务跑一轮
 * 真回合（花真钱）。人不在电脑前的时候，恰恰最需要一个「叫停」的入口——否则只能等回到
 * 桌面前才按得到，中间这段时间它一直在烧。
 *
 * 起哨兵没有手动入口：那是 agent 在自己回合里做的决定。
 *
 * 跟这一屏其它东西一样走轮询，不开实时通道（mobile 的既定取舍）。
 */
export function MonitorStrip({ taskId, visible }: { taskId: string; visible: boolean }) {
  const theme = useTheme();
  const [monitors, setMonitors] = useState<TaskMonitor[]>([]);
  const [stopping, setStopping] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try { setMonitors(await api.taskMonitors(taskId)); } catch { /* 这一条不值得打断对话 */ }
  }, [taskId]);

  useEffect(() => {
    if (!visible) return;
    setMonitors([]);
    void reload();
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [reload, visible]);

  const live = monitors.filter((m) => m.status === "running");
  if (!live.length) return null;

  const stop = (monitor: TaskMonitor) => {
    Alert.alert("停掉哨兵", `「${monitor.description}」\n杀掉它的进程，不再唤醒这个任务。`, [
      { text: "取消", style: "cancel" },
      {
        text: "停掉",
        style: "destructive",
        onPress: () => {
          setStopping(monitor.id);
          void api.stopMonitor(monitor.id, "手机端停止")
            .catch((e) => Alert.alert("停不掉", e instanceof Error ? e.message : String(e)))
            .finally(() => { setStopping(null); void reload(); });
        },
      },
    ]);
  };

  return (
    <>
      {live.map((monitor) => (
        <View
          key={monitor.id}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            backgroundColor: theme.overlay,
            borderRadius: radius.sm,
            paddingHorizontal: 10,
            paddingVertical: 4,
          }}
        >
          <Ionicons name="pulse-outline" size={13} color={theme.accent} />
          <Text numberOfLines={1} style={{ flex: 1, color: theme.ink, fontSize: 13 }}>{monitor.description}</Text>
          <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>{monitor.events} 条</Text>
          <Pressable
            onPress={() => stop(monitor)}
            disabled={stopping === monitor.id}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={`停掉哨兵「${monitor.description}」`}
            style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
          >
            <Ionicons name="stop-circle-outline" size={17} color={theme.faint} />
          </Pressable>
        </View>
      ))}
    </>
  );
}

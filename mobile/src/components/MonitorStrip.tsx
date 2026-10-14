import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { canStopMonitor, type TaskMonitor } from "@ash/shared/monitor";
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
 * **两种来源要分开画**（`kind`，语义见 shared/src/monitor.ts）：列表 API 同时返回 ash 自己
 * 起的和 claude 内置 Monitor 的只读投影。后者 ash 停不掉（进程在智能体自己的进程树里），
 * 事件数也数不到（恒为 0）。不分流的话，手机上会给一张投影卡画出停止按钮和「0 条」——
 * 按下去只会弹一句「停不掉」，而那条哨兵照跑不误。**别展示一个注定失败的操作。**
 *
 * 跟这一屏其它东西一样走轮询，不开实时通道（mobile 的既定取舍）。
 */
export function MonitorStrip({ taskId, visible }: { taskId: string; visible: boolean }) {
  const theme = useTheme();
  const [monitors, setMonitors] = useState<TaskMonitor[]>([]);
  /**
   * 正在停的是**哪个任务的哪一条**。
   *
   * 只记 id 不行：切走再切回来（同一个组件实例被复用）时，上一次操作的收尾认不出自己该不该
   * 清，于是按钮一直灰着（第 9 轮审查实测同一实例 A→B→A 复用，按钮永久 disabled）。
   */
  const [stopping, setStopping] = useState<{ taskId: string; id: string } | null>(null);
  /**
   * 「这份列表是哪个任务的、是第几代、是第几发请求」——**在途请求的归属判据**。
   *
   * 清掉 state 和 interval 不等于让在途的请求作废：
   * - 代次 `gen` + `taskId`：A 任务读得慢时切到 B，B 先返回、A 随后回来会把 B 的列表盖掉，
   *   而那张卡上还带着能按的「停掉」（第 8 轮审查）。
   * - 请求序号 `seq`：**同一个任务内部**也会乱序。停掉之后那一发 reload 返回空列表，旧那发
   *   轮询随后回来又把 running 画回去，卡片连停止按钮一起复活（第 9 轮审查实测）。判据是
   *   「我出门之后有没有发过更新的一发」，有就丢掉自己这份（最后发出的那一发说话）。
   */
  const stamp = useRef({ gen: 0, taskId: "", seq: 0 });

  const reload = useCallback(async () => {
    const gen = stamp.current.gen;
    const seq = (stamp.current.seq += 1);
    try {
      const next = await api.taskMonitors(taskId);
      // 回来得太晚（已经切到别的任务 / 之后又发过更新的一发）就丢掉，别往新任务上画旧数据、
      // 也别用旧快照盖掉新结果。
      if (stamp.current.gen !== gen || stamp.current.taskId !== taskId) return;
      if (stamp.current.seq !== seq) return;
      setMonitors(next);
    } catch { /* 这一条不值得打断对话 */ }
  }, [taskId]);

  useEffect(() => {
    if (!visible) {
      stamp.current = { ...stamp.current, gen: stamp.current.gen + 1, taskId: "" };
      return;
    }
    // 切任务/重新可见：代次 +1，在途的那些回来时已经不是「这一屏的列表」了。
    stamp.current = { ...stamp.current, gen: stamp.current.gen + 1, taskId };
    setMonitors([]);
    void reload();
    const timer = setInterval(() => void reload(), 10_000);
    return () => clearInterval(timer);
  }, [reload, taskId, visible]);

  const live = monitors.filter((m) => m.status === "running");
  if (!live.length) return null;

  const stop = (monitor: TaskMonitor) => {
    Alert.alert("停掉哨兵", `「${monitor.description}」\n杀掉它的进程，不再唤醒这个任务。`, [
      { text: "取消", style: "cancel" },
      {
        text: "停掉",
        style: "destructive",
        onPress: () => {
          // 停止的收尾也认归属：切走之后那一发 reload 不该把列表画到新任务上，
          // 它的「正在停」也不该按住新任务的卡（判据与上面同一套）。
          const gen = stamp.current.gen;
          const mine = () => stamp.current.gen === gen && stamp.current.taskId === taskId;
          setStopping({ taskId, id: monitor.id });
          void api.stopMonitor(monitor.id, "手机端停止")
            .catch((e) => { if (mine()) Alert.alert("停不掉", e instanceof Error ? e.message : String(e)); })
            .finally(() => {
              // **操作状态无条件结束**：它只属于这一次操作，过期了也得自己收。按归属判据
              // 提前 return 的那一版，在同一实例被复用时把按钮永久按住了（第 9 轮审查）。
              // 认的是「这是不是我当初按下的那一条」，不是「现在还是不是这个任务」。
              setStopping((cur) => (cur && cur.taskId === taskId && cur.id === monitor.id ? null : cur));
              // 列表只画给当前这一屏：切走之后那一发收尾 reload 不该落到新任务上。
              if (mine()) void reload();
            });
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
          {canStopMonitor(monitor.kind)
            ? (
              <>
                <Text style={{ color: theme.faint, fontSize: 11, fontFamily: fonts.mono }}>{monitor.events} 条</Text>
                <Pressable
                  onPress={() => stop(monitor)}
                  disabled={stopping?.taskId === taskId && stopping.id === monitor.id}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityLabel={`停掉哨兵「${monitor.description}」`}
                  style={{ width: 36, height: 36, alignItems: "center", justifyContent: "center" }}
                >
                  <Ionicons name="stop-circle-outline" size={17} color={theme.faint} />
                </Pressable>
              </>
            )
            : (
              // 只读投影：标明来源，不画事件数（ash 数不到）、不画停止按钮（ash 停不掉）。
              <Text style={{ color: theme.faint, fontSize: 11 }}>智能体自带 · 只能看</Text>
            )}
        </View>
      ))}
    </>
  );
}

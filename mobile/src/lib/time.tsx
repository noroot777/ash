// 时间显示 —— 移植自 web/src/time.tsx,纯函数逐字保持一致(web/mobile 同一套
// 格式),组件层换成 React Native 的 <Text>/<View> + Ionicons。数据源是后端的
// ISO 字符串(Task.createdAt/startedAt/endedAt、Session.startedAt/endedAt)。
import { useEffect, useState } from "react";
import { View, Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Task } from "@harness/shared";
import { useTheme, fonts } from "./theme";

// ── 格式化(与 web 一致)────────────────────────────────────────────────────
// 瞬时时刻:紧凑本地 "MM/DD HH:mm"(例 06/13 15:35)。
export function formatInstant(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 运行时长:"1h 15m 3s" —— 从最大非零单位到秒(超 24h 折成天)。亚秒/负数归 "0s"。
export function formatDuration(ms: number): string {
  let s = Math.floor((Number.isFinite(ms) ? ms : 0) / 1000);
  if (s < 0) s = 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function durationText(from?: string | null, to?: string | null, nowMs?: number): string {
  if (!from) return "";
  const start = new Date(from).getTime();
  if (Number.isNaN(start)) return "";
  const end = to ? new Date(to).getTime() : (nowMs ?? Date.now());
  return formatDuration(end - start);
}

// 当 `active` 时每秒重渲染一次(让 live「用时」跳动);非 active 不起计时器。
// 返回当前 epoch ms。Hook 顺序稳定(始终调用)。
export function useTick(active: boolean): number {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => bump((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

// ── 显示组件 ─────────────────────────────────────────────────────────────────
// from→to 的耗时。`to` 缺席(运行进行中)时每秒跳动;`to` 有值则静态。
// 传入外部 `nowMs`(列表共享一个计时器的节拍)时不自起计时器,跟随外部节拍重渲染。
export function Duration({
  from,
  to,
  nowMs,
  style,
}: {
  from?: string | null;
  to?: string | null;
  nowMs?: number;
  style?: StyleProp<TextStyle>;
}) {
  const live = !!from && !to && nowMs === undefined;
  const tick = useTick(live);
  const t = durationText(from, to, nowMs ?? (live ? tick : undefined));
  return t ? <Text style={style}>{t}</Text> : null;
}

// 紧凑的生命周期时间 chip(列表项 / 详情头共用)。有 startedAt 时显示执行时间:
// measured(后端按轮累计的真实执行时长)显示「用时 X」并在运行中跳动;历史任务无
// 法还原则显示「跨度 X」(墙钟,含等待回复的空闲)。无 startedAt 显示「创建 …」。
// 列表传 `nowMs` 共享节拍;详情不传,自走 live。移动端无 hover,不带提示文案。
export function TaskTimeChip({
  task,
  nowMs,
  style,
}: {
  task: Task;
  nowMs?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const running = task.status === "running" || task.status === "queued";
  const measured = typeof task.activeMs === "number";
  const legacy = task.activeMs === undefined; // 旧 server 未下发 → 兼容期沿用墙钟「用时」
  const live = measured && !!task.liveSince && !task.endedAt;
  // 列表传 nowMs(共享节拍)时不自起计时器;详情自走 live。
  const selfTick = useTick(live && nowMs === undefined);
  const clock = nowMs ?? selfTick;
  const ms = measured ? task.activeMs! + (live ? Math.max(0, clock - Date.parse(task.liveSince!)) : 0) : 0;
  const txt: TextStyle = { fontSize: 11, fontFamily: fonts.mono, color: running ? theme.muted : theme.faint };
  const faint: TextStyle = { fontSize: 11, fontFamily: fonts.mono, color: theme.faint };
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: 4 }, style]}>
      <Ionicons name="time-outline" size={12} color={theme.faint} />
      {task.startedAt ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Text style={measured || legacy ? txt : faint}>{measured || legacy ? "用时" : "跨度"}</Text>
          {measured ? (
            <Text style={txt}>{formatDuration(ms)}</Text>
          ) : legacy ? (
            <Duration from={task.startedAt} to={task.endedAt} nowMs={nowMs} style={txt} />
          ) : (
            <Text style={faint}>{durationText(task.startedAt, task.endedAt, clock)}</Text>
          )}
        </View>
      ) : (
        <Text style={faint}>创建 {formatInstant(task.createdAt)}</Text>
      )}
    </View>
  );
}

import type { ReactNode } from "react";
import { Robot, Scales, UsersThree, Tray, Play, Clock, ArrowsClockwise } from "@phosphor-icons/react";

// 新建任务的三种形态。共享给内嵌 composer 及其子组件，免得各处各写一份。
export type ComposerMode = "single" | "team" | "debate";

export const TASK_MODES: { key: ComposerMode; label: string; icon: ReactNode }[] = [
  { key: "single", label: "普通任务", icon: <Robot size={15} /> },
  { key: "team", label: "团队任务", icon: <UsersThree size={15} /> },
  { key: "debate", label: "辩论", icon: <Scales size={15} /> },
];

// 启动时机 (§9)：创建一个任务时「什么时候开始跑」。create=仅落 backlog；run=建完
// 立即跑（默认）；once/cron=挂定时，由调度器到点入队（不立即跑）。
export type LaunchMode = "create" | "run" | "once" | "cron";

export const LAUNCH_MODES: { key: LaunchMode; label: string; detail: string; icon: ReactNode; btn: string }[] = [
  { key: "create", label: "仅创建", detail: "进待办，手动再跑", icon: <Tray size={15} />, btn: "创建任务" },
  { key: "run", label: "创建并执行", detail: "立即开跑", icon: <Play size={15} weight="fill" />, btn: "创建并执行" },
  { key: "once", label: "一次性…", detail: "约定时间跑一次", icon: <Clock size={15} />, btn: "创建并定时" },
  { key: "cron", label: "循环…", detail: "按周期反复跑", icon: <ArrowsClockwise size={15} />, btn: "创建并定时" },
];

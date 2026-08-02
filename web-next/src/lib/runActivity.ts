import type { TaskMode, TaskStatus } from "@harness/shared";

export type RunActivityInput = {
  status: TaskStatus;
  mode: TaskMode;
  executor?: string | null;
  queuePosition?: number | null;
};

export type RunActivityCopy = {
  title: string;
  detail: string;
};

export function runActivityCopy({
  status,
  mode,
  executor,
  queuePosition,
}: RunActivityInput): RunActivityCopy | null {
  if (status === "queued") {
    const place = queuePosition == null ? "" : ` · 第 ${queuePosition + 1} 位`;
    return {
      title: `已进入队列${place}`,
      detail: "前面的任务结束后会自动启动，无需重复点击。",
    };
  }
  if (status !== "running") return null;

  if (mode === "team") {
    return {
      title: `${executor || "调度者"} 正在启动调度台`,
      detail: "调度者正在读取需求；开始拆活后，派活记录和执行者状态会出现在这里。",
    };
  }
  if (mode === "debate") {
    return {
      title: "正在启动首轮辩论",
      detail: "双方辩手正在就绪；第一位辩手开始发言后，内容会实时显示在这里。",
    };
  }
  return {
    title: `${executor || "智能体"} 正在启动`,
    detail: "正在准备运行环境、读取任务并连接执行器。首条输出会自动出现在这里，无需重复点击。",
  };
}

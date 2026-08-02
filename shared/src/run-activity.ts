import type { TaskMode, TaskStatus } from "./index.js";

export type RunActivityTail = "empty" | "user" | "agent-active" | "agent-ended" | "other";
export type RunActivityPhase = "starting" | "replying" | "continuing";

export type RunActivityInput = {
  status: TaskStatus;
  mode: TaskMode;
  phase?: RunActivityPhase;
  executor?: string | null;
  queuePosition?: number | null;
  queueSize?: number | null;
};

export type RunActivityCopy = {
  title: string;
  detail: string;
};

export function runActivityPhase(status: TaskStatus, tail: RunActivityTail): RunActivityPhase | null {
  if (status !== "running" && status !== "queued") return null;
  if (status === "queued") return tail === "empty" ? "starting" : tail === "user" ? "replying" : "continuing";
  if (tail === "agent-active") return null;
  if (tail === "empty") return "starting";
  if (tail === "user") return "replying";
  return "continuing";
}

export function runActivityCopy({
  status,
  mode,
  phase = "starting",
  executor,
  queuePosition,
  queueSize,
}: RunActivityInput): RunActivityCopy | null {
  if (status === "queued") {
    const place = queuePosition == null
      ? ""
      : ` · 第 ${queuePosition + 1}${queueSize == null ? "" : ` / ${queueSize}`} 位`;
    return {
      title: `已进入队列${place}`,
      detail: "前面的任务结束后会自动启动，无需重复点击。",
    };
  }
  if (status !== "running") return null;

  if (mode === "team") {
    if (phase === "replying") return {
      title: `${executor || "调度者"} 已收到你的消息`,
      detail: "正在结合你的补充调整方向；新的拆解、派活或回复会自动出现在这里。",
    };
    if (phase === "continuing") return {
      title: `${executor || "调度者"} 正在继续推进`,
      detail: "正在等待执行者进展或安排下一步；新动态会自动出现在这里。",
    };
    return {
      title: `${executor || "调度者"} 正在启动调度台`,
      detail: "调度者正在读取需求；开始拆活后，派活记录和执行者状态会出现在这里。",
    };
  }
  if (mode === "debate") {
    if (phase === "replying") return {
      title: "双方已收到你的补充",
      detail: "辩手正在结合新信息准备下一次发言，内容会实时显示在这里。",
    };
    if (phase === "continuing") return {
      title: "正在准备下一次发言",
      detail: "本轮仍在继续；下一位辩手开口后，内容会实时显示在这里。",
    };
    return {
      title: "正在启动首轮辩论",
      detail: "双方辩手正在就绪；第一位辩手开始发言后，内容会实时显示在这里。",
    };
  }
  if (phase === "replying") return {
    title: `${executor || "智能体"} 已收到你的消息`,
    detail: "正在恢复原会话并读取你的补充，下一条回复会自动出现在这里。",
  };
  if (phase === "continuing") return {
    title: `${executor || "智能体"} 正在继续处理`,
    detail: "当前回合仍在进行；新的输出会自动追加到会话末尾。",
  };
  return {
    title: `${executor || "智能体"} 正在启动`,
    detail: "正在准备运行环境、读取任务并连接执行器。首条输出会自动出现在这里，无需重复点击。",
  };
}

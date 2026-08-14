import type { TaskMode, TaskStatus } from "./index.ts";

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

/** 会话流里的一条:只关心它是不是「消息」,以及 agent 那条收没收口。 */
export type RunActivityMessage = { kind: string; endedAt?: string | null; bySystem?: boolean };

/** 一条会话行(sessions 表的形状),用来判断此刻是谁在跑。 */
export type RunActivityActor = {
  agentType?: string | null;
  executor?: string | null; // executor profile name
  startedAt?: string | null;
  turnStartedAt?: string | null;
  endedAt?: string | null; // null = 这条会话此刻有回合在跑
};

/**
 * 尾巴看的是最后一条**消息**,不是最后一行。事件行(「任务又被唤醒」「本轮执行结束」)
 * 夹在末尾会把「已收到你的消息」冲成「委派中」——用户刚说完话,横幅却像在自言自语。
 */
export function runActivityTail(items: readonly RunActivityMessage[]): RunActivityTail {
  if (!items.length) return "empty";
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "user") return item.bySystem ? "other" : "user";
    if (item.kind === "agent") return item.endedAt ? "agent-ended" : "agent-active";
  }
  return "other";
}

function actorLabel(actor: RunActivityActor): string | null {
  return actor.executor?.trim() || actor.agentType?.trim() || null;
}

function actorTurnAt(actor: RunActivityActor): number {
  const parsed = Date.parse(actor.turnStartedAt || actor.startedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 横幅上该报谁的名字。
 *
 * 一个普通任务可以住着好几个智能体(每个 @ 召唤进来的都有自己的会话行),所以「这一
 * 回合是谁在跑」**不等于**任务的常设执行器 `executorLabel`:@grok 干活时报 codex,
 * 是把用户刚做的选择当没发生过。优先级:
 *   ① 正在跑的那条会话(endedAt 为空;多条取回合最新的那条)——刷新后也算得出来;
 *   ② 刚发出去、服务端还没落下会话行的那一回合目标(`pending`,只补前一两秒的空窗);
 *   ③ 任务自己的常设执行器(从没跑过、或后端按常设配置续跑时的兜底)。
 */
export function runActivityExecutor({
  sessions = [],
  pending,
  fallback,
}: {
  sessions?: readonly RunActivityActor[];
  pending?: string | null;
  fallback?: string | null;
}): string | null {
  let live: RunActivityActor | null = null;
  for (const session of sessions) {
    if (session.endedAt) continue;
    if (!live || actorTurnAt(session) >= actorTurnAt(live)) live = session;
  }
  return (live ? actorLabel(live) : null) || pending?.trim() || fallback?.trim() || null;
}

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
  if (mode === "duet") {
    if (phase === "replying") return {
      title: "双方已收到你的补充",
      detail: "讨论者正在结合新信息准备下一次发言，内容会实时显示在这里。",
    };
    if (phase === "continuing") return {
      title: "正在准备下一次发言",
      detail: "本轮仍在继续；下一位讨论者开口后，内容会实时显示在这里。",
    };
    return {
      title: "正在启动首轮讨论",
      detail: "双方讨论者正在就绪；第一位讨论者开始发言后，内容会实时显示在这里。",
    };
  }
  if (phase === "replying") return {
    title: `${executor || "智能体"} 已收到你的消息`,
    detail: "正在恢复原会话并读取你的补充，下一条回复会自动出现在这里。",
  };
  if (phase === "continuing") return {
    title: `${executor || "智能体"} 委派中`,
    detail: "当前回合仍在进行；新的输出会自动追加到会话末尾。",
  };
  return {
    title: `${executor || "智能体"} 正在启动`,
    detail: "正在准备运行环境、读取任务并连接执行器。首条输出会自动出现在这里，无需重复点击。",
  };
}

// 回合身份(ASH_TASK_ID + 回合令牌 + 方向令牌)怎么进 agent 进程 —— **设和清都只走这里**。
//
// 为什么收成一处:这套变量有两类调用点,而它们的正确性是互为镜像的:
//  · **设**:真任务回合(`task-run.ts` / `orchestrator.ts`)。少一个变量 = agent 交不了卷。
//  · **清**:不是任务回合的那几条路(侧聊、预览助手、duet 讨论者)。那里**不设不等于没有**
//    —— 子进程默认继承 server 自己的环境,而 ash 从一个 ash 任务里启动时这几个变量是有值的
//    (duet 实测收到过**另一个任务**的 `ASH_TASK_ID`)。借来的身份比没有身份更糟:它能拿着去
//    调 `complete_task`。
//
// 两类调用点加起来有五处,而变量名本轮多了一套别名(见 `@ash/shared/mcp` 的
// `ASH_TURN_IDENTITY_ENV`:gemini 按名字过滤带 TOKEN 字样的变量)。名单散在五处的话,
// 下一次加名字只要漏掉一个「清」的地方,就是一条能借身份的暗路 —— 所以这里只给两个函数,
// 名单它们自己从 shared 那份常量里取。
import { ASH_TURN_IDENTITY_ENV, ASH_TURN_IDENTITY_ENV_KEYS } from "@ash/shared/mcp";

/** 这一回合的身份变量(两套名字同值)。 */
export function turnIdentityEnv(id: {
  taskId: string;
  turnToken: string;
  directionToken: string;
}): Record<string, string> {
  return {
    [ASH_TURN_IDENTITY_ENV.taskId]: id.taskId,
    [ASH_TURN_IDENTITY_ENV.turnToken]: id.turnToken,
    [ASH_TURN_IDENTITY_ENV.directionToken]: id.directionToken,
    [ASH_TURN_IDENTITY_ENV.turnTicket]: id.turnToken,
    [ASH_TURN_IDENTITY_ENV.directionTicket]: id.directionToken,
  };
}

/**
 * 把身份从一份 env 里**显式清掉**(置 `undefined`,spawn 层据此不往子进程传)。
 *
 * 返回新对象,不改入参。调用方一律 `env: withoutTurnIdentity({ ...runEnv })` 这么写 ——
 * 自己列名字的写法在加名字那天会悄悄失效。
 */
export function withoutTurnIdentity<T extends Record<string, string | undefined>>(
  env: T,
): T & Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of ASH_TURN_IDENTITY_ENV_KEYS) out[key] = undefined;
  return out as T & Record<string, string | undefined>;
}

/** MCP 子进程要拿到的那几个变量名(codex 的 `env_vars` 白名单按它声明)。 */
export const TURN_IDENTITY_ENV_KEYS = ASH_TURN_IDENTITY_ENV_KEYS;

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
//
// **身份不止走变量**:还有一条搭 `PATH` 的备用通路,给「只把 PATH 交给 MCP 子进程」的那几家
// (copilot)。约定本体在 `@ash/shared/mcp` 的 `ASH_TURN_IDENTITY_PATH_DIR`,它和那五个变量
// 受同一条规矩约束 —— **设和清都只走这里**,所以两个函数各自把 `PATH` 也办了,调用点一个字
// 都不用改(这正是不加第三个导出函数的理由:加一个就等于在五处之外再开五个漏点)。
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  ASH_TURN_IDENTITY_ENV, ASH_TURN_IDENTITY_ENV_KEYS, ASH_TURN_IDENTITY_FILE,
  ASH_TURN_IDENTITY_PATH_DIR, isTurnIdentityPathEntry,
} from "@ash/shared/mcp";
import { augmentedEnv } from "./executors/bin-resolve.js";
import { RUNS_DIR } from "./paths.js";

export interface TurnIdentity {
  taskId: string;
  turnToken: string;
  directionToken: string;
}

/**
 * 这一回合那份身份文件所在的目录(顺手清掉别的回合那几份)。写不出来回 null。
 *
 * 为什么**按回合**开目录、而且开新的就删旧的:上一回合的 MCP 子进程若还活着,它手里那条
 * 路径就此作废、读到的是空 —— 绝不会是**这一回合**的令牌。按任务开一个固定目录做不到这件事
 * (那等于把一张还能用的通票留给上一回合的残留进程)。
 *
 * 写不出来**不拖垮这一回合**:变量那条主通路照旧好着,只有「只继承 PATH」的那几家交不了卷,
 * 而那正是它们没有这条桥之前的样子。但要留一行看得见的痕迹,别让它变成静默降级。
 */
function materializeIdentityDir(id: TurnIdentity): string | null {
  const root = join(RUNS_DIR, id.taskId, ASH_TURN_IDENTITY_PATH_DIR);
  const dir = join(root, id.turnToken);
  try {
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o700);
    for (const name of readdirSync(root)) {
      if (name !== id.turnToken) rmSync(join(root, name), { recursive: true, force: true });
    }
    const body = `${JSON.stringify({
      taskId: id.taskId, turnToken: id.turnToken, directionToken: id.directionToken,
    }, null, 2)}\n`;
    writeFileSync(join(dir, ASH_TURN_IDENTITY_FILE), body, { encoding: "utf8", mode: 0o600 });
    return dir;
  } catch (e) {
    console.warn(`[turn-identity] 回合身份文件没落下来(${dir}):${String(e)} —— `
      + "只继承 PATH 的那几家(copilot)这一轮交不了卷,变量那条通路不受影响");
    return null;
  }
}

/** 把 `PATH` 里**别的回合**那几段摘掉,再(可选)把这一回合那段追加到**末尾**。 */
function rewritePath(base: string, add: string | null): string | null {
  const parts = base.split(delimiter).filter(Boolean);
  const kept = parts.filter((entry) => !isTurnIdentityPathEntry(entry));
  if (!add) return kept.length === parts.length ? null : kept.join(delimiter);
  return [...kept, add].join(delimiter);
}


/**
 * 这一回合的身份:五个变量(两套名字同值)+ `PATH` 上那条备用通路。
 *
 * `PATH` 这一段是给「只把 `PATH` 交给 MCP 子进程」的那几家用的(copilot 文档明写其余变量
 * 必须写死在登记里,而写死就是过期的假身份)。约定本体与四条安全要点见 `@ash/shared/mcp`
 * 的 `ASH_TURN_IDENTITY_PATH_DIR`;认得它的是 `mcp/src/runtime.ts`。
 *
 * 底座那份 `PATH` 先过一遍筛子:**ash 自己可能就是从一个 ash 任务里起来的**,那时继承到的
 * `PATH` 里带着**那条任务**的身份目录 —— 不筛掉就是一条跨任务借身份的暗路。
 */
export function turnIdentityEnv(id: TurnIdentity): Record<string, string> {
  const vars = {
    [ASH_TURN_IDENTITY_ENV.taskId]: id.taskId,
    [ASH_TURN_IDENTITY_ENV.turnToken]: id.turnToken,
    [ASH_TURN_IDENTITY_ENV.directionToken]: id.directionToken,
    [ASH_TURN_IDENTITY_ENV.turnTicket]: id.turnToken,
    [ASH_TURN_IDENTITY_ENV.directionTicket]: id.directionToken,
  };
  const path = rewritePath(augmentedEnv().PATH ?? "", materializeIdentityDir(id));
  return path === null ? vars : { ...vars, PATH: path };
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
  // `PATH` 上那条通路也要摘干净,道理和上面那段注释一字不差:子进程默认继承 server 自己的
  // 环境,而 ash 从一个 ash 任务里启动时那份 `PATH` 里**就带着**那条任务的身份目录。
  // 没有可摘的就一个字都不动 —— 这几条路的行为必须与这条桥上线前逐字节一致。
  const path = rewritePath(out.PATH ?? augmentedEnv().PATH ?? "", null);
  if (path !== null) out.PATH = path;
  return out as T & Record<string, string | undefined>;
}

/** MCP 子进程要拿到的那几个变量名(codex 的 `env_vars` 白名单按它声明)。 */
export const TURN_IDENTITY_ENV_KEYS = ASH_TURN_IDENTITY_ENV_KEYS;

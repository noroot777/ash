// 这一个 MCP 进程代表哪条任务的哪一回合说话 —— 从环境里挑出回合身份。从 runtime.ts 拆出来是
// 为了能被单独喂一份环境来测（runtime.ts 一加载就读 process.env、改 NO_PROXY）。
//
// 身份有三条通道：正名变量、别名变量（`*_TICKET`）、`PATH` 上的身份文件；约定本体见
// `@navi/shared/mcp` 的 `NAVI_TURN_IDENTITY_ENV` / `NAVI_TURN_IDENTITY_PATH_DIR`，写的一侧是
// `server/src/turn-identity.ts`。
//
// 登记里带了回合指纹（`@navi/shared/turn-fingerprint`，navi 起跑时注入 claude / codex 的那份）
// 就只认对得上指纹的那份：三条通道里任何一条都可能被 CLI 配置换成旧值，而指纹不会。没带指纹
// （navi 不注入的那几家，走它们自己配置里的登记）照旧按「正名 → 别名 → PATH」逐项取。
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { envNameGenerations, readEnv, type NaviEnvName } from "@navi/shared/env-names";
import { NAVI_TURN_IDENTITY_ENV, NAVI_TURN_IDENTITY_FILE, isTurnIdentityPathEntry } from "@navi/shared/mcp";
import { NAVI_TURN_FINGERPRINT_ENV, NAVI_TURN_FINGERPRINT_NONE, turnFingerprint } from "@navi/shared/turn-fingerprint";

export interface ResolvedTurnIdentity {
  taskId: string;
  turnToken: string;
  directionToken: string;
}

type Env = Record<string, string | undefined>;
type Partial3 = { taskId?: string; turnToken?: string; directionToken?: string };

const EMPTY: ResolvedTurnIdentity = { taskId: "", turnToken: "", directionToken: "" };

/**
 * `PATH` 上每一段身份目录里的那份 `identity.json`。读不出来一律当没有（目录可能已经被下一回合
 * 清掉了 —— 那正是设计意图：宁可交不了卷，也不能让上一回合的残留进程拿到当前令牌）。
 */
function identitiesFromPath(path: string | undefined): Partial3[] {
  const found: Partial3[] = [];
  for (const entry of (path ?? "").split(delimiter)) {
    if (!entry || !isTurnIdentityPathEntry(entry)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(entry, NAVI_TURN_IDENTITY_FILE), "utf8")) as Record<string, unknown>;
      const str = (key: string): string | undefined => {
        const value = raw[key];
        return typeof value === "string" && value.trim() ? value.trim() : undefined;
      };
      const one = { taskId: str("taskId"), turnToken: str("turnToken"), directionToken: str("directionToken") };
      if (one.taskId && one.turnToken) found.push(one);
    } catch { /* 这一段读不出来就继续找下一段 */ }
  }
  return found;
}

const uniq = (values: (string | undefined)[]): string[] =>
  [...new Set(values.map((v) => v?.trim() ?? "").filter(Boolean))];

/**
 * 一个身份变量的各代名字（`NAVI_TASK_ID`、`ASH_TASK_ID`…）在这份环境里的值，新名在前。升级前起的
 * 会话里是旧名；新旧都在而值不同时两个都进候选，由指纹挑（没指纹时新名在前）。
 */
const generations = (env: Env, name: string): (string | undefined)[] =>
  envNameGenerations(name as NaviEnvName).map((key) => env[key]);

/**
 * 挑出这一回合的身份。`refused` 非空 = 登记带了指纹、却没有哪份身份对得上：MCP 应当拒绝启动
 * （见 main.ts），让 CLI 报「navi 没接上」，而不是带着别的回合的令牌连上、到交卷才被拒。
 */
export function resolveTurnIdentity(env: Env): ResolvedTurnIdentity & { refused: string | null } {
  const fromPath = identitiesFromPath(env.PATH);
  // 每一项的候选按「正名 → 别名 → PATH」排：没带指纹时取第一个，带了指纹时也按这个顺序试。
  const taskIds = uniq([...generations(env, NAVI_TURN_IDENTITY_ENV.taskId), ...fromPath.map((p) => p.taskId)]);
  const turnTokens = uniq([
    ...generations(env, NAVI_TURN_IDENTITY_ENV.turnToken), ...generations(env, NAVI_TURN_IDENTITY_ENV.turnTicket),
    ...fromPath.map((p) => p.turnToken),
  ]);
  const directionTokens = uniq([
    ...generations(env, NAVI_TURN_IDENTITY_ENV.directionToken), ...generations(env, NAVI_TURN_IDENTITY_ENV.directionTicket),
    ...fromPath.map((p) => p.directionToken),
  ]);

  const fingerprint = readEnv(env, NAVI_TURN_FINGERPRINT_ENV as NaviEnvName)?.trim();
  if (!fingerprint) {
    // 逐项取，不整组取：有的 CLI 只删带 TOKEN 字样的那两个（gemini），`NAVI_TASK_ID` 是过得去的。
    return { taskId: taskIds[0] ?? "", turnToken: turnTokens[0] ?? "", directionToken: directionTokens[0] ?? "", refused: null };
  }
  if (fingerprint === NAVI_TURN_FINGERPRINT_NONE) return { ...EMPTY, refused: null };

  // 令牌两项都可以是空串：团队调度台的身份只有任务 id（见 `turnFingerprint`）。空串排在最后，
  // 所以单飞回合不会被它挑中；团队那份也就不会捎上配置里残留的旧令牌。
  for (const taskId of taskIds) {
    for (const turnToken of [...turnTokens, ""]) {
      for (const directionToken of [...directionTokens, ""]) {
        if (turnFingerprint({ taskId, turnToken, directionToken }) === fingerprint) {
          return { taskId, turnToken, directionToken, refused: null };
        }
      }
    }
  }
  const seen = taskIds.length || turnTokens.length ? `收到的 ${taskIds.length} 个任务 id、${turnTokens.length} 个回合令牌` : "一份身份都没收到";
  return {
    ...EMPTY,
    refused: `回合身份对不上 Navi 注入的回合指纹（${seen}）：多半是 CLI 配置里写死了 `
      + `${NAVI_TURN_IDENTITY_ENV.taskId} / ${NAVI_TURN_IDENTITY_ENV.turnToken} 这类变量（claude 的 settings.json 里的 env、`
      + "codex 的 [mcp_servers.navi.env]），盖掉了这一回合的身份。删掉那几项再重跑",
  };
}

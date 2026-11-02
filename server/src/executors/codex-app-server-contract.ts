// Codex app-server 适配器的**契约与常量**:对外的 `CodexAppServerOpts`、用量那几个形状,
// 以及两条「期限/诊断」常量。
//
// 从 `codex-app-server.ts` 拆出来的理由同 `codex-app-server-state.ts` / `-adopt.ts`:那份文件
// 顶到了单文件上限(根 CLAUDE.md 的 700 行)。这一块自成一块 —— 它不碰协议收发,只回答「调用方
// 要交什么、我们按什么期限和什么措辞收口」。
import type { ChildProcess } from "node:child_process";
import type { TokenUsage } from "@ash/shared";
import type { CliCommand, CliGoal, CliSessionState } from "@ash/shared/cli-commands";
import type { MarkdownImageAccounting } from "./markdown-image-stream.js";
import type { RunTracePaths } from "./diagnostics.js";
import type { DetachedPaths } from "./detached.js";

/**
 * `turn/start` 的**应答期限**。它只是「收下了,这一轮叫这个 id」,正常几百毫秒就回来;一分钟
 * 还不回来而连接又好着,就是那条「谁都不会再说话」的缝(第 3 轮自由审查 F3 实测形状)。
 *
 * 超时**不等于**启动失败:有 `turn/started` 凭据就按「它在飞」继续(见 turn/start 那段)。
 * 环境变量只给回归脚本用 —— 真实运行一律用默认值。
 */
export const CODEX_TURN_START_ACK_MS = (() => {
  const raw = Number(process.env.ASH_CODEX_TURN_START_ACK_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
})();

/**
 * 接管后**重读协议日志**的节奏(毫秒)。真实默认 2 秒;回归脚本压到几十毫秒,否则那条
 * 「读不出来也得有人负责」的提示要等十秒才出现(见 ./codex-app-server-adopt.ts 的
 * `wireAdoptionRecovery`)。前几拍按这个节奏,之后翻倍退避封顶,核验不设上限。
 */
export const CODEX_ADOPT_REREAD_MS = (() => {
  const raw = Number(process.env.ASH_CODEX_ADOPT_REREAD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
})();

/**
 * 「确证这一轮从未启动」那段诊断。**起跑时就读出这一档**和**接管后重读才读出来**说的是同一
 * 件事,所以只能有一份话(第 3 轮自由审查 F3:重读那条路从前连结算都没有)。
 */
export const ADOPT_NEVER_STARTED =
  "重启接管这条 Codex 会话时，协议日志里没有任何「回合已开始」的凭据（线程已恢复、回合从未启动）"
  + "——上一个服务端死在「恢复会话」与「送出回合输入」之间，这一轮的输入一个字都没到 agent。"
  + "本轮按失败结算，原文仍在待发送里，稍后会自动重新投递；也可以直接重试。";

export type TokenBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ThreadUsage = {
  total: TokenBreakdown;
  last: TokenBreakdown;
  modelContextWindow: number | null;
};

export type CodexAppServerOpts = {
  bin: string;
  args: string[];
  cwd: string;
  prompt: string;
  cliCommand?: CliCommand;
  cliState?: CliSessionState;
  sessionId?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  env?: Record<string, string | undefined>;
  trace?: RunTracePaths;
  detach?: DetachedPaths;
  /** 正文图片的持久账本/身份种子(RunOpts.images),见 markdown-image-stream.ts。 */
  images?: MarkdownImageAccounting;
  commandLine?: string;
  reattach?: {
    threadId: string; turnId: string; reviewTurnId?: string;
    completedTurn?: { id: string; status: string; error?: unknown }; goal?: CliGoal | null;
    /** 协议日志给出的三档(见 ./codex-app-server-state.ts)。缺省按「确证没启动」—— 那是老调用方的口径。 */
    evidence?: "started" | "never-started" | "unreadable";
    /**
     * **再读一次协议日志**。只有「读不出来」那一档用得上:身份的有界恢复靠它
     * (见 ./codex-app-server-adopt.ts 的 recoverAdoptedIdentity)。不给 = 不恢复,
     * 那一档就只剩「认领完成事件」这条路。
     *
     * `evidence` 必须带上:重读的价值一半在肯定(拿回身份)、一半在否证(`never-started`
     * ⇒ 按确证未启动收口)。少了它,否证永远走不到拒收那条路(第 3 轮自由审查 F3)。
     */
    reread?: () => {
      turnId: string;
      reviewTurnId?: string;
      completedTurn?: { id: string; status: string; error?: unknown };
      evidence: "started" | "never-started" | "unreadable";
    };
  };
  startProcess?: () => ChildProcess;
};


export function usageEvent(value: TokenBreakdown): TokenUsage {
  return {
    input: Math.max(0, value.inputTokens - value.cachedInputTokens),
    output: value.outputTokens,
    cacheRead: value.cachedInputTokens,
    cacheWrite: 0,
    reasoning: value.reasoningOutputTokens,
    costUsd: null,
    turns: 1,
  };
}

/** 工具正文/参数落 trace 前的长度闸(超长原样截断,留一个省略号)。 */
export const short = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > 1_500 ? `${text.slice(0, 1_497)}…` : text;
};

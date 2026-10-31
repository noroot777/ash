// 回合级停滞那几条测试共用的夹具。
//
// 为什么抽出来:判据那一组(什么算「上游真回话了」、什么解除停滞)和两档动手那一组各自都长到
// 够一个文件了,而 `configure` 这种「每段各自设口径」的东西**不能有两份** —— 两份就会漂,
// 而那正是这套判据最怕的事(整个 `shared/src/waiting.ts` 存在的理由就是不让判据分叉)。
import type { AgentEvent } from "@ash/shared";
import { __resetTurnStalls, type StallActions, type StallFacts } from "../src/turn-stall.js";
import { __resetStallFailures } from "../src/turn-stall-verdict.js";

export const TURN = "2026-10-30T07:36:21.000Z";
export const RETRY = "Reconnecting... waiting for network";
export const notice = (message = RETRY): AgentEvent => ({ kind: "error", message, level: "notice", affectsTurn: false });
export const hard = (message: string): AgentEvent => ({ kind: "error", message });
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Log = {
  warns: { text: string; facts: StallFacts }[];
  trips: string[];
  escalations: string[];
  /** 撤标记时拿到的回合身份 —— 库里那一侧按它做 CAS(session-stall-flag.ts),所以得钉住。 */
  resolves: string[];
};
export function spy(taskId = "task-1"): { actions: StallActions; log: Log } {
  const log: Log = { warns: [], trips: [], escalations: [], resolves: [] };
  return {
    log,
    actions: {
      taskId,
      warn: (text, facts) => log.warns.push({ text, facts }),
      trip: (text) => log.trips.push(text),
      escalate: (text) => log.escalations.push(text),
      resolve: (facts) => log.resolves.push(facts.turnStartedAt),
    },
  };
}

/** 每段各自设口径,免得上一段的 env 漏到下一段。各档 0 = 关掉。 */
export function configure(opts: {
  warnErrors?: number; warnMs?: number; tripMs?: number; graceMs?: number; pollMs?: number;
}) {
  __resetTurnStalls();
  __resetStallFailures();
  process.env.ASH_STALL_WARN_ERRORS = String(opts.warnErrors ?? 0);
  process.env.ASH_STALL_WARN_MS = String(opts.warnMs ?? 0);
  process.env.ASH_STALL_TRIP_MS = String(opts.tripMs ?? 0);
  process.env.ASH_STALL_TRIP_GRACE_MS = String(opts.graceMs ?? 0);
  process.env.ASH_STALL_POLL_MS = String(opts.pollMs ?? 20);
}

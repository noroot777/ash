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
  /** 撤标记时拿到的回合身份。 */
  resolves: string[];
  /** 撤标记时拿到的**停滞身份** —— 库里那一侧按它做 CAS(session-stall-flag.ts),所以得钉住。 */
  resolveSince: string[];
  /** 持久投影被叫了几次 —— 它跟「通知」是两件事,失败要能重投(N1)。 */
  projects: StallFacts[];
};
/** `projectFails` = 前几次投影报失败,用来钉「没确认就重投」。 */
export function spy(taskId = "task-1", projectFails = 0): { actions: StallActions; log: Log } {
  const log: Log = { warns: [], trips: [], escalations: [], resolves: [], resolveSince: [], projects: [] };
  let failures = projectFails;
  return {
    log,
    actions: {
      taskId,
      warn: (text, facts) => log.warns.push({ text, facts }),
      project: (facts) => {
        log.projects.push(facts);
        if (failures <= 0) return Promise.resolve(true);
        failures -= 1;
        return Promise.resolve(false);
      },
      trip: (text) => log.trips.push(text),
      escalate: (text) => log.escalations.push(text),
      resolve: (facts) => { log.resolves.push(facts.turnStartedAt); log.resolveSince.push(facts.since); },
    },
  };
}

/**
 * 每段各自设口径,免得上一段的 env 漏到下一段。各档 0 = 关掉。
 *
 * **静默档也在这里一起归零**(`silentWarnMs`/`silentTripMs`):不然错误档那几段一挂上静默观察
 * 就会被另一档抢着报警,红的是夹具而不是判据。
 */
export function configure(opts: {
  warnErrors?: number; warnMs?: number; tripMs?: number; graceMs?: number; pollMs?: number;
  silentWarnMs?: number; silentTripMs?: number;
}) {
  __resetTurnStalls();
  __resetStallFailures();
  process.env.ASH_STALL_WARN_ERRORS = String(opts.warnErrors ?? 0);
  process.env.ASH_STALL_WARN_MS = String(opts.warnMs ?? 0);
  process.env.ASH_STALL_TRIP_MS = String(opts.tripMs ?? 0);
  process.env.ASH_STALL_TRIP_GRACE_MS = String(opts.graceMs ?? 0);
  process.env.ASH_STALL_SILENT_WARN_MS = String(opts.silentWarnMs ?? 0);
  process.env.ASH_STALL_SILENT_TRIP_MS = String(opts.silentTripMs ?? 0);
  process.env.ASH_STALL_POLL_MS = String(opts.pollMs ?? 20);
}

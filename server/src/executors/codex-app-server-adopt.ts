// 接管一个**还活着**的 app-server 进程时的两个判断:**这一轮的输入送出去了没有**,以及
// **这一轮的身份是什么**。
//
// 从 `codex-app-server.ts` 拆出来的理由同 `codex-app-server-state.ts`:那份顶到了单文件上限
// (根 CLAUDE.md 的 700 行),而这一件事自成一块 —— 它只回答「接回来的这一轮,我凭什么说它
// 启动过/没启动过/说不上来」。协议收发、事件推送、原生子代理都不在这里。
//
// ── 为什么「进程还在」什么都证明不了 ──────────────────────────────────────────
//
// 回合输入是 spawn 之后再走协议发出去的(`initialize` → `thread/unarchive` → `thread/resume`
// → `turn/start`),服务端要是死在最后那一步**之前**,新服务端按 pid 认回来的就是一个「会话
// 已恢复、回合从未开始」的闲置进程:它不会说话,我们也不会再对它说话。旧代码在这里给的是
// `Promise.resolve()`,于是接管之后既没有驱动也没有超时,`finish` 的四个触发源(连接关闭、
// 流收尾兜底、`turn/completed`、`ready` 失败)一个都不会来。2026-11-02 任务 WfLfTjaGzcA8 就卡
// 在这里 1.5 小时:零输出、零报错、界面一直「当前回合仍在进行」,看门狗也没形状可认。
//
// 凭据在协议日志里:**这个 thread 上出现过 turn 开始记录** —— `turn/started` 通知,或
// `turn/start` / review 的**应答**(两类都认,见 `readCodexAppServerState`;只认通知的那一版会
// 把「应答已落盘、通知还没来」的健康回合当场杀掉,第 1 轮自由审查 F5)。三档各走各的路:
//   · 有凭据      → 回合确实在飞,什么都不做,等它自己把 `turn/completed` 发出来;
//   · 确证没凭据  → 输入从未到达 agent,**当场按失败结算**:`ready` 抛出去之后 `finish(1, …)`
//     落红字诊断、收掉这个闲置进程。原文那一半由投递侧负责(它在 agent 点头之前不落 `sent`,
//     见 ../turn-input-acceptance.ts);
//   · **读不出来**→ 「核实不了」,不是「没启动」:拿一个核实不了的前提去杀一个可能完全健康的
//     agent 比让它跑完更坏。
//
// 为什么不是「幂等重发一次回合输入」:重发要的是**这一轮完整的那串字**(任务书 + 每回合提醒 +
// 完成协议,见 ../turn-prompt.ts),而接管这条路上只有一个进程句柄,手头压根没有它;按会话行
// 反解出来的半截 prompt 比按失败重试更坏。走失败结算,重投那一趟由 `continueTask` 原样重拼。
//
// ── 「读不出来」这一档不许冒充成功(第 2 轮自由审查 F4)────────────────────────
//
// 上一版把它做成了「`ready` 直接 resolve」,而那条路顺手带来两个假结论:
//   ① 回执报成 `accepted` —— 投递侧据此落终态 `sent`。可我们压根不知道那串字到没到,这正是
//      这整条链要消灭的那种「拿自己的记账当对方的确认」;
//   ② 身份留空(`turnId = ""`)—— 随后真正属于这一轮的 `turn/completed` 在 `completeTurn` 的
//      身份检查上被丢掉,于是**连「它答完了」都不会结算**:常驻进程还活着,进展记号又是 `seen`
//      (重启前确实产出过),静默档按判据不该开 —— 需求明令禁止的无界等待就这么回来了。
//
// 所以这一档现在是:回执 `unknown`(说不上来,投递侧留在在途、不写终态),身份**有界恢复** ——
// 隔一会儿重读协议日志,拿回 turnId 就算补上了;真等到完成事件而身份仍然空着,就认它
// (`adoptCompletion`):那一刻这个 thread 上唯一在飞的回合就是我们接回来的这一轮。
import type { InputAcceptance } from "./types.js";

/** 协议日志给出的三档(产出方见 ./codex-app-server-state.ts)。 */
export type AdoptEvidence = "started" | "never-started" | "unreadable";

export interface AdoptedTurn {
  turnId: string;
  reviewTurnId?: string;
  completedTurn?: { id: string; status: string; error?: unknown };
  evidence?: AdoptEvidence;
}

/**
 * 这一轮**确有凭据说它已经开跑**。注意 `evidence` 不参与这一问:凭据就是那三个字段本身,
 * `evidence` 只区分剩下两档(确证没启动 / 读不出来)。
 */
export function adoptionDriven(reattach: AdoptedTurn | undefined): boolean {
  return !!reattach && (!!reattach.turnId || !!reattach.reviewTurnId || !!reattach.completedTurn);
}

/** 接管了,但**核实不了**这一轮启动过没有(日志权限/IO/被截断)。 */
export function adoptionUnverifiable(reattach: AdoptedTurn | undefined): boolean {
  return !!reattach && !adoptionDriven(reattach) && reattach.evidence === "unreadable";
}

/**
 * 「这一轮的输入到底有没有进 agent 手里」的**单调账本**(三档语义见 ./types.ts 的
 * `InputAcceptance`)。
 *
 * 两位都是单调的,顺序也只能从下往上读:
 *   · `reached()` —— 看到过本回合的开始凭据(`turn/start` 应答 **或** 先到的 `turn/started`
 *     通知)。一旦为真,后面怎么断链都是 `accepted`:那串字已经出去了,退回重投就是重复执行。
 *   · `wrote()`   —— 回合输入已经写进 stdin,只是还没拿到应答。断链落在这之后 = `unknown`
 *     (说不上来),落在这之前 = `refused`(协议从头没通,确证一个字都没出去)。
 * 这正是第 1 轮自由审查 F4 要钉的那条线:把 `ready` 的 reject 一律读成「没送出去」会把已经
 * 开跑的回合的输入再送一遍。
 */
export function createTurnInputLedger(): {
  wrote(): void;
  reached(): void;
  acceptanceOf(ready: Promise<unknown>, unverifiable: boolean): Promise<InputAcceptance>;
} {
  let written = false;
  let reached = false;
  return {
    wrote: () => { written = true; },
    reached: () => { reached = true; },
    acceptanceOf: (ready, unverifiable) => ready.then(
      // `ready` 成功**不等于**送到了:接管时「读不出来」那一档也让它 resolve,而那一档我们
      // 什么都不知道 —— 报 `unknown`,别把自己的放行当成对方的确认(第 2 轮自由审查 F4)。
      (): InputAcceptance => (unverifiable && !reached ? "unknown" : "accepted"),
      (): InputAcceptance => (reached ? "accepted" : written ? "unknown" : "refused"),
    ),
  };
}

/**
 * **身份的有界恢复**:协议日志刚才读不出来,过一会儿再读几次。
 *
 * 为什么有界而不是一直重读:这一档的作用是把「一瞬的 I/O 故障」跟「这份日志真的没了」分开,
 * 前者几秒内就会自己好。拿回身份(或拿回一条完成记录)就停;几次都读不出来就停下并说一句 ——
 * 剩下那条路是等 `adoptCompletion` 认领完成事件。
 *
 * 计时器一律 `unref`:它绝不该让进程多活一毫秒(同 ../turn-input-acceptance.ts 的有界等待)。
 */
export function recoverAdoptedIdentity(
  reread: () => AdoptedTurn,
  apply: (state: AdoptedTurn) => boolean,
  onGiveUp: () => void,
  opts: { attempts?: number; everyMs?: number } = {},
): void {
  const attempts = opts.attempts ?? 5;
  const everyMs = opts.everyMs ?? 2_000;
  let left = attempts;
  const tick = (): void => {
    left -= 1;
    let state: AdoptedTurn;
    try {
      state = reread();
    } catch {
      state = { turnId: "", evidence: "unreadable" }; // 读本身抛了:跟读不出来同档
    }
    if (adoptionDriven(state) && apply(state)) return;
    if (left <= 0) { onGiveUp(); return; }
    const timer = setTimeout(tick, everyMs);
    timer.unref?.();
  };
  const first = setTimeout(tick, everyMs);
  first.unref?.();
}

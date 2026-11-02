// 「原话**真的进了 agent 手里**吗」—— 投递记账唯一该等的那一个回执。
//
// 起因(2026-11-02,任务 WfLfTjaGzcA8 会话 GfmgWfE9zosC):哨兵唤醒消息 qHTNS7UJ41M3 在
// 23:31:20 被标成 `sent`,同一秒 spawn 了 codex app-server;23:31:21 codex 回完
// `resumeThread` 之后 agent-out 再没有一行;23:31:24 用户重启 :4317 —— 旧服务端正好死在
// 「恢复线程」与「送出回合输入」的空当里,**那一轮的输入从未写进 codex 的 stdin**。接下来
// 1.5 小时零输出零报错,而库里那条消息已经是终态 `sent`:补发扫描只看 `pending`,从此再也
// 没有任何人会把那句话重新投一遍。这是 hprbvyaE Bug 1「承诺的重投丢失」的重启变体。
//
// 根因不在「标早了几百毫秒」,而在**判据用错了事实**:`markSent` 等的是 `run()` 返回,而
// `run()` 返回只证明进程起来了。对大多数执行器这两件事确实是同一件(prompt 在 spawn 那一刻
// 就随 argv/stdin 交出去了),但 codex app-server 的回合输入是 spawn **之后**再走 JSON-RPC
// 发出去的,于是「进程起来了」和「输入送到了」中间裂开了一条真实窗口。
//
// 所以这里把那条缝补成一个显式三态(回执本体见 executors/types.ts 的 `inputAccepted`):
//   · accepted —— 协议层面收下了(或这个执行器压根没有这条缝)→ 落 `sent`;
//   · refused  —— **确证**一个字都没进去 → 不落 `sent`,行留在 `pending`、租约归还,立刻重投;
//   · unknown  —— 说不上来(输入已经写出去、应答还没回来就断链;或者有界等待之内没落定)。
//
// **`unknown` 不许被提升成 `sent`**(第 1 轮自由审查 F3,实测:垫片只读 `initialize` 不应答,
// 消息却已经 `status=sent` + `sentAt`)。那一版的理由是「不拿一次不确定的归还换一次重复执行」
// —— 方向对,落点错:不该归还,但更不该写**终态**。证据超时不能提升为成功事实,而 `sent` 是
// 终态、补发扫描只看 `pending`,写下去那句话就永久消失了;看门狗后来能终止坏回合,却不会把
// 一条已经 `sent` 的消息变回 `pending`。
//
// 所以 `unknown` 走第三条路:**留在「在途」**—— 既不写 `sent`,也不还租约(还了就立刻重投,
// 那才是重复执行)。带租约的 `pending` 行正是本仓既有的「在途」表示法(见 pending-messages.ts
// 的租约三步与 `reclaimStaleDeliveries` 对续跑凭证的特判)。两个出口:
//   · 迟到的凭据 —— 回执最终落定成 `accepted` 就补记那一笔(`settleLateTurnInput`);
//   · 进程没了 —— 开机 `reclaimStaleDeliveries` 清租约、按既有口径重投一次(用户打的字宁可
//     重发;agent 自己的续跑凭证另走 checkpoint 对账,不会被误重放)。
//
// 为什么等在这里、而不是把 `onDelivered` 推迟到回合结束之后再问:托盘上那条消息在标 `sent`
// 之前一直显示「排队中」,而回合可能跑几十分钟 —— 一条早就在会话里的话挂着「排队中」挂半小时
// 是另一种撒谎。`inputAccepted` 正常在几百毫秒内落定,等它是最便宜的那个位置。
import type { InputAcceptance, RunHandle } from "./executors/types.js";

// 三档本身定在执行器契约里(判出它们的是协议适配器),这里只做有界等待那一层。
export type { InputAcceptance } from "./executors/types.js";

/** 有界等待的上限。`<= 0` 或配成非数 = 退回默认值(看门狗那边同一个口径,见 turn-stall.ts 的 num)。 */
function ackTimeoutMs(): number {
  const raw = process.env.ASH_TURN_INPUT_ACK_MS;
  if (raw == null || raw === "") return 60_000;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 60_000;
}

/**
 * 等这一轮的输入回执。`inputAccepted` 没有 = 这个执行器在 spawn 那一刻就把输入交出去了,
 * 当场 `accepted`(**零额外延迟**,claude 与目录里那十家都走这一支)。
 */
export async function awaitTurnInput(
  handle: Pick<RunHandle, "inputAccepted">,
): Promise<InputAcceptance> {
  const receipt = handle.inputAccepted;
  if (!receipt) return "accepted";
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      // 回执**自己就是三态**(executors/types.ts):这一层只负责「别无限期等」。它抛了说明
      // 适配器自己炸了(不是「没送达」)—— 那也只能是 unknown,别替它下结论。
      receipt.catch((): InputAcceptance => "unknown"),
      new Promise<InputAcceptance>((resolve) => {
        timer = setTimeout(() => resolve("unknown"), ackTimeoutMs());
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `unknown` 之后**接着等那份凭据**,三档一律回传。
 *
 * 上一版只回传 `accepted`、把 `refused`/`unknown` 一起丢掉 —— 而「迟到的拒收」正是那条缝里
 * 最常见的结局(握手超时在前,进程断开在后):丢掉它之后那张租约就永远留在「在途」,消息停在
 * 待发送、任务已经失败、再扫一遍也领不走,只有重启能解(第 2 轮自由审查 F3,已实测)。
 *
 * 不阻塞调用方 —— 有界等待那一层存在的理由就是不让投递链挂在一个可能永不落定的回执上。
 * 落定成 `unknown` 这里什么都不做:那一档只能等开机对账(见文件头两个出口)。
 */
export function settleLateTurnInput(
  handle: Pick<RunHandle, "inputAccepted">,
  label: string,
  onSettled: (acceptance: InputAcceptance) => Promise<void> | void,
): void {
  const receipt = handle.inputAccepted;
  if (!receipt) return;
  void receipt
    .then(async (acceptance) => {
      if (acceptance === "unknown") return;
      console.warn(`[ash] ${label} 迟到的回执落定成 ${acceptance === "accepted" ? "「agent 收下了」" : "「协议层拒收」"}，按它收口`);
      await onSettled(acceptance);
    })
    .catch((error: unknown) => {
      console.warn(`[ash] ${label} 等迟到的输入回执时出错（这一条留在在途，开机对账再判）:`, error);
    });
}

/**
 * **这一轮输入的最后一句话**:结算之前再问一次,有界。
 *
 * 为什么不能拿初次那一档去结算(第 2 轮自由审查 F1 的那一半):初次是**有界等待的结果**,
 * `unknown` 多半只是「应答还没回来」。而结算发生在回合都结束之后 —— 那时回执早就落定了
 * (进程一关,未完成的请求一律 reject)。拿过期的 `unknown` 去结算,就会把一段明确被拒收的
 * 交代结成「交付不明」,而它本该原样归还。
 *
 * `soFar` 是初次拿到的那一档:已经是终局(accepted/refused)就直接用它,不必再等。
 *
 * `receipt` 缺席 = **还没交接**(执行器没有这条缝时交的是一个显式 accepted,见
 * turn-input-settlement.ts),那就说不上来:`unknown`,交给对账去判。上一版把它读成 accepted,
 * 于是 spawn 之前就抛掉的那一轮把续跑交代当成已送达消费了(第 2 轮自由审查 F1)。
 */
export async function lastWordOnInput(
  receipt: Promise<InputAcceptance> | undefined,
  soFar: InputAcceptance | null,
  waitMs = 2_000,
): Promise<InputAcceptance> {
  if (soFar && soFar !== "unknown") return soFar;
  if (!receipt) return soFar ?? "unknown";
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      receipt.catch((): InputAcceptance => "unknown"),
      new Promise<InputAcceptance>((resolve) => {
        timer = setTimeout(() => resolve(soFar ?? "unknown"), waitMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `unknown`/`refused` 各自该说的那一句(调用方只负责记,不负责措辞)。 */
export function logTurnInputAcceptance(acceptance: InputAcceptance, label: string): void {
  if (acceptance === "refused") {
    console.warn(`[ash] ${label} 这一轮的输入没能送进 agent，原文留在待发送里等重投`);
  } else if (acceptance === "unknown") {
    console.warn(
      `[ash] ${label} 等了 ${Math.round(ackTimeoutMs() / 1000)} 秒仍拿不到「agent 收下了」的回执，`
      + "这一条按在途处理：不写已送达、也不退回重投（避免重复执行），等迟到的凭据或开机对账",
    );
  }
}

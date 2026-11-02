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
//   · accepted —— 协议层面收下了(或这个执行器压根没有这条缝)→ 照旧落 `sent`;
//   · refused  —— 一个字都没进去 → **不落 `sent`**,行留在 `pending`,由退回/重投那条路管;
//   · unknown  —— 有界等待之内没落定。此时「送到了没有」我们确实不知道,按旧口径落 `sent`
//                 (宁可晚一点被看门狗抓到,也不拿一次不确定的归还换一次重复执行),同时
//                 **大声记一行**。这一档的兜底是回合级停滞看门狗的「静默档」(turn-stall.ts):
//                 回合开起来却迟迟一条进展都没有,它会报警并最终熔断。
//
// 为什么等在这里、而不是把 `onDelivered` 推迟到回合结束之后再问:托盘上那条消息在标 `sent`
// 之前一直显示「排队中」,而回合可能跑几十分钟 —— 一条早就在会话里的话挂着「排队中」挂半小时
// 是另一种撒谎。`inputAccepted` 正常在几百毫秒内落定,等它是最便宜的那个位置。
import type { RunHandle } from "./executors/types.js";

export type InputAcceptance = "accepted" | "refused" | "unknown";

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
      receipt.then((): InputAcceptance => "accepted", (): InputAcceptance => "refused"),
      new Promise<InputAcceptance>((resolve) => {
        timer = setTimeout(() => resolve("unknown"), ackTimeoutMs());
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
      + "这一轮按已送达记账（后续由回合级停滞看门狗兜）",
    );
  }
}

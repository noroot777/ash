// 一次投递的**在途生命周期**:三档回执(`InputAcceptance`)各自该怎么处置这张租约。
//
// 为什么要收口成一份:第 2 轮自由审查 F3 实测到的洞是「`unknown` 之后迟到的拒收没人管」——
// 而那不是某一个入口写漏了,是**三个入口各写一遍**的必然结果(排队/空闲投递、定时投递、
// 真人回合转发)。各自加一次超时、各自判一次三档,就一定会各漏一处:实测那一跑里消息永久
// 停在「待发送 + 租约还在」,连任务已经 failed、再扫一遍待发送都领不走它,只有重启能解。
//
// 所以这里把那件事变成一个对象:**回执这条路负责到底**。
//   · accepted —— 落 sent(调用方给 `onAccepted`);
//   · refused  —— 确证一个字都没出去:**当场归还租约并安排重投**(调用方给 `onReturn`);
//   · unknown  —— 留在在途:不写终态 `sent`(写了那句话就永久消失,补发扫描只看 `pending`),
//     也不归还(归还即重投,那才是重复执行)。等迟到的凭据落定,或开机对账。
//
// 「初次回执」和「迟到回执」在这里**不是两条路**:同一个 `settle` 吃两次,最终那一次说了算。
// 调用方只需要问一句 `handled()` —— 「这张租约归回执这条路管了吗」:
//   · 真 → 调用点那段善后一个字都不许碰它(accepted/unknown/已经归还过);
//   · 假 → 回执压根没来过(起跑失败、异常被吞),照调用点原来的口径归还并重投。
//
// 归还本身必须幂等(`abortDelivery` 的 WHERE 带租约),因为迟到的那一次可能撞上调用点的善后。
import type { InputAcceptance } from "./executors/types.js";

export interface DeliveryLease {
  /** 接 `ContinueTaskOptions.onInputSettled`:初次与迟到都喂进来。 */
  settle(acceptance: InputAcceptance): Promise<void>;
  /** 这张租约归回执这条路管了吗(判据见文件头)。 */
  handled(): boolean;
  /** 最终落定的那一档(还没落定 = null),给调用点写日志/选措辞用。 */
  acceptance(): InputAcceptance | null;
}

export function createDeliveryLease(opts: {
  /** 日志里怎么称呼这一条(`任务 xxx 的待发送消息`)。 */
  label: string;
  /** 协议层确认收下了:落 sent。 */
  onAccepted: () => Promise<void> | void;
  /** 确证没送出去:归还租约 + 安排重投。必须幂等。 */
  onReturn: (why: string) => Promise<void> | void;
}): DeliveryLease {
  let settled: InputAcceptance | null = null;
  let returned = false;
  let inFlight = false;
  return {
    acceptance: () => settled,
    handled: () => inFlight || returned,
    settle: async (acceptance) => {
      // **终局不可翻盘**:accepted / refused 都是确证,只有 `unknown`(在途)还等后话。
      // 适配器那边的回执本来就是单调的(`reached ⇒ accepted` 永远成立,见
      // ./executors/codex-app-server-adopt.ts 的账本),这里再闭一道 —— 迟到的那一次要是
      // 跟已经定论的那一档打架,照已经定论的办,别拿一条已经落 `sent` 的行去重投。
      if (settled && settled !== "unknown") return;
      settled = acceptance;
      if (acceptance === "accepted") {
        inFlight = true;
        await opts.onAccepted();
        return;
      }
      if (acceptance === "unknown") {
        // 在途:什么都不动。两个出口 —— 迟到的凭据(就是下一次 settle)、开机对账。
        inFlight = true;
        return;
      }
      // **确证拒收**:这是唯一一档可以安全重投的。初次就拒收时调用点那段善后还没跑,
      // 这里先归还它也不冲突(归还幂等,`handled()` 随即为真,善后那一支会跳过)。
      if (returned) return;
      returned = true;
      inFlight = false;
      console.warn(`[ash] ${opts.label} 协议层明确拒收（回合输入一个字都没写出去），归还租约并重投`);
      await opts.onReturn("协议层明确拒收：回合输入一个字都没写出去，原文退回待发送");
    },
  };
}

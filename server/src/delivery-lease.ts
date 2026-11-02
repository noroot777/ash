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
//
// ── 协议定论 ≠ 副作用完成(第 3 轮自由审查 F4)────────────────────────────────
//
// 上一版把两件事挤成了一个状态:`settled` 一置,既表示「协议层说了什么」,也表示「这张租约已经
// 处置完了」。于是那一次 UPDATE 碰上库忙/短暂 I/O 失败(orchestrator 把异常吞了),这条消息就
// **永久**卡住:定论已经锁死,迟到的同档回执被终局检查挡回去,三个调用点的善后又因为
// `handled()` 为真而跳过 —— 以 refused 为例,`abortDelivery` 还没清掉租约、`scheduleRedelivery`
// 压根没执行,而常规补发扫描要求租约为空,存储恢复了也没人再碰它。
//
// 所以现在是**两个状态**:
//   · `conclusion` —— 协议事实,单调不可翻盘(accepted/refused 是定论,`unknown` 等后话);
//   · `owed`       —— 这档定论的**持久处置还欠着**。欠着就按退避一直补,直到它确认落盘。
// 两件事分开之后,「不撤回 accepted」和「别把失败咽下去」就不再互相为难:定论照旧不动,欠账
// 自己往前推。补到上限仍不成,就响亮地交给开机对账(`reclaimStaleDeliveries`),绝不假装完成。
import type { InputAcceptance } from "./executors/types.js";

/** 退避节奏:前几拍快(多半是一瞬的库忙),后面压到 15 秒一拍,总共约 64 秒。 */
const RETRY_MS = [200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 15_000, 15_000];

export interface DeliveryLease {
  /** 接 `ContinueTaskOptions.onInputSettled`:初次与迟到都喂进来。 */
  settle(acceptance: InputAcceptance): Promise<void>;
  /** 这张租约归回执这条路管了吗(判据见文件头)。 */
  handled(): boolean;
  /** 最终落定的那一档(还没落定 = null),给调用点写日志/选措辞用。 */
  acceptance(): InputAcceptance | null;
  /** 这档定论的持久处置**还欠着吗**(补偿中,或者补到上限放弃了)。 */
  owes(): boolean;
}

export function createDeliveryLease(opts: {
  /** 日志里怎么称呼这一条(`任务 xxx 的待发送消息`)。 */
  label: string;
  /** 协议层确认收下了:落 sent。必须幂等 —— 失败会原样重试。 */
  onAccepted: () => Promise<void> | void;
  /** 确证没送出去:归还租约 + 安排重投。必须幂等 —— 失败会原样重试。 */
  onReturn: (why: string) => Promise<void> | void;
  /** 退避节奏(回归脚本用;真实运行一律用默认)。 */
  retryMs?: number[];
}): DeliveryLease {
  let conclusion: InputAcceptance | null = null;
  let owed: "accepted" | "refused" | null = null;
  let disposing = false;
  let gaveUp = false;
  let returned = false;
  let inFlight = false;
  const delays = opts.retryMs?.length ? opts.retryMs : RETRY_MS;

  const WHY_RETURN = "协议层明确拒收：回合输入一个字都没写出去，原文退回待发送";

  /**
   * 把欠着的那一笔做掉。**只有真的不抛了才算完**;抛了就按退避自己排下一拍 ——
   * 排,而不是在这儿等:`settle` 的调用方(orchestrator 的那一轮)只该等第一次尝试,
   * 不该被一条 64 秒的退避链拖住。
   */
  const attemptDispose = async (attempt: number): Promise<void> => {
    const what = owed;
    if (!what || disposing) return; // 同一时刻只有一条补偿在跑(迟到的 settle 不许开第二条)
    disposing = true;
    try {
      if (what === "accepted") await opts.onAccepted();
      else await opts.onReturn(WHY_RETURN);
      owed = null;
      if (what === "refused") { returned = true; inFlight = false; }
    } catch (error) {
      const label = what === "accepted" ? "送达确认" : "租约归还";
      if (attempt >= delays.length) {
        // 放弃**不等于**假装完成:`handled()` 于此转假,这条租约交回开机对账去清
        // (`pending-messages.ts` 的 reclaimStaleDeliveries),调用点的日志也看得见。
        gaveUp = true;
        console.error(`[ash] ${opts.label} 的${label}重试 ${delays.length + 1} 次仍未落盘，`
          + "这一条留给开机对账清理:", error);
        return;
      }
      console.warn(`[ash] ${opts.label} 的${label}第 ${attempt + 1} 次没落盘，`
        + `${delays[attempt]}ms 后重试:`, error);
      const timer = setTimeout(() => { void attemptDispose(attempt + 1); }, delays[attempt]);
      timer.unref?.(); // 补偿绝不该让进程多活一毫秒(同 turn-input-acceptance.ts 的有界等待)
    } finally {
      disposing = false;
    }
  };

  return {
    acceptance: () => conclusion,
    owes: () => owed !== null || gaveUp,
    // 欠账还在补 = 仍然归这条路管;补到上限放弃了就交回去(判据见文件头最后一节)。
    handled: () => (inFlight || returned) && !gaveUp,
    settle: async (acceptance) => {
      // **终局不可翻盘**:accepted / refused 都是确证,只有 `unknown`(在途)还等后话。
      // 适配器那边的回执本来就是单调的(`reached ⇒ accepted` 永远成立,见
      // ./executors/codex-app-server-adopt.ts 的账本),这里再闭一道 —— 迟到的那一次要是
      // 跟已经定论的那一档打架,照已经定论的办,别拿一条已经落 `sent` 的行去重投。
      //
      // 但**同一档**的再来一次不是打架,是「欠账还没还」:那就接着还(见下面 dispose)。
      if (conclusion && conclusion !== "unknown" && conclusion !== acceptance) return;
      conclusion = acceptance;
      if (acceptance === "unknown") {
        // 在途:什么都不动。两个出口 —— 迟到的凭据(就是下一次 settle)、开机对账。
        inFlight = true;
        return;
      }
      if (acceptance === "accepted") {
        inFlight = true;
        if (owed === null && !gaveUp) owed = "accepted";
      } else {
        // **确证拒收**:这是唯一一档可以安全重投的。初次就拒收时调用点那段善后还没跑,
        // 这里先归还它也不冲突(归还幂等,`handled()` 随即为真,善后那一支会跳过)。
        if (returned) return;
        inFlight = true; // 归还落盘之前也归这条路管:别让调用点抢着再归还一次
        if (owed === null && !gaveUp) owed = "refused";
        console.warn(`[ash] ${opts.label} 协议层明确拒收（回合输入一个字都没写出去），归还租约并重投`);
      }
      // 只等**第一次**尝试:后面几拍由 attemptDispose 自己排(调用方是正在跑的那一轮)。
      await attemptDispose(0);
    },
  };
}

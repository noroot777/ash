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
// 调用方只需要问一句 `callerMustReturn()` —— 「这张租约该不该由我归还并重投」:
//   · 假 → 不许碰它:协议层说收下了(accepted)、或者说不上来(unknown,在途),或者拒收那一笔
//     已经归还成功了;
//   · 真 → 两种:回执压根没来过(起跑失败、异常被吞),或者**确证拒收而归还还没落盘** ——
//     归还幂等(`abortDelivery` 的 WHERE 带租约),调用点那段善后正是它此刻该走的路。
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
// 自己往前推。
//
// ── 欠账不许冒充「没送达」(第 2 轮自由审查 F1,已端到端实测)─────────────────
//
// 上一版拆了状态,出口却又把两件事合回了一个布尔:补偿重试耗尽时置 `gaveUp`,而
// `handled()` 读了它、没读 `conclusion` —— 于是**协议层明确收下、消息也真执行完了**的那一条,
// 在十次 `markSent` 写失败之后被暴露成「没人管」,三个调用点照它的口径归还租约并重投:
// 同一条消息进了两个回合,第二次才标 sent(审查实测,证据 delivery-smoke.log)。这比原来那个
// 「卡住等重启」的洞更坏 —— 它把一次记账故障变成了一次**重复执行**。
//
// 所以归还授权现在**只由协议定论说话**(`callerMustReturn`):accepted 永远答假,一次都不授权
// 归还;欠账是本地账,只能靠补偿往前推,补不动就一直补 —— 不设上限、不自行退场。进程真的没了
// 也有交接:协议事实在调用这条路之前就已经落盘(orchestrator 的 `noteDeliveryAccepted`),
// 开机对账按那张记号判「已送达」并补记,不会把它当成未送达重投(pending-checkpoint-recovery.ts)。
import type { InputAcceptance } from "./executors/types.js";

/**
 * 退避节奏:前几拍快(多半是一瞬的库忙),后面压到 15 秒一拍。**最后一拍之后按那一拍一直补**
 * (见 `attemptDispose`:不设上限、不自行退场)。
 *
 * `ASH_DELIVERY_RETRY_MS`(逗号分隔的毫秒)只给回归脚本:真实调用点一个都不传 `retryMs`,
 * 而「accepted 在补偿失败很多次之后仍然不许退回重投」这条不变量得接着真实投递链钉,按真实
 * 节奏钉一次要一分多钟(审查的端到端复现用了 63.7 秒)。真实运行一律用下面这份默认。
 */
export const DEFAULT_RETRY_MS = [200, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 15_000, 15_000];
/**
 * **空段先剔掉再转数**(第 1 轮自由审查 F4,实测):`Number("")` 是 0,于是没设这个变量时
 * `"".split(",")` 得到的那一个空段被读成 `[0]`,默认退避表一次都没用上 —— 存储一抖,补偿就按
 * 毫秒连发、刷满日志。空串、纯空格、多余的逗号同理。
 */
export function parseRetryMs(raw: string | undefined): number[] {
  const parsed = (raw ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "")
    .map(Number).filter((x) => Number.isFinite(x) && x >= 0);
  return parsed.length ? parsed : DEFAULT_RETRY_MS;
}
const RETRY_MS = parseRetryMs(process.env.ASH_DELIVERY_RETRY_MS);

export interface DeliveryLease {
  /** 接 `ContinueTaskOptions.onInputSettled`:初次与迟到都喂进来。 */
  settle(acceptance: InputAcceptance): Promise<void>;
  /**
   * 调用点**该不该**自己归还这张租约并重投(判据见文件头)。
   *
   * 只看协议定论,**不看本地欠账** —— 把两者并进一个布尔,就是第 2 轮审查 F1 那次重复执行。
   */
  callerMustReturn(): boolean;
  /** 最终落定的那一档(还没落定 = null),给调用点写日志/选措辞用。 */
  acceptance(): InputAcceptance | null;
  /** 这档定论的持久处置**还欠着吗**(补偿还在跑)。只用于观测,不参与归还授权。 */
  owes(): boolean;
  /**
   * 调用点**自己已经把这一次还掉了**(`callerMustReturn()` 授权的那一支归还成功)。
   *
   * 归还责任从此了结:租约那条补偿要是还排着,醒来就不许再碰这一行(第 1 轮自由审查 F1:
   * 外层归还成功、消息重投并被新一轮收下之后,旧补偿醒来把**新一轮**的租约清掉,同一条消息
   * 执行两遍)。库那一侧另有一道条件更新兜着(./delivery-fence.ts),这里是生命周期那一半 ——
   * 责任要交接,不能靠两边都写、指望谁写中谁算数。
   */
  callerReturned(): void;
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
  let returned = false;
  const delays = opts.retryMs?.length ? opts.retryMs : RETRY_MS;
  /** 退避到最后一拍就按那一拍一直补(见文件头:不设上限、不自行退场)。 */
  const delayFor = (attempt: number): number => delays[Math.min(attempt, delays.length - 1)]!;

  const WHY_RETURN = "协议层明确拒收：回合输入一个字都没写出去，原文退回待发送";

  /**
   * 把欠着的那一笔做掉。**只有真的不抛了才算完**;抛了就按退避自己排下一拍 ——
   * 排,而不是在这儿等:`settle` 的调用方(orchestrator 的那一轮)只该等第一次尝试,
   * 不该被一条退避链拖住。
   *
   * **没有放弃这条出口**(第 2 轮自由审查 F1):补不动就按最后一拍的节奏一直补。计时器一律
   * `unref`,所以它绝不会让进程多活一毫秒 —— 进程真的没了,交接的是落盘的协议记号 + 开机对账,
   * 不是这里打一行「留给开机对账」然后把租约暴露成「没人管」。
   */
  const attemptDispose = async (attempt: number): Promise<void> => {
    const what = owed;
    if (!what || disposing) return; // 同一时刻只有一条补偿在跑(迟到的 settle 不许开第二条)
    disposing = true;
    try {
      if (what === "accepted") await opts.onAccepted();
      else await opts.onReturn(WHY_RETURN);
      owed = null;
      if (what === "refused") returned = true;
      if (attempt > 0) console.warn(`[ash] ${opts.label} 的${what === "accepted" ? "送达确认" : "租约归还"}`
        + `在第 ${attempt + 1} 次重试时补上了`);
    } catch (error) {
      const label = what === "accepted" ? "送达确认" : "租约归还";
      const wait = delayFor(attempt);
      // 前三拍每拍都说,之后每十拍说一次:既不瞒着,也不把日志刷爆。
      if (attempt < 3 || (attempt + 1) % 10 === 0) {
        console.warn(`[ash] ${opts.label} 的${label}第 ${attempt + 1} 次没落盘，${wait}ms 后继续补`
          + `${what === "accepted" ? "（协议层已经收下这一轮，这条绝不会被退回重投）" : ""}:`, error);
      }
      const timer = setTimeout(() => { void attemptDispose(attempt + 1); }, wait);
      timer.unref?.(); // 补偿绝不该让进程多活一毫秒(同 turn-input-acceptance.ts 的有界等待)
    } finally {
      disposing = false;
    }
  };

  return {
    acceptance: () => conclusion,
    owes: () => owed !== null,
    callerReturned: () => {
      owed = null;
      returned = true;
    },
    // **只看协议定论**(判据见文件头最后一节):
    //   · 还没定论 → 回执压根没来过,照调用点原来的口径归还重投;
    //   · accepted → 永远不授权归还,哪怕 `markSent` 还欠着(欠账只能补,不能靠退回来结);
    //   · unknown  → 在途,既不写终态也不归还;
    //   · refused  → 归还还没落盘就交给调用点一起办(两边都幂等),落盘了就收手。
    callerMustReturn: () => {
      if (!conclusion) return true;
      if (conclusion === "refused") return !returned;
      return false;
    },
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
        return;
      }
      if (acceptance === "accepted") {
        if (owed === null) owed = "accepted";
      } else {
        // **确证拒收**:这是唯一一档可以安全重投的。归还幂等,所以这里补一笔、调用点那段善后
        // 再走一遍都只是空转 —— 真正重要的是它**不会**发生在 accepted 上。
        if (returned) return;
        if (owed === null) owed = "refused";
        console.warn(`[ash] ${opts.label} 协议层明确拒收（回合输入一个字都没写出去），归还租约并重投`);
      }
      // 只等**第一次**尝试:后面几拍由 attemptDispose 自己排(调用方是正在跑的那一轮)。
      await attemptDispose(0);
    },
  };
}

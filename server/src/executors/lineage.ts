// **从拓扑生成可击杀目标:逐边核父代。**
//
// 进程表只给得出一条裸事实:`kid.ParentProcessId === parent.pid`。而我们要的是另一句话 ——
// **「kid 是父号上当前这一代生的孩子」**。两者之间差着一整类误杀:父号是个裸数字,没有代次。
//
// 第 17 轮审查在 Windows 真机上实测到这一下:一个比本次运行的真根**早出生 3.32 秒**的无关
// 心跳进程(12356),把它那一行的父号模拟成新根号之后,生产枚举 `targets=[12356]`、下刀
// `hit=[12356]` —— 已经读到矛盾(它比根还老)却仍然授权。上一版的筛子只罩**已退场的根的
// 第一层**,活根整树、以及任何一条深层边都是裸父号直接当归属用。
//
// 所以不变量放在这一层,而且只有一条:
//
//   **每一条授权传播边都必须拿得出「这条边指向当前这一代」的证明;拿不出就不许把它
//   变成可击杀成员。**
//
// ── 这份证明有两个来源,各自充分,取得到哪个用哪个 ──────────────────────────────
//
//  ① **内核会重父 + 父亲就在这一次读数里**(POSIX)。父进程一退出,它的孩子当场被重父到
//     init / 最近的 subreaper —— 所以一个活着的进程的 ppid **只可能**指向此刻占着那个号的
//     那一代。陈旧父号在这种内核上压根不存在,同一张快照里的父子边因此天然是当代的。
//
//  ② **孩子出生在父亲那一代的存活区间里**(Windows 唯一能用的那份)。那边不重父:父进程
//     退场后孩子仍带着旧父号,那个号被别人接手之后这条边就指错了代。能把两者分开的只有
//     时间,而且时间在这里是**充分**判据而不只是启发式 —— 陈旧边的孩子必然出生在新占用者
//     **出生之前**(它的真父亲得先退场,那个号才轮得到新占用者),所以:
//       · 孩子早于父亲那一代出生 ⇒ **已证伪**(这正是上面那条真机读数的形状);
//       · 父亲那一代已经确证退场、孩子出生在那之后 ⇒ **已证伪**(号被接手之后生的);
//       · 两端都对得上 ⇒ 这条边成立。
//
// 判不出来的那一档(孩子那一代读不出、父亲那一代读不出)既不授权也不否定:`murky`。
// 它要如实留债,不许退化成「没有后代」—— 那是这条链上反复出事的那个形状。
//
// **结论只沿着 `ours` 往下传**:一支被证伪 / 判不出来之后,它下面不再逐边核(那条分支的
// 归属已经断了),整支继承同一个结论。
import { IS_WINDOWS } from "../platform.js";
import type { ProcessGeneration, ProcessTableSnapshot } from "../process-generation.js";
import { genResolutionMs, genStartedAtMs } from "../process-subtrees.js";

/**
 * 一个号在这棵树上的归属结论。覆盖树上走到的每一个号,所以调用方一次查表就能分流。
 *
 * 这里叫 `kin` 不叫 `ours`,是因为 `ours` 在这个代码库里已经是**记号证据那一档**的名字
 * (`proc.ts` 的 `UnitEvidence`:环境里读到了本次运行的记号)。两者是不同的问题 ——
 * 那一档回答「这个进程身上有没有我们的记号」,这里回答「这条父子边核不核得过」——
 * 借同一个词会让读的人以为拿到它就等于拿到了记号那一档的责任(那一档跨不过 exec,
 * 必须经 `unitOpen` 交账)。`scripts/check-cleanup-evidence.mjs` 的文件级粗判也认这个词。
 */
export type LineageVerdict =
  /** 这条边(以及它上面整条链)都核过了:属于本次运行,可以下刀。 */
  | "kin"
  /** **已证伪**:父代矛盾读得出来 ⇒ 不是我们的事,不收也不留债。 */
  | "foreign"
  /** 认不下也否不掉 ⇒ 一刀不发,但要如实留债。 */
  | "murky";

/**
 * **树根这一代此刻的落点** —— 整棵树的授权从它开始传播。两档都带着它那一端读数的精度。
 *
 *  · `live`   —— 我们那一代此刻就在这个号上(上界开着:它还能继续生孩子)。
 *    `from` 为 null = 这一刻读不出它的启动时刻 ⇒ 在没有 ① 的平台上整棵树只能判 `murky`。
 *  · `exited` —— 我们那一代**确证**退场了,区间两端齐全。只有确证能到这一档,
 *    「这一轮没读到」不许升格成反证(见 `root-life.ts`)。
 */
export type LineageStand =
  | { state: "live"; from: number | null; fromRes: number }
  | { state: "exited"; from: number; fromRes: number; to: number; toRes: number };

/** 一个父亲在这次遍历里的落点:它那一代的区间 + 它在不在这一次读数里。 */
type Frame = {
  pid: number;
  from: number | null;
  fromRes: number;
  to: number | null;
  toRes: number;
  /** 它那一行就在这一次读数里(⇒ 在重父的内核上,它名下的边天然是当代的,见 ①)。 */
  present: boolean;
  verdict: LineageVerdict;
};

/**
 * 从这张快照里切出「根名下每一个号的归属结论」。
 *
 * `kernelReparents` 默认按本机来(POSIX 为真)。**做成参数而不是直接读 `IS_WINDOWS`**,
 * 是因为这条判据判错的后果只在 Windows 上出现,而那是开发机上跑不到的分支 —— 做成参数
 * 之后两种内核前提都能在任何平台上被回归钉住(`test:kill-lineage` 的第一节)。
 */
export function siftLineage(
  table: ProcessTableSnapshot,
  rootPid: number,
  stand: LineageStand,
  opts?: { kernelReparents?: boolean },
): Map<number, LineageVerdict> {
  const reparents = opts?.kernelReparents ?? !IS_WINDOWS;
  const verdicts = new Map<number, LineageVerdict>();
  const seen = new Set<number>([rootPid]);        // 环形 ppid 的护栏,与 walkDescendants 同口径
  const stack: Frame[] = [{
    pid: rootPid,
    from: stand.from,
    fromRes: stand.fromRes,
    to: stand.state === "exited" ? stand.to : null,
    toRes: stand.state === "exited" ? stand.toRes : 0,
    present: stand.state === "live",
    verdict: "kin",
  }];
  while (stack.length) {
    const parent = stack.pop()!;
    for (const kid of table.kids.get(parent.pid) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      const gen = table.gens.get(kid);
      // 一支断了之后不再逐边核:整支继承那个结论(见文件头最后一段)。
      const verdict = parent.verdict === "kin" ? judgeEdge(parent, gen, reparents) : parent.verdict;
      verdicts.set(kid, verdict);
      const born = gen ? genStartedAtMs(gen) : null;
      stack.push({
        pid: kid,
        from: born,
        fromRes: gen ? genResolutionMs(gen) : 0,
        // 它的行就在这一次读数里 ⇒ 这一刻它还活着 ⇒ 它名下的孩子没有「出生在它退场之后」
        // 这一档可言(同一张快照内部自洽)。
        to: null,
        toRes: 0,
        present: true,
        verdict,
      });
    }
  }
  return verdicts;
}

/**
 * 一条父子边的结论(见文件头的 ① ②)。
 *
 * 容差只来自**两端读数各自的精度**(`genResolutionMs`):上一版在这里写死 ±2 秒、理由写的是
 * 「秒级精度」,而真正靠时间判归属的 Windows 那一路带 7 位小数 —— 2 秒的口子里塞得下一整个
 * 「号被复用」的窗口(第 17 轮审查 F1 的第三个实例)。
 */
function judgeEdge(
  parent: Frame, kidGen: ProcessGeneration | undefined, reparents: boolean,
): LineageVerdict {
  // ① 内核重父 + 父亲就在这一次读数里 ⇒ 这条边一定指向当前这一代,不必再问时间。
  if (reparents && parent.present) return "kin";
  // ② 时间这一路要两端都读得出来才判得动。缺任一端 ⇒ 认不下也否不掉。
  if (parent.from === null || !kidGen) return "murky";
  const born = genStartedAtMs(kidGen);
  if (born === null) return "murky";
  const kidRes = genResolutionMs(kidGen);
  // 孩子比父亲那一代还老 ⇒ 这条边指的是这个号上的**前一任**。
  if (born < parent.from - (parent.fromRes + kidRes)) return "foreign";
  // 父亲那一代确证退场之后才出生 ⇒ 它是接手这个号的人生的。
  if (parent.to !== null && born > parent.to + (parent.toRes + kidRes)) return "foreign";
  return "kin";
}

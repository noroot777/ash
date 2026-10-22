// **「这一次运行收干净了吗」—— 结论的代数**:四档答案、两个问、一条判空的不变量。
//
// 从 kill.ts 搬出来有两个理由:那份贴着 700 行上限;更要紧的是**使用方不止一个** ——
// 即时清理(kill.ts)、跨重启的责任清扫(cleanup-debt.ts)、会话级常驻的多轮合并
// (codex-resident.ts)。第 4 轮审查 F1 实测出的那一下正是「各出口各判一套」的后果:
// Windows 上两条线索都结构性答不了,各自返回「没有残留」,合并出来就是「已经证明清空」,
// 于是一行**记着活根进程**的责任被真的 DELETE 掉了(settled=1、行 0 笔、同一个 pid 仍
// alive、写文件计数 78→83)。所以判空的不变量只能有一份,放在这里,两条路都用它。
//
// ── 四档答案:一条线索能给出的四种话 ────────────────────────────────────────────
//
//  · `empty`     —— **正面证明**没有:这台设备问得了、问全了,答的是「没有」。
//  · `remaining` —— 正面证明还有。
//  · `unknown`   —— **这一次**查询失败:下一轮还问得出来 ⇒ 留着重试。
//  · `silent`    —— **这一问没有可用的证据来源**:这台机器结构性答不了(win32 读不到别的
//                   进程的环境块、没有 lsof 等价物),或者这一行当初没把核验身份要用的那份
//                   线索记下来。它跟 `unknown` 的处置相反 —— 重试一万次也是同一个答案,
//                   所以不该让它把那个平台上每个回合都变成一笔追不动的债(第 3 轮审查 N2);
//                   但它更不是「没有」。
//
// 「没有这条线索」是**第五种**吗?不是:那是**资源本身不存在**(这一次运行没开输出文件、
// 失败桩压根没有真实进程),于是「它上面没有残留」是真的 —— 正面答 `empty`。区别在于缺的是
// **设备**还是**资源**:设备缺 ⇒ `silent`(东西可能在,问不到);资源缺 ⇒ `empty`(没有东西)。
//
// ── 两个问:根、以及它的后代 ──────────────────────────────────────────────────
//
// 判空要求**两问都有正面答案**(第 4 轮审查 F1 的原话:「已知根与已知后代的未核验身份不能被
// 单位元洗成空」)。两问各有几台设备:
//
//   根   —— 内核权威的句柄状态(即时路径)/ 行上记的 pid + 启动时刻(清扫路径);
//   后代 —— 逃逸扫描(fd + 记号 + ppid 树,即时路径独有)、资源记号、两个运行专属文件。
//
// 同一问的几台设备之间是**「有一台正面答过空就算这一问答出来了」**:它们各自只看得见自己
// 那一面(fd 设备看 fd 持有者、记号设备看环境项、ppid 设备看父子链),弃权的那台不该把答出来
// 的那台否掉 —— 否则 Windows 上每个正常收尾的回合都会欠一笔债。代价如实记下:每台设备的
// 「没有」只覆盖它看得见的那一面,所以这一档从来不是「整项资源退出已证明」(同
// `processUnitEvidence` 的 `none` 那段)。
//
// 两问之间反过来是**合取**:哪一问没有任何设备作答,整条结论就是 `silent` —— 不许销账,
// 但可以「追到这里为止」(收档:停止自动重试、保留记录与定位线索)。
import { isPidAlive } from "../platform.js";
import type { UnitEvidence } from "../proc.js";
import { currentGeneration } from "../process-generation.js";
import { holderMayOwn, holderScanFault, type HolderProbe } from "./track-evidence.js";

/**
 * **一个没能排除的号**:这一轮既没认下它属于本次运行,也没能证明它不属于。
 *
 * 为什么必须是结构化的、而不是 `detail` 里那句人话(第 8 轮审查 F1-A 实测):即时清理这一侧
 * 已经点名了「75600 挂在谁下面问不出来」并正确答 `unknown`、落了一笔账;可**持久清扫手里的
 * 设备完全是另一套**(行上的根身份 + 记号 + 两个文件),它压根不知道有这个号要核 —— 同一个
 * 故障一个字都没恢复,清扫却按自己那几台设备的「没有」把那一行 DELETE 了(settled=1、行 0 笔、
 * 那个后代仍在写,心跳 74→84)。
 *
 * 所以这份名单跟着结论走、跟着落库、跨得过重启:**只有逐个核过它们的新证据才允许销账**,
 * 别人家设备的负结果解除不了这份责任。
 */
export type CleanupOpen = {
  pid: number;
  /** 读到这个号时它是哪一代(`null` = 连那一代也核验不了)。核销要靠它分「还是它」还是「号换了主人」。 */
  gen: string | null;
  /** 为什么排除不掉(人话,进披露面)。 */
  why: string;
};

/**
 * 一条线索的发言。这个类型身上有两道**编译期**的闸,它们是第 11 轮审查之前那十轮反复
 * 复发的同一条判据错误(「没进这次的视野」当成「没有未销的责任」)唯一拦得住的办法 ——
 * 写在注释里的约定已经被实测绕过九次了(AGENTS.md 那把梯子:能停在①就别停在④)。
 *
 * **闸一:`empty` 这一档手写不出来。** 它身上有一个本模块私有的 `unique symbol`,外面
 * 既看不见这个键也拿不到那个值,所以 `{ kind: "empty" }` 在本文件之外**编译不过**;唯一的
 * 出口是 `sweptClean(open)`,而它的签名要求你把手上的名单交出来、先过一遍核销(见那里)。
 * 「我扫干净了」+「可我手上还攥着名单」于是在结构上就合不出一个 `empty` 来。
 *
 * **闸二:另外三档的 `open` 是必填的。** 以前它是 `open?:`,于是「新发现的身份没有被接收」
 * 这条边每长出一条新路径就漏一次(第 10 轮审查 F1-B 的持久交接、第 9 轮 F1-B 的内存待投)。
 * 必填之后,每一个产出结论的地方都被编译器逼着回答一句「我手上有什么」—— 真的没有就
 * 显式写 `open: []`,那是一句**声明**,不再是一次遗忘。
 */
export type CleanupResult =
  | { readonly kind: "empty"; readonly [PROVEN_EMPTY]: true }
  | { kind: "remaining"; detail: string; open: readonly CleanupOpen[] }
  | { kind: "unknown"; detail: string; open: readonly CleanupOpen[] }
  | { kind: "silent"; why: string; open: readonly CleanupOpen[] };

/** 闸一那把钥匙:只声明类型、不导出值,于是本模块之外构造不出 `empty` 来(见 `CleanupResult`)。 */
declare const PROVEN_EMPTY: unique symbol;

/**
 * **全仓唯一的「正面答空」出口**,而且它**先核销再答**:
 *
 *  · 手上的名单核销干净了 ⇒ `empty`(正面证明没有);
 *  · 还剩哪怕一条 ⇒ 自动降成 `unknown` 并把剩下的那几条带上。
 *
 * 所以「手里攥着没排除掉的号却答空」不再是一条要人记住的规矩,而是一件**做不到**的事。
 * 这也是为什么它必须收一个参数:调用方没有「不交名单」这个选项,真没有就显式交空数组。
 */
export function sweptClean(open: readonly CleanupOpen[]): CleanupResult {
  const { left } = dischargeOpen(open);
  return left.length
    ? { kind: "unknown", detail: `还有排除不掉的号:${describeOpen(left)}`, open: left }
    : PROVEN;
}

/**
 * 「这条路径**压根没有要收的东西**」—— 缺的是资源不是设备(见顶部那段),所以正面答空。
 *
 * 跟 `sweptClean([])` 是同一件事,分出一个名字只为让调用点自己说清是哪一种空:
 * 失败桩没有真实进程、这一次运行没开输出文件、待收册本来就是空的。
 */
export const nothingToCollect = (): CleanupResult => sweptClean([]);

/**
 * 全仓唯一一处构造 `empty` 的地方。`as unknown as` 是闸一的代价:那个 symbol 没有值,
 * 连本模块也只能这样把它做出来一次 —— 换来的是外面 48 个构造点全部走 `sweptClean`。
 */
const PROVEN = { kind: "empty" } as unknown as CleanupResult;

/**
 * 这一份结论身上还挂着哪些没排除掉的号。
 *
 * `?? []` 不是冗余:类型上 `open` 必填(闸二)管的是**编译期**,而这里也要接住运行期从外面
 * 进来的那些 —— 升级前落的库行、测试夹具手搓的结论。
 */
export const openOf = (result: CleanupResult): readonly CleanupOpen[] =>
  result.kind === "empty" ? [] : result.open ?? [];

/**
 * 集合成员的键:**号 + 那一代**,不是裸号(第 9 轮审查 F1-D)。
 *
 * 裸号当键有两种错法,都是真的丢责任:号被复用之后,同一个号的**新一代**成了新的未决身份,
 * 它会被名单里那条旧的挤掉;而下一次按旧代次核销时(旧的那个确实退了),两代一起从名单上
 * 消失。两代是两份互不替代的责任,键里必须带上代次。
 *
 * 代次问不出来(`null`)的那种自成一格:它跟任何一条「有代次」的记录都不是同一条责任。
 */
export const openKey = (one: CleanupOpen): string => `${one.pid}@${one.gen ?? "?"}`;

/**
 * 几份名单并成一份。**只增不减** —— 这是整条链的不变量:
 *
 * 「这一次扫描没在自己的视野里看见它」**不构成退出证明**(第 9 轮审查 F1-A 实测:停止前
 * 点过名的号,在停止后那次快照里因为被重父到 1 号名下而不再是「父边问不出来」,于是名单
 * 空了、责任没落盘,重试清扫把行删了,而它还在写 —— 心跳 44→52)。要让一条记录从名单上
 * 消失,只能靠 `dischargeOpen` 给出的退出证据。
 */
export function joinOpen(...lists: readonly (readonly CleanupOpen[])[]): CleanupOpen[] {
  const byKey = new Map<string, CleanupOpen>();
  for (const list of lists) {
    for (const one of list) if (!byKey.has(openKey(one))) byKey.set(openKey(one), one);
  }
  return [...byKey.values()];
}

/**
 * **核销**:这份名单上哪几条已经有了退出证据,剩下哪几条还欠着。
 *
 * 即时清理与跨重启清扫共用这一份(判据只有一处):一条记录只有两条正面出路 ——
 *  · 号上没有进程了 ⇒ 当初那个一定退了;
 *  · 号上还有进程、但**同一个坐标系里**读出来不是那一代 ⇒ 号换了主人,当初那个也一定退了。
 *
 * **跨坐标系的不等不算换主**(第 9 轮审查 F1-C 实测:存的是 Linux 的节拍数 `j:`、这一刻
 * 退回 `ps` 读出 `t:` 文本,字符串当然不等 —— 上一版据此宣布「号换了主人」把责任核销掉了,
 * 而同一个号还活着)。三态判据全仓只有一份(`process-generation.ts` 的 `currentGeneration`),
 * 这里直接用它:只有 `changed` 算退出证据,`unqueryable` 是「这一次没核成」。
 */
export function dischargeOpen(open: readonly CleanupOpen[]): { left: CleanupOpen[]; gone: CleanupOpen[] } {
  const left: CleanupOpen[] = [], gone: CleanupOpen[] = [];
  for (const one of open) (provenGone(one) ? gone : left).push(one);
  return { left, gone };
}

/**
 * **一次清理里「还欠谁」的唯一账本**。
 *
 * 为什么要有这么个东西,而不是各处 `joinOpen` 一下就好(第 10 轮审查 F1-A 实测):同一次
 * 清理里身份有**五个来源** —— 三次扫描各自点的名、这一次确认归属的成员、以及跨得过「丢
 * fd」的那本后代账。上一版把它们散在调用点上手工并,于是漏了「已确认目标」这一条边:
 * 核验不了代次的成员**正确地**没被补刀,可它既没进残存者、也没进名单,最终扫描又因为它
 * 已被重父到 1 号名下而看不见它 —— 结论是 `empty`,债表 0 笔,而它还在写(心跳 107→117)。
 *
 * 收成一个账本之后,「少并了一个来源」从**一次疏忽**变成**一处显式的调用缺失**:判空只有
 * `verdict()` 一条路,它读的永远是账本全量。
 *
 * **只增不减**:`add`/`own` 只往里放,唯一的出口是核销(`dischargeOpen`)。
 */
export type OpenLedger = {
  /** 某台设备点的名。 */
  add(open: readonly CleanupOpen[]): void;
  /** **已确认属于本次运行**的成员:从认下那一刻起就是一份责任,直到有它的退出证据。 */
  own(members: readonly { pid: number; gen: string | null }[], why: string): void;
  /** 核销一遍,还欠着的那几条。 */
  left(): CleanupOpen[];
  /** 这本账这一刻的结论:欠干净了 ⇒ `empty`,还欠着 ⇒ `unknown` 带名单(见 `sweptClean`)。 */
  verdict(): CleanupResult;
};

/**
 * 一份记号证据里**已确证**的身份。**全仓唯一的转换出口** —— 消费 `ours` 的地方一律经它。
 *
 * 为什么必须有这么一个函数,而不是各处自己 `.members.map()`(第 11 轮审查 F1 实测):
 * `ours` 这一档是**真实环境项**读出来的,每个成员自带 pid + 跟记号同源的那一代 —— 这是
 * 全链条里最硬的一种归属证明。可它**跨不过 `exec`**:成员收到 TERM 之后 `execle` 换一个
 * 干净环境,pid 和那一代一个字没变,记号那一问却从此答 `none`。于是「上一刻刚确证过、刚
 * 朝它开过刀」的成员,在下一刻变成「这台设备说没有」,把行删了 —— 审查实测:同一个进程
 * 仍 alive、心跳 53→58,而债表 0 行。
 *
 * **`suspected` 不在这里**:那一档是 `ps -E` 的展示文本(macOS),它只证明「看得见」,
 * 证明不了那个号上就是带着记号的那个进程 —— 按 proc.ts 那一层的规矩它不给落点,所以这里
 * 也不点名(点了名就等于拿一份弱证据去押一笔核不动的债)。
 */
export const unitOpen = (evidence: UnitEvidence, why: string): CleanupOpen[] =>
  evidence.verdict === "ours"
    ? evidence.members.map((m) => ({ pid: m.pid, gen: m.gen, why }))
    : [];

export function openLedger(): OpenLedger {
  let all: CleanupOpen[] = [];
  const ledger: OpenLedger = {
    add: (open) => { all = joinOpen(all, open); },
    own: (members, why) => {
      ledger.add(members.map((m) => ({ pid: m.pid, gen: m.gen, why })));
    },
    left: () => dischargeOpen(all).left,
    verdict: () => sweptClean(all),
  };
  return ledger;
}

function provenGone(one: CleanupOpen): boolean {
  if (!Number.isInteger(one.pid) || one.pid <= 1) return true;   // 记歪的号核不动,也追不动
  if (!isPidAlive(one.pid)) return true;
  if (!one.gen) return false;                     // 当初没记代次 ⇒ 只能等它退出
  return currentGeneration(one.pid, one.gen).outcome === "changed";
}

/** 几份结论身上的名单并起来(胜出那一档之外的也要并,见 `mergeCleanupResults`)。 */
const unionOpen = (results: readonly CleanupResult[]): CleanupOpen[] =>
  joinOpen(...results.map((r) => openOf(r)));

/** 未排除的号写成给人看的一句。 */
export const describeOpen = (open: readonly CleanupOpen[]): string =>
  open.map((o) => `${o.pid}(${o.why})`).join(";");

/** 这一轮能不能放手(从待收册划掉、不再重试)。**只有正面证明清空算。** */
export const cleanupSettled = (result: CleanupResult): boolean => result.kind === "empty";

/** 给人看的那一句(`empty` 那档没有细节,返回空串)。 */
export const cleanupDetail = (result: CleanupResult): string => {
  if (result.kind === "empty") return "";
  return result.kind === "silent" ? result.why : result.detail;
};

/** 下一轮**还可能换答案**吗。只有「这一次查询失败」算 —— 弃权票重试多少遍都一样。 */
export const cleanupRetriable = (result: CleanupResult): boolean => result.kind === "unknown";

/**
 * 几份**独立结论**合成一份:取最保守的那一档(`remaining` > `unknown` > `silent` > `empty`)。
 *
 * 用在两个地方:上面那两问之间(见顶部),以及「一个句柄起过好几轮」的 codex 会话级常驻 ——
 * 任何一轮还没收干净,这个句柄就不算收干净。
 *
 * **`silent` 压过 `empty`**:一份弃权的结论摆在这儿,就说明「整项都空了」这句话缺了一块,
 * 不许让答出来的那份把它洗掉(第 4 轮审查 F1)。空数组仍然是 `empty` —— 那不是「没人答」,
 * 而是「压根没有要收的东西」(常驻句柄的待收册空了就是这一档,它的空是前面每一轮各自
 * 证明出来的)。
 */
export function mergeCleanupResults(results: readonly CleanupResult[]): CleanupResult {
  // **未排除的号从所有输入里并起来,不只从胜出那一档** —— 它们是跟着整份结论走的责任,
  // 不是某一档的附注(第 8 轮审查 F1-A)。
  const open = unionOpen(results);
  const pick = (kind: "remaining" | "unknown") => {
    const hit = results.filter((r) => r.kind === kind);
    return hit.length
      ? { kind, detail: hit.map((r) => cleanupDetail(r)).join(" | "), open } as CleanupResult
      : null;
  };
  const silent = results.filter((r) => r.kind === "silent");
  return pick("remaining") ?? pick("unknown")
    ?? (silent.length ? { kind: "silent", why: silent.map((r) => cleanupDetail(r)).join(" | "), open }
      : sweptClean(open));
}

/**
 * **同一问的几台设备**合成这一问的答案:取最保守的,但弃权票不否掉正面答出来的那张
 * (`remaining` > `unknown` > `empty` > `silent`,见顶部那段)。
 *
 * 一台设备都没有(全体弃权、或者空列表)⇒ 这一问 `silent`:它没有可用的证据来源。
 */
export function mergeClueAnswers(answers: readonly CleanupResult[], subject: string): CleanupResult {
  const open = unionOpen(answers);
  const pick = (kind: "remaining" | "unknown") => {
    const hit = answers.filter((r) => r.kind === kind);
    return hit.length
      ? { kind, detail: hit.map((r) => cleanupDetail(r)).join(" | "), open } as CleanupResult
      : null;
  };
  const answered = answers.some((r) => r.kind === "empty");
  // 「有一台正面答过空就算这一问答出来了」这条**到未排除的号这里为止**:弃权的那台不该
  // 否掉答出来的那台,可它点名的那个号也不该被另一台的「我这边没有」抹掉 —— 这一句现在
  // 由 `sweptClean` 在结构上保证(有名单就答不出空来),不再靠这里记得多调一道闸。
  return pick("remaining") ?? pick("unknown")
    ?? (answered ? sweptClean(open) : {
      kind: "silent",
      why: answers.length
        ? `${subject}这一问:${answers.map((r) => cleanupDetail(r)).join(" | ")}`
        : `${subject}这一问没有任何可用的证据来源`,
      open,
    });
}

/** 判空的两个问(见顶部)。每条线索必须声明自己在答哪一问。 */
/**
 * 判空要分别问清楚的几件事。`ledger` 是第 13 轮封写入那一段时补上的第三问:**账本自己
 * 这一刻读不出来**。
 *
 * 为什么它不能跟 `descendants` 混在一问里(实测):同一问之内的规矩是「一台设备弃权,不许
 * 否掉另一台正面答出来的那张」(见 `mergeClueAnswers`)—— 对线索设备这是对的,输出文件那一
 * 问答得出「没人握着」时,记号那一问答不上来不该拖它。可「行上那份未排除名单读不出来」
 * 说的不是某一条线索,是**我手上这份责任清单本身核不动**;把它放进 `descendants`,它就被
 * 路径那一问的 `empty` 票洗掉了,于是一次 JSON 损坏的结论是「判空成立」,行被真的删掉。
 *
 * 放到自己这一问之后走的是两问之间那条规矩(`mergeCleanupResults`:`silent` 压过 `empty`),
 * 结论落成 `silent` ⇒ 处置是**收档**(盖戳留行、不再自动重试),正是「再问多少次都是
 * 同一句」该去的那一档。
 */
export type CleanupSubject = "root" | "descendants" | "ledger";
const SUBJECT_LABEL: Record<CleanupSubject, string> = {
  root: "根进程", descendants: "后代", ledger: "责任清单",
};

/** 一条线索的发言:它在答哪一问、答的是什么。 */
export type ClueAnswer = { subject: CleanupSubject; answer: CleanupResult };

/**
 * **判空的不变量,全仓一处**:两问各自汇总,然后合取。
 *
 * 即时清理和跨重启清扫手里的设备不一样(即时那条多一个逃逸扫描和内核权威的句柄状态),
 * 但「什么才算证明清空」这一条必须同一份 —— 第 4 轮审查 F1 点名的正是「各出口同用一条能
 * 证明清空的不变量」。
 */
export function judgeByClues(clues: readonly ClueAnswer[]): CleanupResult {
  // **两问必答,第三问有就答**。`root`/`descendants` 一条答案都没有时按全体弃权算
  // (`mergeClueAnswers` 的空列表 ⇒ silent),那是对的:没有任何设备说过话,判空不成立。
  // 可同一条规矩套到 `ledger` 上就反了 —— 它只有债表那条链投票,即时清理那条链压根没有
  // 「行」这个东西(`kill.ts` 的 `judgeCleanup`)。无条件把它排进来,那条链上每一次正常收尾
  // 都会拿到一张不存在的弃权票,结论永远 silent、永远收档(实测:`test:holder-scan` 当场
  // 变红 ——「每次正常收尾都会压一笔追不动的债」)。
  const asked = new Set(clues.map((c) => c.subject));
  const subjects: CleanupSubject[] = ["root", "descendants",
    ...(asked.has("ledger") ? ["ledger" as const] : [])];
  return mergeCleanupResults(subjects.map((s) => mergeClueAnswers(
    clues.filter((c) => c.subject === s).map((c) => c.answer), SUBJECT_LABEL[s],
  )));
}

/**
 * **一条路径线索的终态,写成同一种答案** —— 判空的时候要把它跟记号那一问并起来。
 *
 * 为什么必须有这一步(第 2 轮审查 F1 实测):上一版判空只问了记号、追踪 fd 和句柄树,
 * 而**这一次运行的输出文件从头到尾没人问**。真实现场是:后代把环境洗掉(记号 `none`)、
 * 顺手丢掉高位 fd(追踪文件没有持有者)、根已经退出(句柄树是空的)—— 三问全答「没有」,
 * 可它的 stdout 还接在这次运行的输出文件上,继续往用户目录里写。于是局部的空被当成了
 * 整项资源的空:结论 `empty`、证据释放、一笔债都没留下。
 *
 * 判据与记号那一层同源,**按「正面证据 → 问全了吗 → 剩下的」三步走**:
 *  · 发现的号里有活着的写手 ⇒ `remaining`(最硬的那种残留证据,**不依赖问全没问全**);
 *  · 这一问没问全 ⇒ `unknown`:已发现的那几个号都退了,推不出没覆盖到的那部分也空
 *    (第 5 轮审查 F1 —— 上一版在这里把半截查询当全集用,于是真的 DELETE 了一行活债);
 *  · 问全了、只剩只读/模式问不出的持有者 ⇒ `unknown`(分不出后代还是看客);
 *  · 问全了、一个活着的都没有 ⇒ `empty`,确证没人握着。
 *
 * `null` = **这条线索这一次运行根本没有**(非 detached 的运行没有输出文件、Windows 不开追踪
 * 文件):缺的是**资源**不是设备,没有文件就没有东西能握着它 ⇒ 正面答 `empty`(见顶部那段
 * 「设备缺 vs 资源缺」)。**这台机器答不了的那一档不许走这个 `null`** —— 那是 `silent`,
 * 调用方自己给(`fileHoldersAnswerable()`)。
 *
 * 代价如实记下:输出文件是 `data/runs/` 下的真实日志,用户自己 `tail -f` 它也会被算成持有者,
 * 于是落一笔假债。方向是对的那一边(宁可多留一笔可重试的记录,也不要把活着的后代宣布成
 * 收干净),而且它只用于**残留检测、不用于下刀**(同 cleanup-debt.ts 里那段)。
 */
export function residueFromProbe(label: string, probe: HolderProbe | null): CleanupResult {
  if (!probe) return nothingToCollect();         // 这一次运行没有这个文件 ⇒ 没有东西能被握着
  const alive = probe.found.filter((h) => isPidAlive(h.pid));
  // ① **写模式的活持有者 = 确证残留**(第 3 轮审查 F1):这一问要答的是「还有没有东西在往
  // 这次运行的文件里写」。后代继承的是写端(追踪文件开的是 `"w"`、输出文件是根的 stdout)。
  // 放在最前面是因为它是**正面**证据:发现一个就成立,跟这一问后来有没有出错无关。
  const writers = alive.filter(holderMayOwn);
  if (writers.length) {
    return {
      kind: "remaining", detail: `${label}仍被 ${writers.map((h) => h.pid).join(",")} 写着`,
      // 文件持有者**不是进程归属证明**(第 7 轮审查 F1):用户自己 tail 日志也会落到这里,
      // 所以这一问只报「还有残留」这个事实,不往责任名单里按号点名。
      open: [],
    };
  }
  // ② **没问全就不许往下读成空**(第 5 轮审查 F1)。`found` 这时只是「至少这些」:它们全退了
  // 只说明**已发现的那部分**空了,没覆盖到的那部分一个字都没被证明过。
  const fault = holderScanFault(probe);
  if (fault) {
    return { kind: "unknown", detail: `${label}这一问没答全:${fault.fault}`, open: [] };
  }
  // ③ 问全了,剩下的是只读的(或者模式问不出来的)持有者:「有人握着」是事实,「握着的是不是
  // 这次运行的后代」这一问没答出来 —— 别再把这两件事折成一个 `empty`。用户自己 tail 日志就是
  // 只读打开的,它更像看客而不是残留,可「更像」不是证明:所以这一档只说「问不清楚」,账留着、
  // 下一轮再问,而不是当场宣布收干净。
  if (alive.length) {
    return {
      kind: "unknown",
      detail: `${label}被 ${alive.map((h) => h.pid).join(",")} 握着、但不是写模式 ——`
        + " 分不出是这次运行的后代还是只读的看客",
      open: [],                                   // 同上:握着文件证不出归属,不点名
    };
  }
  return sweptClean([]);                          // 问全了 + 一个活着的都没有
}

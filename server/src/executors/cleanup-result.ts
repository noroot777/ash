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
 * 一条线索的发言。**`empty` 这一档在类型上就带不了未排除的号** —— 「还有没排除掉的责任」
 * 和「已经证明空了」是矛盾的两句话,让它编译不过比写一条注释管用(AGENTS.md 的那把梯子①)。
 */
export type CleanupResult =
  | { kind: "empty" }
  | { kind: "remaining"; detail: string; open?: readonly CleanupOpen[] }
  | { kind: "unknown"; detail: string; open?: readonly CleanupOpen[] }
  | { kind: "silent"; why: string; open?: readonly CleanupOpen[] };

/** 这一份结论身上还挂着哪些没排除掉的号。 */
export const openOf = (result: CleanupResult): readonly CleanupOpen[] =>
  result.kind === "empty" ? [] : result.open ?? [];

/** 按号去重(同一个号可能被几台设备各报一次)。 */
function unionOpen(results: readonly CleanupResult[]): CleanupOpen[] {
  const byPid = new Map<number, CleanupOpen>();
  for (const result of results) {
    for (const one of openOf(result)) if (!byPid.has(one.pid)) byPid.set(one.pid, one);
  }
  return [...byPid.values()];
}

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
      : openGuard(open) ?? { kind: "empty" });
}

/**
 * **手里还攥着没排除掉的号就不许答空** —— 哪怕每一台发言的设备自己都答了「没有」。
 *
 * 这不是多余的保险:那几个号正是**某一台设备报上来的**,而别的设备看不见它们那一面
 * (记号被 `env -i` 洗掉、fd 被 close、父子边问不出来)。让它们的「没有」把这份责任洗掉,
 * 就是第 8 轮审查 F1 点名的那条判据错误的一般形。
 */
const openGuard = (open: readonly CleanupOpen[]): CleanupResult | null => open.length
  ? { kind: "unknown", detail: `还有排除不掉的号:${describeOpen(open)}`, open }
  : null;

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
  // 「有一台正面答过空就算这一问答出来了」这条**到未排除的号这里为止**(见 `openGuard`):
  // 弃权的那台不该否掉答出来的那台,可它点名的那个号也不该被另一台的「我这边没有」抹掉。
  return pick("remaining") ?? pick("unknown") ?? openGuard(open)
    ?? (answered ? { kind: "empty" } : {
      kind: "silent",
      why: answers.length
        ? `${subject}这一问:${answers.map((r) => cleanupDetail(r)).join(" | ")}`
        : `${subject}这一问没有任何可用的证据来源`,
    });
}

/** 判空的两个问(见顶部)。每条线索必须声明自己在答哪一问。 */
export type CleanupSubject = "root" | "descendants";
const SUBJECT_LABEL: Record<CleanupSubject, string> = { root: "根进程", descendants: "后代" };

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
  const subjects: CleanupSubject[] = ["root", "descendants"];
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
  if (!probe) return { kind: "empty" };
  const alive = probe.found.filter((h) => isPidAlive(h.pid));
  // ① **写模式的活持有者 = 确证残留**(第 3 轮审查 F1):这一问要答的是「还有没有东西在往
  // 这次运行的文件里写」。后代继承的是写端(追踪文件开的是 `"w"`、输出文件是根的 stdout)。
  // 放在最前面是因为它是**正面**证据:发现一个就成立,跟这一问后来有没有出错无关。
  const writers = alive.filter(holderMayOwn);
  if (writers.length) {
    return { kind: "remaining", detail: `${label}仍被 ${writers.map((h) => h.pid).join(",")} 写着` };
  }
  // ② **没问全就不许往下读成空**(第 5 轮审查 F1)。`found` 这时只是「至少这些」:它们全退了
  // 只说明**已发现的那部分**空了,没覆盖到的那部分一个字都没被证明过。
  const fault = holderScanFault(probe);
  if (fault) {
    return { kind: "unknown", detail: `${label}这一问没答全:${fault.fault}` };
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
    };
  }
  return { kind: "empty" };                       // 问全了 + 一个活着的都没有
}

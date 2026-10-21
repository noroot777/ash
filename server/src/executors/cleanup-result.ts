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
import { holderMayOwn, type HolderProbe } from "./track-evidence.js";

export type CleanupResult =
  | { kind: "empty" }
  | { kind: "remaining"; detail: string }
  | { kind: "unknown"; detail: string }
  | { kind: "silent"; why: string };

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
  const pick = (kind: "remaining" | "unknown") => {
    const hit = results.filter((r) => r.kind === kind);
    return hit.length
      ? { kind, detail: hit.map((r) => cleanupDetail(r)).join(" | ") } as CleanupResult
      : null;
  };
  const silent = results.filter((r) => r.kind === "silent");
  return pick("remaining") ?? pick("unknown")
    ?? (silent.length ? { kind: "silent", why: silent.map((r) => cleanupDetail(r)).join(" | ") }
      : { kind: "empty" });
}

/**
 * **同一问的几台设备**合成这一问的答案:取最保守的,但弃权票不否掉正面答出来的那张
 * (`remaining` > `unknown` > `empty` > `silent`,见顶部那段)。
 *
 * 一台设备都没有(全体弃权、或者空列表)⇒ 这一问 `silent`:它没有可用的证据来源。
 */
export function mergeClueAnswers(answers: readonly CleanupResult[], subject: string): CleanupResult {
  const pick = (kind: "remaining" | "unknown") => {
    const hit = answers.filter((r) => r.kind === kind);
    return hit.length
      ? { kind, detail: hit.map((r) => cleanupDetail(r)).join(" | ") } as CleanupResult
      : null;
  };
  const answered = answers.some((r) => r.kind === "empty");
  return pick("remaining") ?? pick("unknown") ?? (answered ? { kind: "empty" } : {
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
 * 判据与记号那一层同源:
 *  · `held` 且确实还有活着的号 ⇒ `remaining`(这是最硬的那种残留证据);
 *  · `held` 但那几个号都已经没了 ⇒ 这条线索这一刻证明不了残留 ⇒ `empty`;
 *  · `empty` ⇒ 确证没人握着;
 *  · `unknown` ⇒ **「问不出来」不是「没有」**,照 `unknown` 往上传,由调用方保留责任与证据。
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
  if (probe.kind === "empty") return { kind: "empty" };
  if (probe.kind === "unknown") {
    return { kind: "unknown", detail: `${label}这一问没答出来:${probe.reason}` };
  }
  const alive = probe.holders.filter((h) => isPidAlive(h.pid));
  if (!alive.length) return { kind: "empty" };
  // **写模式才算确证残留**(第 3 轮审查 F1):这一问要答的是「还有没有东西在往这次运行的
  // 文件里写」。后代继承的是写端(追踪文件开的是 `"w"`、输出文件是根的 stdout)。
  const writers = alive.filter(holderMayOwn);
  if (writers.length) {
    return { kind: "remaining", detail: `${label}仍被 ${writers.map((h) => h.pid).join(",")} 写着` };
  }
  // 剩下的是只读的(或者模式问不出来的)持有者:「有人握着」是事实,「握着的是不是这次运行
  // 的后代」这一问没答出来 —— 别再把这两件事折成一个 `empty`。用户自己 tail 日志就是只读
  // 打开的,它更像看客而不是残留,可「更像」不是证明:所以这一档只说「问不清楚」,账留着、
  // 下一轮再问,而不是当场宣布收干净。
  return {
    kind: "unknown",
    detail: `${label}被 ${alive.map((h) => h.pid).join(",")} 握着、但不是写模式 ——`
      + " 分不出是这次运行的后代还是只读的看客",
  };
}

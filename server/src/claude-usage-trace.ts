// 历史回填的 trace 那一半：把旧 claude 会话 trace 里那几条 usage 事件读出来、改写成真实
// 增量。账那一半在 claude-usage-repair.ts，提交协议在 claude-usage-apply.ts。
//
// **为什么非得改数据、不能在读侧算**：气泡上的「本轮」读的就是 trace 里这条事件。旧
// claude trace 存的是整条线程的累计快照，而它们一条不缺地都标着 `incremental`（当时的
// 代码认为 claude 本来就是增量），标记没有分辨力。曾经试过在读侧按数据形状判（整串不降
// + 末条等于会话汇总），被审查当场证伪：那个恒等式只对「已回填、此后没再续聊」的会话
// 成立，随便续一轮，整条历史的气泡就集体弹回累计值；跨 ash 会话行的线程更是永远凑不出。
// **一条旧记录的含义不能随「以后会不会续聊」改变** —— 所以真实增量必须逐条写回数据里。
//
// 这个文件只管单份文件的三件事：**算**（prepare，不落盘）、**写**（write）、**还原**
// （restore）。「谁跟谁一起成败」是提交协议的事，归 claude-usage-apply.ts。
//
// 四条自保：
// ① 只动被判定要改的那几条 usage 行，其余行**原样保留**（按行处理，不整份重新序列化）；
// ② 第一次改写前把原文件留一份 `.pre-usage-repair` 备份；
// ③ **校验的是内容身份，不只是位置**：每条编辑都带着计划当时读到的原值，对不上就整份
//    不动。只核对「第 n 条 usage 命中了」是不够的 —— 计划之后文件要是被追加或改过，
//    同一个下标上很可能已经是另一份数字，照写就是拿陈旧计划盖掉新内容（第 2 轮审查 F2）。
// ④ **每一个真要落盘的路径都要落在本资源集的 runs 根里面**，按 realpath 判，不按名字判。
//    绑定层只验到 runs 根是不够的：隔离副本里任意一级任务目录是条软链，根目录那一关全过
//    得去，写进去的却是源库的历史（第 3 轮审查 F1 实测 `copy/runs/smoke ->
//    source/runs/smoke`，源 trace 被改成 delta）。写集不止那份 trace —— 备份、临时文件、
//    回滚文件都算，它们跟着同一个（可能是软链的）父目录走。
// ⑤ **路径字符串不是实体归属证明**，所以每一个新文件都**独占创建**（第 3 轮复核 F1 实测两种绕过：
//    `.repair-tmp` 是指向目录外不存在文件的软链时，realpath 失败后退回「父目录 + 名字」，④ 判它
//    仍在 runs 内，writeFileSync 跟着软链在目录外造出文件，rename 之后正式 trace 就是那条越界链；
//    `.repair-tmp` 是指向目录外既有文件的硬链接时，realpath 本来就落在 runs 内，普通写入直接重写
//    同一个 inode，目录外的旧历史一起被改掉）。独占创建（`O_EXCL` + `link`）两种别名都挡得住：
//    目标名已经存在（哪怕是条悬空软链）就 EEXIST，一个字节都不写。备份另加这一条的另一半 ——
//    **先写满再以正式名字出现**，所以「备份文件在」就等于「它是完整的」（同一轮 F3）。
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TokenUsage, UsageAccountingMark } from "@ash/shared";
import { parseSessionTrace, readableRunPath, sessionTracePath } from "./transcript.js";
import { RUNS_DIR } from "./paths.js";
import { atomicCreateWithContent, withinResource } from "./resource-claim.js";

/** 落盘口径：undefined / incremental 都是「改口径之前的旧账」，见 shared 的 UsageAccountingMark。 */
export type LegacyMark = UsageAccountingMark | undefined;
export const isLegacyMark = (mark: LegacyMark): boolean => mark === undefined || mark === "incremental";

export type UsageTraceEntry = {
  at: string;
  sessionId: string;
  /** 这是本文件里第几条 usage 事件（从 0 起）。改写时按它定位，所以必须和读的时候用同一套校验。 */
  index: number;
  usage: TokenUsage;
  mark: LegacyMark;
};

export type TraceUsageEdit = {
  index: number;
  /** 计划当时在这个位置读到的原值 —— 写之前要逐项核对，防止拿陈旧计划盖掉新内容。 */
  expected: TokenUsage;
  expectedMark: LegacyMark;
  usage: TokenUsage;
  accounting: UsageAccountingMark;
};
export type SessionTraceRewrite = {
  taskId: string;
  sessionId: string;
  /** 这条会话属于哪条 CLI 线程 —— 成败按线程整组算，见 claude-usage-apply.ts。 */
  cliSessionId: string;
  edits: TraceUsageEdit[];
};

export const TRACE_BACKUP_SUFFIX = ".pre-usage-repair";
const TRACE_TEMP_SUFFIX = ".repair-tmp";
const TRACE_ROLLBACK_SUFFIX = ".repair-rollback";

/**
 * 这份改写**实际会碰到的全部路径**。备份和两个临时文件一并算进来：它们跟 trace 共一个
 * 父目录，父目录是软链的话它们一样会落到别人家。
 */
export function traceWriteSet(path: string): string[] {
  return [
    path,
    `${path}${TRACE_BACKUP_SUFFIX}`,
    `${path}${TRACE_TEMP_SUFFIX}`,
    `${path}${TRACE_ROLLBACK_SUFFIX}`,
  ];
}

/** 写集里真实落点跑到本资源集 runs 根外面的那些路径（空数组 = 都在里面）。 */
export function escapedWritePaths(path: string): string[] {
  return traceWriteSet(path).filter((item) => !withinResource(RUNS_DIR, item));
}

/**
 * 这一份改写越界了吗 —— 越界就给出那句给人看的话（null = 没越界）。
 *
 * 调用点有两处，**故意重复**：apply 的独立闸拿它整轮拒绝（一条越界就一个字节都不写），
 * 这个文件自己的 write/restore 再各判一次，所以绕过闸直接调写入函数也写不出去。
 */
/** 独占创建一个新文件；目标名已经被占（含悬空软链、硬链接）就给出那句给人看的话。 */
function createExclusive(path: string, text: string, mode: number, options: { fsync?: boolean } = {}): string | null {
  // atomicCreateWithContent 自己那份 `.<pid>.<uuid>.tmp` 落在同一个父目录里，所以它的归属跟
  // 下面这几个声明过的写入点是同一个答案，不另判一次。
  if (atomicCreateWithContent(path, text, mode, options)) return null;
  return `${path} 这个名字已经被占着（可能是上一次被强杀留下的残骸，也可能是一条指向别处的软链`
    + "或硬链接）：门禁式的独占创建不会覆盖它，也不会跟着它写到别处去。确认那份文件没用之后删掉它再重跑。";
}

/** 把现有文件的权限位抄过来，让 rename 发布之后 trace 的权限不变（读不到就退到 0600）。 */
function modeOf(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

export function traceEscapeReason(taskId: string, sessionId: string): string | null {
  const path = sessionTracePath(taskId, sessionId);
  const escaped = escapedWritePaths(path);
  if (escaped.length === 0) return null;
  return `${taskId}/${sessionId}：写入点不在本次隔离资源集里（runs 根 ${RUNS_DIR}）—— `
    + `${escaped.map((item) => `${item} → ${canonicalOf(item)}`).join("；")}。`
    + "多半是某一级目录是条指向别处的软链：改写、备份和临时文件都会落到那边去，整轮拒绝。";
}

const canonicalOf = (item: string): string => {
  try {
    return realpathSync(item);
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return `落点读不出来（${(error as NodeJS.ErrnoException).code}）`;
    }
    try {
      return `${join(realpathSync(dirname(item)), basename(item))}（尚不存在）`;
    } catch (parent) {
      return parent instanceof Error && "code" in parent
        ? `父目录落点也读不出来（${(parent as NodeJS.ErrnoException).code}）` : item;
    }
  }
};

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "turns"] as const;
const sameReported = (a: TokenUsage, b: TokenUsage) =>
  TOKEN_FIELDS.every((key) => a[key] === b[key]) && (a.costUsd ?? null) === (b.costUsd ?? null);

/**
 * 从一条会话的 trace 里把 usage 事件按顺序取回来。**读不到文件返回 null（≠ 空数组）**：
 * 「这条会话一轮都没报账」和「它的 trace 丢了」必须分开，后者不能被当成可重算的完整历史。
 */
export function readUsageTrace(taskId: string, sessionId: string): UsageTraceEntry[] | null {
  let text: string;
  try {
    text = readFileSync(readableRunPath(sessionTracePath(taskId, sessionId)), "utf8");
  } catch {
    return null;
  }
  const entries: UsageTraceEntry[] = [];
  for (const entry of parseSessionTrace(text)) {
    if (entry.event.kind !== "usage") continue;
    const event = entry.event as { kind: "usage"; usage: TokenUsage; accounting?: UsageAccountingMark };
    entries.push({ at: entry.at, sessionId, index: entries.length, usage: event.usage, mark: event.accounting });
  }
  return entries;
}

/** 算好但没落盘的一份改写。`original` 留着是为了失败时还原。 */
export type PreparedTrace = {
  rewrite: SessionTraceRewrite;
  path: string;
  original: string;
  next: string;
  applied: number;
};

/** 把一份 trace 的新内容算出来，但不落盘。认不出就返回失败说明（string）。 */
export function prepareTraceRewrite(rewrite: SessionTraceRewrite): PreparedTrace | string {
  const path = sessionTracePath(rewrite.taskId, rewrite.sessionId);
  const where = `${rewrite.taskId}/${rewrite.sessionId}`;
  // 预览实例的 RUNS_FALLBACK_DIR 指着主仓的 data/runs；本实例没有这份文件时读会回退到
  // 那边，但写**绝不允许**落在别人的历史上。
  if (readableRunPath(path) !== path) return `${where}：trace 只存在于只读回退目录，不改写`;
  const escaped = traceEscapeReason(rewrite.taskId, rewrite.sessionId);
  if (escaped) return escaped;
  let original: string;
  try {
    original = readFileSync(path, "utf8");
  } catch (error) {
    return `${where}：读不到 trace（${(error as Error).message}）`;
  }
  const byIndex = new Map(rewrite.edits.map((item) => [item.index, item]));
  let cursor = -1;
  let applied = 0;
  let broken: string | null = null;
  const lines = original.split("\n").map((line) => {
    if (!line.trim() || broken) return line;
    const parsed = parseSessionTrace(line)[0];
    if (!parsed || parsed.event.kind !== "usage") return line;
    cursor += 1;
    const edit = byIndex.get(cursor);
    if (!edit) return line;
    const event = parsed.event as { kind: "usage"; usage: TokenUsage; accounting?: UsageAccountingMark };
    if (!sameReported(event.usage, edit.expected) || event.accounting !== edit.expectedMark) {
      broken = `${where}：第 ${cursor} 条 usage 跟计划当时读到的不一样（文件在这期间变过），整份不动`;
      return line;
    }
    applied += 1;
    return JSON.stringify({ ...parsed, event: { ...event, usage: edit.usage, accounting: edit.accounting } });
  });
  if (broken) return broken;
  // 命中数对不上说明这份 trace 跟计划读到的不是同一份。半份改写比不改写坏得多，整份跳过。
  if (applied !== rewrite.edits.length) {
    return `${where}：计划改 ${rewrite.edits.length} 条 usage，文件里只对上 ${applied} 条，整份不动`;
  }
  return { rewrite, path, original, next: lines.join("\n"), applied };
}

/** 落盘（临时文件 + rename）。成功返回 null，失败返回说明。 */
export function writePreparedTrace(item: PreparedTrace): string | null {
  const where = `${item.rewrite.taskId}/${item.rewrite.sessionId}`;
  const escaped = traceEscapeReason(item.rewrite.taskId, item.rewrite.sessionId);
  if (escaped) return escaped;
  const temp = `${item.path}${TRACE_TEMP_SUFFIX}`;
  const mode = modeOf(item.path);
  try {
    // 备份**先写满再以正式名字出现**:直接以 `.pre-usage-repair` 开写的话，磁盘满/I-O 错误会在盘上
    // 留下一份已经存在、却只有开头几十个字节的文件；重跑只看 existsSync 就跳过它，于是第二次迁移
    // 改账成功、而承诺过的那份完整原文恢复材料已经永久丢了（第 3 轮复核 F3 实测 460 → 40 字节）。
    const backup = `${item.path}${TRACE_BACKUP_SUFFIX}`;
    if (!existsSync(backup)) {
      const refused = createExclusive(backup, item.original, mode, { fsync: true });
      if (refused) return `${where}：留不下原文备份 —— ${refused}`;
    }
    const occupied = createExclusive(temp, item.next, mode);
    if (occupied) return `${where}：写不出临时文件 —— ${occupied}`;
    renameSync(temp, item.path);
    return null;
  } catch (error) {
    // 没发布出去的临时文件一律清掉:失败会被重试，攒一堆 .repair-tmp 只会让下一个人
    // 分不清哪份是哪份（第 3 轮审查 N1）。
    discard(temp);
    return `${where}：写回失败（${(error as Error).message}）`;
  }
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch { /* 没建起来、或者已经 rename 走了 */ }
}

/** 把已经写下去的那一份还原成原内容。成功返回 null，失败返回说明。 */
export function restorePreparedTrace(item: PreparedTrace): string | null {
  const where = `${item.rewrite.taskId}/${item.rewrite.sessionId}`;
  // 回滚也要**重新复核一次归属**:准备之后父目录可能已经变成一条指向别处的软链，照着旧字符串
  // 落盘就把原文写到了别人家的历史上。写入那一侧判了、回滚这一侧不判，等于只锁了一半的门。
  const escaped = traceEscapeReason(item.rewrite.taskId, item.rewrite.sessionId);
  // 三条失败出口一律以「回滚失败」开头:上游只凭这几个字判「回滚本身也没成」从而落隔离记录
  // (test-claude-usage-migration.ts 场景 quarantine 钉着它),后半句才说清是哪一种失败。
  if (escaped) return `${where}：回滚失败 —— 回滚点已经不在本次隔离资源集里，文件仍是改写后的内容：${escaped}`;
  const temp = `${item.path}${TRACE_ROLLBACK_SUFFIX}`;
  try {
    const occupied = createExclusive(temp, item.original, modeOf(item.path));
    if (occupied) return `${where}：回滚失败 —— 写不出临时文件，文件仍是改写后的内容：${occupied}`;
    renameSync(temp, item.path);
    return null;
  } catch (error) {
    discard(temp);
    return `${where}：回滚失败，文件仍是改写后的内容（${(error as Error).message}）`;
  }
}

// 回填写了一半、又回滚失败时留下的隔离记录。
//
// 为什么要有这么一份文件：回填是「几份 trace 文件 + 一张表」的跨资源迁移，正常失败路径
// 由 claude-usage-apply.ts 自动回滚（trace 原文留在内存里），**回滚本身也失败**才走到这
// 里 —— 那时磁盘上有几份已经改成真实增量的 trace、库里却还是旧账，而且这台机器刚刚证明
// 自己写不动那几个文件。这种状态下再重跑一次，等于拿不知道改了几条的记录继续推，所以
// 规矩是**明确拒绝重跑那几条线程**（计划里把它们整条标成 skip），等人核对完
// `.pre-usage-repair` 备份、删掉这份隔离记录再说。
//
// ── 三态，不是「有没有」 ──────────────────────────────────────────────────────
// 「这份屏障本身读不出来」必须是**独立的一态**，不能折进另外两态里（第 1 轮审查 F3）：
//
// - `none`：文件不在 —— 上一次没留下未决状态，照常跑。
// - `pending`：读得懂，知道是哪几条线程 —— 那几条不动，其余照常。
// - `unreadable`：文件在、但读不出可信的线程清单（截断、JSON 坏、`threads` 字段缺、
//   清单空、成员不是字符串、成员是空白字符串、读不动），或者这份记录自己带着
//   「未知范围」标记 —— **整盘拒绝**，一条写入都不许发生。
//
// 旧版把解析失败折成「一条空线程清单」、把缺字段折成「没有隔离记录」，于是人工屏障一碰到
// 损坏记录就自动失效，计划照常生成可写动作（实测：警告说「一律不动」，动作却是 update，
// 账照改）。空集合表达不了「不知道」—— 它表达的是「知道，且一条都没有」。
//
// ── 未知范围**单调**，只有人能消 ───────────────────────────────────────────────
// 第 3 轮审查又实测到两条同类漏洞，根子都是「未知范围被别的写入冲淡了」：
//
// ① `threads: [""]` 过了「成员是字符串」这一关，于是被读成 pending，而那个身份谁都匹配
//    不上 —— 等于谁都不挡，真实 CLI 随后把 300 改成了 200。**成员类型对不等于身份有效**。
// ② 先有一份读不懂的记录（整盘拒绝），再因为另一条线程回滚失败写入一份新记录 —— 旧文件
//    虽然存了档，当前状态却变成「只挡新线程」的 pending，原先被挡住的历史又可写了。
//    **追加别的失败记录不许缩小已有的阻止范围**。
//
// 所以记录里带一个 `unknownScope`：一旦出现过「读不出来」，它就一直在，`readUnresolvedState`
// 看到它就返回 `unreadable`，直到**人工**核对完 `.pre-usage-repair` 备份、把这份文件删掉。
//
// 落盘用**原子替换**（同目录临时文件 + fsync + rename）：这份文件恰恰是在「刚刚证明磁盘
// 写不动」的时候写的，半截内容比没有更糟。读不懂的旧文件**先拷一份存档、再原子替换**，
// 顺序不能反 —— 先 rename 走再建新文件的话，中间那一瞬原路径上没有屏障，新文件要是建不
// 起来，重跑就会读成 `none`（发布失败不许把原屏障搬走）。
//
// 注意**只有这一种情况需要人介入**。进程被硬杀在「trace 全写完、库事务还没提交」之间不走
// 这里：那种状态可证明地可恢复 —— 整条线程的账就是它 trace 里各条增量之和（恒等式
// sum(deltas) == 最后一份累计值），所以重跑一次就会收敛到正确值，连累计基线都能从改写后
// 的记录里重新拼出来（见 claude-usage-repair.ts 的 settled 分支）。被硬杀在「几份 trace
// 写完、还有几份没写」之间则是另一档：那条线程这一轮会被整条判成「库值跟记录对不上、又
// 拼不出恒等式」而只诊断不改（保守，不会写错，但也不会自动收敛回正确值）。
import {
  closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveAshDbFile } from "./db/path.js";

export type UnresolvedRepair = {
  at: string;
  /** 这几条 CLI 线程的 trace 和账现在对不上，必须人工核对后才能再动。 */
  threads: string[];
  /** 已经改写、但没能还原回去的那几份文件。 */
  files: string[];
  reason: string;
  /**
   * **未知范围**：这份屏障曾经读不出来，所以「该挡住哪些线程」是不知道的。
   * 一旦写上就不会被后续写入抹掉（见文件头 ②），只有人删掉整个文件才算消解。
   */
  unknownScope?: { at: string; detail: string; archived: string | null };
};

/** 未决状态的三态。`unreadable` 必须单独一态 —— 见文件头。 */
export type UnresolvedState =
  | { kind: "none"; file: string }
  | { kind: "pending"; file: string; record: UnresolvedRepair }
  | { kind: "unreadable"; file: string; detail: string };

export function unresolvedRepairFileForDb(dbFile = resolveAshDbFile()): string {
  return `${dbFile}.claude-usage-unresolved.json`;
}

export function readUnresolvedState(dbFile = resolveAshDbFile()): UnresolvedState {
  const file = unresolvedRepairFileForDb(dbFile);
  if (!existsSync(file)) return { kind: "none", file };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { kind: "unreadable", file, detail: `读不动这份文件：${(error as Error).message}` };
  }
  let parsed: Partial<UnresolvedRepair>;
  try {
    parsed = JSON.parse(text) as Partial<UnresolvedRepair>;
  } catch (error) {
    return { kind: "unreadable", file, detail: `不是完整的 JSON（很可能上次写到一半）：${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unreadable", file, detail: "顶层不是对象" };
  }
  // 未知范围是单调的:只要这份记录带着它，不管 threads 写得多漂亮，状态就还是「不知道」。
  const unknown = parsed.unknownScope;
  if (unknown !== undefined) {
    if (unknown === null || typeof unknown !== "object" || Array.isArray(unknown)) {
      return { kind: "unreadable", file, detail: "unknownScope 字段坏了，未知范围无法确认已消解" };
    }
    const detail = typeof unknown.detail === "string" ? unknown.detail : "（没写原因）";
    const archived = typeof unknown.archived === "string" ? unknown.archived : null;
    return {
      kind: "unreadable",
      file,
      detail: `这份屏障带着未知范围标记（${detail}${archived ? `，旧记录存档在 ${archived}` : ""}）：`
        + "上一次留下的屏障曾经读不出来，谁被挡住就不可知，后来追加的记录不能替它作证",
    };
  }
  if (!Array.isArray(parsed.threads)) {
    // 缺字段 ≠ 没有隔离记录：文件都在了，说明上一次确实留了未决状态，只是记不全。
    return { kind: "unreadable", file, detail: "缺 threads 字段，认不出是哪几条线程" };
  }
  if (parsed.threads.some((item) => typeof item !== "string")) {
    return { kind: "unreadable", file, detail: "threads 里有不是字符串的项，清单不可信" };
  }
  if (parsed.threads.length === 0) {
    return { kind: "unreadable", file, detail: "threads 是空的，认不出该挡住哪几条线程" };
  }
  // **身份要有效，不只是类型对**：空白字符串匹配不上任何一条 CLI 线程，于是「挡住了」会
  // 退化成「谁都没挡」—— 靠 Set 里有个匹配不到的成员来代表安全是假的（第 3 轮审查 F3）。
  const blank = (parsed.threads as string[]).filter((item) => item.trim() === "").length;
  if (blank > 0) {
    return {
      kind: "unreadable",
      file,
      detail: `threads 里有 ${blank} 个空白身份，匹配不上任何 CLI 线程，清单不可信`,
    };
  }
  return {
    kind: "pending",
    file,
    record: {
      at: typeof parsed.at === "string" ? parsed.at : "不详",
      threads: [...new Set((parsed.threads as string[]).map((item) => item.trim()))],
      files: Array.isArray(parsed.files) ? parsed.files.filter((item): item is string => typeof item === "string") : [],
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    },
  };
}

export function writeUnresolvedRepair(record: UnresolvedRepair, dbFile = resolveAshDbFile()): string {
  const file = unresolvedRepairFileForDb(dbFile);
  const previous = readUnresolvedState(dbFile);
  let merged = record;
  if (previous.kind === "pending") {
    merged = {
      at: record.at,
      threads: [...new Set([...previous.record.threads, ...record.threads])],
      files: [...new Set([...previous.record.files, ...record.files])],
      reason: [previous.record.reason, record.reason].filter(Boolean).join("\n"),
    };
  } else if (previous.kind === "unreadable") {
    // 读不懂的那份也可能装着别的线程，不许直接盖掉，也**不许因此缩小阻止范围**：
    // ① 先**拷**一份存档（不是 rename：原路径上的屏障一刻都不能空出来）；
    // ② 新记录带上 `unknownScope`，于是状态仍然是 unreadable，整盘照旧拒绝。
    let archived: string | null = `${file}.unreadable-${Date.now()}`;
    try {
      copyFileSync(file, archived);
    } catch {
      archived = null; // 存不下来也要继续:未知范围本身不能丢
    }
    merged = {
      ...record,
      files: [...new Set([...record.files, ...(archived ? [archived] : [])])],
      reason: [
        `上一份隔离记录读不懂（${previous.detail}）`
        + (archived ? `，已另存为 ${archived}` : "，而且没能存档"),
        record.reason,
      ].filter(Boolean).join("\n"),
      unknownScope: {
        at: new Date().toISOString(),
        detail: previous.detail,
        archived,
      },
    };
  }
  writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}

/**
 * 同目录临时文件 + fsync + rename：要么是旧的那份，要么是完整的新的，没有中间态。
 *
 * 没发布出去的临时文件一律清掉 —— write/fsync/rename 任意一步抛都算（第 3 轮审查 N1：
 * 原来只在 rename 失败时清，磁盘满会在 write 里抛，于是攒下一堆 .tmp）。
 */
function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
    published = true;
  } finally {
    if (!published) {
      try {
        unlinkSync(temp);
      } catch { /* 没建起来 */ }
    }
  }
}

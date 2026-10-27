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
//   清单空、读不动）—— **整盘拒绝**，一条写入都不许发生。
//
// 旧版把解析失败折成「一条空线程清单」、把缺字段折成「没有隔离记录」，于是人工屏障一碰到
// 损坏记录就自动失效，计划照常生成可写动作（实测：警告说「一律不动」，动作却是 update，
// 账照改）。空集合表达不了「不知道」—— 它表达的是「知道，且一条都没有」。
//
// 落盘用**原子替换**（同目录临时文件 + fsync + rename）：这份文件恰恰是在「刚刚证明磁盘
// 写不动」的时候写的，半截内容比没有更糟 —— 它会让下一次重跑读到一份读不懂的屏障（现在
// 那是整盘拒绝，还得人来清），而原来那条真正的线程清单已经被覆盖丢了。读不懂的旧文件也
// 不直接覆盖：先改名存档，再写新的。
//
// 注意**只有这一种情况需要人介入**。进程被硬杀在「trace 全写完、库事务还没提交」之间不走
// 这里：那种状态可证明地可恢复 —— 整条线程的账就是它 trace 里各条增量之和（恒等式
// sum(deltas) == 最后一份累计值），所以重跑一次就会收敛到正确值，连累计基线都能从改写后
// 的记录里重新拼出来（见 claude-usage-repair.ts 的 settled 分支）。被硬杀在「几份 trace
// 写完、还有几份没写」之间则是另一档：那条线程这一轮会被整条判成「库值跟记录对不上、又
// 拼不出恒等式」而只诊断不改（保守，不会写错，但也不会自动收敛回正确值）。
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveAshDbFile } from "./db/path.js";

export type UnresolvedRepair = {
  at: string;
  /** 这几条 CLI 线程的 trace 和账现在对不上，必须人工核对后才能再动。 */
  threads: string[];
  /** 已经改写、但没能还原回去的那几份文件。 */
  files: string[];
  reason: string;
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
  return {
    kind: "pending",
    file,
    record: {
      at: typeof parsed.at === "string" ? parsed.at : "不详",
      threads: parsed.threads as string[],
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
    // 读不懂的那份也可能装着别的线程，不许直接盖掉：改名存档，位置写进新记录。
    const archived = `${file}.unreadable-${Date.now()}`;
    try {
      renameSync(file, archived);
      merged = {
        ...record,
        files: [...new Set([...record.files, archived])],
        reason: [`上一份隔离记录读不懂（${previous.detail}），已另存为 ${archived}`, record.reason]
          .filter(Boolean).join("\n"),
      };
    } catch (error) {
      merged = {
        ...record,
        reason: [`上一份隔离记录读不懂（${previous.detail}），也没能存档：${(error as Error).message}`, record.reason]
          .filter(Boolean).join("\n"),
      };
    }
  }
  writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}

/** 同目录临时文件 + fsync + rename：要么是旧的那份，要么是完整的新的，没有中间态。 */
function writeAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch { /* 留着也只是个 .tmp */ }
    throw error;
  }
}

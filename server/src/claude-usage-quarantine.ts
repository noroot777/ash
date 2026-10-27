// 回填写了一半、又回滚失败时留下的隔离记录。
//
// 为什么要有这么一份文件：回填是「几份 trace 文件 + 一张表」的跨资源迁移，正常失败路径
// 由 claude-usage-apply.ts 自动回滚（trace 原文留在内存里），**回滚本身也失败**才走到这
// 里 —— 那时磁盘上有几份已经改成真实增量的 trace、库里却还是旧账，而且这台机器刚刚证明
// 自己写不动那几个文件。这种状态下再重跑一次，等于拿不知道改了几条的记录继续推，所以
// 规矩是**明确拒绝重跑那几条线程**（计划里把它们整条标成 skip），等人核对完
// `.pre-usage-repair` 备份、删掉这份隔离记录再说。
//
// 注意**只有这一种情况需要人介入**。进程被硬杀在「trace 全写完、库事务还没提交」之间不走
// 这里：那种状态可证明地可恢复 —— 整条线程的账就是它 trace 里各条增量之和（恒等式
// sum(deltas) == 最后一份累计值），所以重跑一次就会收敛到正确值，连累计基线都能从改写后
// 的记录里重新拼出来（见 claude-usage-repair.ts 的 settled 分支）。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolveAshDbFile } from "./db/path.js";

export type UnresolvedRepair = {
  at: string;
  /** 这几条 CLI 线程的 trace 和账现在对不上，必须人工核对后才能再动。 */
  threads: string[];
  /** 已经改写、但没能还原回去的那几份文件。 */
  files: string[];
  reason: string;
};

export function unresolvedRepairFileForDb(dbFile = resolveAshDbFile()): string {
  return `${dbFile}.claude-usage-unresolved.json`;
}

export function readUnresolvedRepair(dbFile = resolveAshDbFile()): UnresolvedRepair | null {
  const file = unresolvedRepairFileForDb(dbFile);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UnresolvedRepair>;
    if (!Array.isArray(parsed.threads)) return null;
    return {
      at: typeof parsed.at === "string" ? parsed.at : "不详",
      threads: parsed.threads.filter((item): item is string => typeof item === "string"),
      files: Array.isArray(parsed.files) ? parsed.files.filter((item): item is string => typeof item === "string") : [],
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    // 读不懂也算「有事没结清」：返回一条空线程清单会让计划以为可以照常跑。
    return { at: "不详", threads: [], files: [file], reason: `隔离记录读不懂：${file}` };
  }
}

export function writeUnresolvedRepair(record: UnresolvedRepair, dbFile = resolveAshDbFile()): string {
  const file = unresolvedRepairFileForDb(dbFile);
  const previous = readUnresolvedRepair(dbFile);
  const merged: UnresolvedRepair = previous
    ? {
      at: record.at,
      threads: [...new Set([...previous.threads, ...record.threads])],
      files: [...new Set([...previous.files, ...record.files])],
      reason: [previous.reason, record.reason].filter(Boolean).join("\n"),
    }
    : record;
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}

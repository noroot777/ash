// 第 1 轮自由审查 F2:早先所有执行共用 logs/<叶子名>.log,复核和修复轮把初跑的完整日志原地盖掉了。
// 结果记录(*.jsonl)每行都留着当时日志的末尾 4000 字,日志不超过这个长度时那就是全文。
// 本脚本把平铺的 logs/ 按执行拆开:
//   logs/initial/     初跑全量轮(bare.jsonl,标签 bare1..3)
//   logs/rerun-once/  非绿叶子单并发复核一遍(bareverify.jsonl)
//   logs/later/       修复期间各轮复跑留在平铺目录里的最后一份(哪一轮见 INDEX.md)
// 原文件还在且大小对得上 → 原样搬;被盖掉但末尾就是全文 → 从记录写回(字节数核对过);
// 被盖掉且超长 → 只写得回末尾,落成 <名>.tail.log,不冒充全文。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const AUDIT = new URL(".", import.meta.url).pathname;
const LOGS = join(AUDIT, "logs");
const rows = (f) => readFileSync(join(AUDIT, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const flat = () => readdirSync(LOGS).filter((f) => f.endsWith(".log"));
const isExact = (r) => Buffer.byteLength(r.tail ?? "", "utf8") === r.logBytes;
const report = { initial: { moved: 0, fromTail: 0, truncated: [] }, "rerun-once": { fromTail: 0, truncated: [] }, later: [] };

// 平铺目录里每个叶子名最后被哪一份记录写过(按记录文件的修改时间排序,后写的覆盖先写的)
const jsonls = readdirSync(AUDIT).filter((f) => f.endsWith(".jsonl")).sort((a, b) => statSync(join(AUDIT, a)).mtimeMs - statSync(join(AUDIT, b)).mtimeMs);
const lastWriter = new Map();
for (const f of jsonls) for (const r of rows(f)) if (r.log?.startsWith(".audit/logs/") && r.log.split("/").length === 3) lastWriter.set(basename(r.log), { file: f, label: r.label, verdict: r.verdict, logBytes: r.logBytes });

function restore(dir, source, key, moveFlat) {
  mkdirSync(join(LOGS, dir), { recursive: true });
  for (const r of rows(source)) {
    const name = basename(r.log);
    const flatPath = join(LOGS, name);
    const writer = lastWriter.get(name);
    if (moveFlat && writer?.file === source && existsSync(flatPath) && statSync(flatPath).size === r.logBytes) {
      renameSync(flatPath, join(LOGS, dir, name)); report[key].moved += 1; continue;
    }
    if (isExact(r)) { writeFileSync(join(LOGS, dir, name), r.tail); report[key].fromTail += 1; continue; }
    writeFileSync(join(LOGS, dir, name.replace(/\.log$/, ".tail.log")), r.tail);
    report[key].truncated.push({ id: r.id, name, logBytes: r.logBytes });
  }
}
restore("initial", "bare.jsonl", "initial", true);
restore("rerun-once", "bareverify.jsonl", "rerun-once", false);

mkdirSync(join(LOGS, "later"), { recursive: true });
for (const name of flat()) {
  renameSync(join(LOGS, name), join(LOGS, "later", name));
  const w = lastWriter.get(name);
  report.later.push({ name, ...(w ?? { file: "(无记录:作废的早期 sweep)" }) });
}
writeFileSync(join(AUDIT, "restore-logs.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ initial: { ...report.initial, truncated: report.initial.truncated.length }, rerunOnce: { ...report["rerun-once"], truncated: report["rerun-once"].truncated.length }, later: report.later.length }));

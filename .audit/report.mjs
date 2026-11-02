// 由 catalog.json + results*.jsonl 生成报告的机械部分(清单表 + 红绿统计)。
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const AUDIT = join(ROOT, ".audit");
const catalog = JSON.parse(readFileSync(join(AUDIT, "catalog.json"), "utf8"));
const key = (pkg, cmd) => `${pkg}\u0000${cmd}`;
const leafByKey = new Map(catalog.leaves.map((l) => [key(l.pkg, l.cmd), l]));

const load = (file) => (existsSync(join(AUDIT, file))
  ? readFileSync(join(AUDIT, file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const rows = [...process.argv.slice(2)].flatMap(load);
// 同一个叶子跑了多轮,后面那一轮覆盖前面(用于「闪红」判定前的最新态)
const latest = new Map();
const allRuns = new Map();
for (const r of rows) {
  latest.set(r.id, r);
  if (!allRuns.has(r.id)) allRuns.set(r.id, []);
  allRuns.get(r.id).push(r);
}

const EXCLUDE = new Set(["node scripts/accept-test.mjs"]);
const pool = catalog.leaves.filter((l) => !EXCLUDE.has(l.cmd));
const stat = { green: 0, red: 0, timeout: 0, missing: 0, "spawn-error": 0 };
for (const l of pool) {
  const r = latest.get(l.id);
  if (!r) stat.missing += 1; else stat[r.verdict] = (stat[r.verdict] ?? 0) + 1;
}
console.log("=== 汇总 ===");
console.log(`叶子总数 ${pool.length}`, stat);
const gatePool = pool.filter((l) => l.inGate);
const gStat = { green: 0, red: 0, timeout: 0, missing: 0 };
for (const l of gatePool) { const r = latest.get(l.id); if (!r) gStat.missing += 1; else gStat[r.verdict] = (gStat[r.verdict] ?? 0) + 1; }
console.log(`门禁内 ${gatePool.length}`, gStat);

const bad = pool.map((l) => ({ l, r: latest.get(l.id) })).filter(({ r }) => r && r.verdict !== "green");
console.log(`\n=== 非绿 ${bad.length} 条 ===`);
for (const { l, r } of bad.sort((a, b) => Number(b.l.inGate) - Number(a.l.inGate) || a.l.id - b.l.id)) {
  const runs = allRuns.get(l.id).map((x) => x.verdict).join(">");
  console.log(`#${l.id} ${l.inGate ? "[门禁]" : "[门禁外]"} ${l.pkg} | ${l.cmd} | ${r.verdict} exit=${r.exitCode} ${Math.round(r.ms / 1000)}s | runs=${runs}`);
  console.log(`    入口: ${l.entries.join(", ")}`);
  console.log(`    日志: ${r.log}`);
}

const slow = pool.map((l) => latest.get(l.id)).filter(Boolean).sort((a, b) => b.ms - a.ms).slice(0, 15);
console.log(`\n=== 最慢 15 条 ===`);
for (const r of slow) console.log(`${Math.round(r.ms / 1000)}s  ${r.pkg} ${r.cmd}`);
const totalMs = pool.map((l) => latest.get(l.id)).filter(Boolean).reduce((a, r) => a + r.ms, 0);
console.log(`\n叶子累计 CPU 墙钟 ${Math.round(totalMs / 60000)} 分钟`);
writeFileSync(join(AUDIT, "summary.json"), JSON.stringify({ stat, gStat, bad: bad.map(({ l, r }) => ({ ...l, verdict: r.verdict, exitCode: r.exitCode, ms: r.ms, log: r.log })) }, null, 2));

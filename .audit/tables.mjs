// 生成报告里的机械表格:入口脚本清单 + 全量叶子红绿清单。
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const AUDIT = join(ROOT, ".audit");
const catalog = JSON.parse(readFileSync(join(AUDIT, "catalog.json"), "utf8"));
const K = (pkg, cmd) => `${pkg}\u0000${cmd}`;
const leafByKey = new Map(catalog.leaves.map((l) => [K(l.pkg, l.cmd), l]));

const load = (f) => (existsSync(join(AUDIT, f)) ? readFileSync(join(AUDIT, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
// 后面的文件覆盖前面的(sweep1 → verify → riskygreen)
const latest = new Map();
const history = new Map();
for (const f of process.argv.slice(2)) for (const r of load(f)) {
  latest.set(r.id, r);
  if (!history.has(r.id)) history.set(r.id, []);
  history.get(r.id).push(r.verdict);
}
const EXCLUDE = new Set(["node scripts/accept-test.mjs"]);
const pool = catalog.leaves.filter((l) => !EXCLUDE.has(l.cmd));
const short = (cmd) => cmd.replace(/^(tsx|node)( --[\w-]+)* /, "").replace(/^(\.\.\/)?scripts\//, "");
const mark = { green: "绿", red: "**红**", timeout: "**超时**", "spawn-error": "**起不来**" };

// ── 表 A:入口脚本清单
const entryRows = [];
for (const e of catalog.entries) {
  const leaves = e.leaves.map((l) => leafByKey.get(K(l.pkg, l.cmd))).filter(Boolean);
  const inGate = leaves.filter((l) => l.inGate).length;
  const scope = leaves.length === 0 ? "空" : inGate === leaves.length ? "门禁内" : inGate === 0 ? "门禁外" : `部分(${inGate}/${leaves.length})`;
  const verdicts = leaves.map((l) => latest.get(l.id)?.verdict ?? "missing");
  const bad = verdicts.filter((v) => v !== "green" && v !== "missing").length;
  const miss = verdicts.filter((v) => v === "missing").length;
  entryRows.push(`| \`${e.pkg}:${e.script}\` | ${leaves.length} | ${scope} | ${bad ? `**${bad} 条非绿**` : miss ? `${miss} 条未跑` : "全绿"} |`);
}

// ── 表 B:全量叶子清单
const leafRows = [];
for (const l of [...pool].sort((a, b) => a.pkg.localeCompare(b.pkg) || short(a.cmd).localeCompare(short(b.cmd)))) {
  const r = latest.get(l.id);
  const runs = (history.get(l.id) ?? []).join(" → ");
  leafRows.push(`| ${l.id} | ${l.pkg} | \`${short(l.cmd)}\` | ${l.inGate ? "✔" : ""} | ${r ? mark[r.verdict] ?? r.verdict : "未跑"} | ${r ? Math.round(r.ms / 1000) + "s" : "—"} | ${runs} |`);
}

const stat = (ls) => {
  const s = { green: 0, red: 0, timeout: 0, missing: 0 };
  for (const l of ls) { const r = latest.get(l.id); s[r ? r.verdict : "missing"] = (s[r ? r.verdict : "missing"] ?? 0) + 1; }
  return s;
};
const all = stat(pool), gate = stat(pool.filter((l) => l.inGate)), out = stat(pool.filter((l) => !l.inGate));

writeFileSync(join(AUDIT, "tables.md"), [
  `<!-- 由 .audit/tables.mjs 生成 -->`,
  ``, `总计 ${pool.length}:绿 ${all.green} / 红 ${all.red} / 超时 ${all.timeout} / 未跑 ${all.missing}`,
  `门禁内 ${pool.filter((l) => l.inGate).length}:绿 ${gate.green} / 红 ${gate.red} / 超时 ${gate.timeout} / 未跑 ${gate.missing}`,
  `门禁外 ${pool.filter((l) => !l.inGate).length}:绿 ${out.green} / 红 ${out.red} / 超时 ${out.timeout} / 未跑 ${out.missing}`,
  ``, `## 表 A:入口脚本(${catalog.entries.length} 条)`, ``,
  `| 入口 | 叶子数 | 门禁范围 | 结果 |`, `|---|---|---|---|`, ...entryRows,
  ``, `## 表 B:全量叶子(${pool.length} 条)`, ``,
  `| # | 包 | 叶子命令 | 门禁 | 结果 | 耗时 | 历次 |`, `|---|---|---|---|---|---|---|`, ...leafRows,
].join("\n"));
console.log(`tables.md 写好:入口 ${catalog.entries.length} 行,叶子 ${pool.length} 行`);
console.log("总计", all, "\n门禁内", gate, "\n门禁外", out);

// 枚举 root/server/web 的 test:* 脚本,把 && 链与 npm run 间接层展开成叶子命令。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PKGS = {
  root: { dir: ".", json: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) },
  server: { dir: "server", json: JSON.parse(readFileSync(join(ROOT, "server/package.json"), "utf8")) },
  web: { dir: "web", json: JSON.parse(readFileSync(join(ROOT, "web/package.json"), "utf8")) },
};
const WS_ALIAS = { "@ash/server": "server", server: "server", "@ash/web": "web", web: "web", "@ash/shared": "shared", "@ash/mcp": "mcp" };

const splitChain = (cmd) => {
  // 只拆顶层 && ,脚本里没有引号包住的 && ,简单切分即可
  return cmd.split("&&").map((s) => s.trim()).filter(Boolean);
};

// 返回 {kind:"npm", pkg, script} | {kind:"leaf", pkg, cmd}
const classify = (pkgKey, part) => {
  const tokens = part.split(/\s+/);
  if (tokens[0] !== "npm") return { kind: "leaf", pkg: pkgKey, cmd: part };
  // npm [-w <ws>] run <script>  |  npm run <script>
  let i = 1, ws = null;
  while (i < tokens.length) {
    if (tokens[i] === "-w" || tokens[i] === "--workspace") { ws = tokens[i + 1]; i += 2; continue; }
    if (tokens[i].startsWith("--workspace=")) { ws = tokens[i].slice(12); i += 1; continue; }
    break;
  }
  if (tokens[i] !== "run") return { kind: "leaf", pkg: pkgKey, cmd: part };
  const script = tokens[i + 1];
  const target = ws ? (WS_ALIAS[ws] ?? ws) : pkgKey;
  return { kind: "npm", pkg: target, script };
};

const cache = new Map();
const expand = (pkgKey, script, stack = []) => {
  const key = `${pkgKey}:${script}`;
  if (stack.includes(key)) return [{ pkg: pkgKey, cmd: `<<cycle ${key}>>`, via: [...stack] }];
  if (cache.has(key)) return cache.get(key);
  const pkg = PKGS[pkgKey];
  if (!pkg) return [{ pkg: pkgKey, cmd: `<<unknown-workspace ${pkgKey} run ${script}>>`, via: [...stack] }];
  const body = pkg.json.scripts?.[script];
  if (body == null) return [{ pkg: pkgKey, cmd: `<<missing-script ${key}>>`, via: [...stack] }];
  const out = [];
  for (const part of splitChain(body)) {
    const c = classify(pkgKey, part);
    if (c.kind === "npm") out.push(...expand(c.pkg, c.script, [...stack, key]));
    else out.push({ pkg: c.pkg, cmd: c.cmd, via: [...stack, key] });
  }
  cache.set(key, out);
  return out;
};

const entries = [];
for (const [pkgKey, pkg] of Object.entries(PKGS)) {
  for (const script of Object.keys(pkg.json.scripts ?? {})) {
    if (script.startsWith("//")) continue;
    if (!(script === "test" || script.startsWith("test:"))) continue;
    entries.push({ pkg: pkgKey, script, body: pkg.json.scripts[script], leaves: expand(pkgKey, script) });
  }
}

// 验收门禁范围
// accept-test.mjs 的 STEPS 是 JS 数组,展开不到,照它的内容硬编码两步
const gateLeaves = new Set([...expand("server", "test:accept"), ...expand("root", "test:web")]
  .map((l) => `${l.pkg}\u0000${l.cmd}`));

const leafMap = new Map();
for (const e of entries) {
  for (const l of e.leaves) {
    const k = `${l.pkg}\u0000${l.cmd}`;
    if (!leafMap.has(k)) leafMap.set(k, { pkg: l.pkg, cmd: l.cmd, entries: [], inGate: gateLeaves.has(k) });
    leafMap.get(k).entries.push(`${e.pkg}:${e.script}`);
  }
}
const leaves = [...leafMap.values()].map((l, i) => ({ id: i + 1, ...l }));
writeFileSync(join(ROOT, ".audit/catalog.json"), JSON.stringify({ entries, leaves }, null, 2));
console.log(`entry scripts: ${entries.length}`);
console.log(`unique leaves: ${leaves.length}  (in gate: ${leaves.filter((l) => l.inGate).length})`);
console.log(`by pkg:`, Object.entries(leaves.reduce((a, l) => ((a[l.pkg] = (a[l.pkg] ?? 0) + 1), a), {})));
const weird = leaves.filter((l) => l.cmd.startsWith("<<"));
if (weird.length) { console.log("ANOMALIES:"); for (const w of weird) console.log("  ", w.pkg, w.cmd, "via", w.entries.join(",")); }

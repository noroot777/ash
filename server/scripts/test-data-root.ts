// 「代码目录只读、数据整体另放」的那几条入口（独立 app 就这么跑）：
//  · `ASH_DATA_DIR` 整体指定数据根，库 / runs / uploads / deps 都跟着走；单项覆盖仍然优先；
//  · 读完就从本进程环境里拿掉，子进程（agent、预览、终端）不继承；
//  · 代码根不是 git 检出时没有「自己的仓库」（REPO_DIR = null）；
//  · MCP 登记写哪个 node：自带运行时写绝对路径，否则照旧走 PATH 上的 `node`；
//  · `ASH_LOCAL_ONLY` 同样读完即删。
//
// paths.js 在模块加载时就把环境变量冻成常量，所以每个场景起一个子进程。
//
// Run: npm -w server run test:data-root
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const src = new URL("../src/", import.meta.url);

/** 在一个干净的子进程里 import 一组模块，把 probe 的 JSON 结果交回来。 */
function probe(env: Record<string, string>, body: string): Record<string, unknown> {
  const script = `${body}\nconsole.log("PROBE=" + JSON.stringify(out));`;
  const base = { ...process.env };
  for (const key of ["ASH_DATA_DIR", "ASH_DB", "ASH_RUNS_DIR", "ASH_UPLOADS_DIR", "ASH_DEPS_DIR", "ASH_LOCAL_ONLY"]) delete base[key];
  const stdout = execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], {
    env: { ...base, ...env }, encoding: "utf8",
  });
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE="));
  assert.ok(line, `子进程没交回结果：\n${stdout}`);
  return JSON.parse(line.slice("PROBE=".length));
}

const pathsProbe = `
const paths = await import(${JSON.stringify(new URL("paths.js", src).href)});
const { resolveAshDbFile } = await import(${JSON.stringify(new URL("db/path.js", src).href)});
const out = {
  code: paths.CODE_DIR, repo: paths.REPO_DIR, data: paths.DATA_DIR, runs: paths.RUNS_DIR,
  uploads: paths.UPLOADS_DIR, deps: paths.DEPS_DIR, db: resolveAshDbFile(),
  inherited: process.env.ASH_DATA_DIR ?? null,
};`;

const root = mkdtempSync(join(tmpdir(), "ash-data-root-"));
try {
  // ── 整体指定：一切都落在它下面，环境里不再留着 ──
  const data = join(root, "data");
  const whole = probe({ ASH_DATA_DIR: data }, pathsProbe);
  assert.equal(whole.data, data);
  assert.equal(whole.runs, join(data, "runs"));
  assert.equal(whole.uploads, join(data, "uploads"));
  assert.equal(whole.deps, join(data, "deps"));
  assert.equal(whole.db, join(data, "ash.db"));
  assert.equal(whole.inherited, null, "ASH_DATA_DIR 读完必须从环境里拿掉，否则 agent / 预览子进程会继承它");
  // 这份测试跑在仓库检出里：代码根就是仓库。
  assert.equal(whole.repo, whole.code);

  // ── 相对路径按启动 cwd 解析成绝对路径 ──
  const relative = probe({ ASH_DATA_DIR: "rel-data" }, pathsProbe);
  assert.equal(relative.data, resolve("rel-data"));

  // ── 单项覆盖照旧优先 ──
  const runs = join(root, "other-runs");
  const db = join(root, "elsewhere", "x.db");
  const mixed = probe({ ASH_DATA_DIR: data, ASH_RUNS_DIR: runs, ASH_DB: db }, pathsProbe);
  assert.equal(mixed.runs, runs);
  assert.equal(mixed.db, db);
  assert.equal(mixed.uploads, join(data, "uploads"));

  // ── 不设：与改动前一致，锚在 <代码根>/data ──
  const plain = probe({ ASH_DB: join(root, "plain.db") }, pathsProbe);
  assert.equal(plain.data, join(String(plain.code), "data"));
  assert.equal(plain.runs, join(String(plain.code), "data", "runs"));

  // ── 本机自用开关：读到了、并且不往子进程传 ──
  const localOnly = probe({ ASH_LOCAL_ONLY: "1", ASH_DATA_DIR: data }, `
const { LOCAL_ONLY } = await import(${JSON.stringify(new URL("local-only.js", src).href)});
const out = { on: LOCAL_ONLY, inherited: process.env.ASH_LOCAL_ONLY ?? null };`);
  assert.deepEqual(localOnly, { on: true, inherited: null });
  const notLocal = probe({ ASH_DATA_DIR: data }, `
const { LOCAL_ONLY } = await import(${JSON.stringify(new URL("local-only.js", src).href)});
const out = { on: LOCAL_ONLY };`);
  assert.deepEqual(notLocal, { on: false });

  // ── MCP 登记写哪个 node ──
  const node = probe({ ASH_DATA_DIR: data }, `
const { CODE_DIR } = await import(${JSON.stringify(new URL("paths.js", src).href)});
const { mcpNodeCommand } = await import(${JSON.stringify(new URL("mcp-registry/register.js", src).href)});
const { join } = await import("node:path");
const bundled = join(CODE_DIR, "runtime", "bin", "node");
const out = {
  bundled, bundledPick: mcpNodeCommand(bundled, () => true),
  onPath: mcpNodeCommand("/opt/nvm/versions/node/v24/bin/node", () => true),
  noPath: mcpNodeCommand("/opt/nvm/versions/node/v24/bin/node", () => false),
};`);
  assert.equal(node.bundledPick, node.bundled, "自带运行时：写它的绝对路径（那台机器可能根本没装 node）");
  assert.equal(node.onPath, "node", "仓库实例：照旧写 node，nvm 升级后不会留下一个失效的绝对路径");
  assert.equal(node.noPath, "/opt/nvm/versions/node/v24/bin/node", "PATH 上没有 node：只剩自己这一份能跑");

  console.log("test-data-root: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

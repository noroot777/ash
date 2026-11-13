// 「代码目录只读、数据整体另放」的那几条入口（独立 app 就这么跑）：
//  · `ASH_DATA_DIR` 整体指定数据根，库 / runs / uploads / deps 都跟着走；单项覆盖仍然优先；
//  · 读完就从本进程环境里拿掉，子进程（agent、预览、终端）不继承；
//  · 代码根不是 git 检出时没有「自己的仓库」（REPO_DIR = null）；
//  · MCP 登记写哪个 node：自带运行时写绝对路径，否则照旧走 PATH 上的 `node`；
//  · 宿主那条启动的是 ash 自己的 MCP 脚本时，新隔离档只换脚本入口和跑不起来的 node，其余字段原样留；
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

  // ── 回填脚本的资源判定认同一个数据根 ──
  const { resolveRepairResources } = await import("../src/claude-usage-resources.js");
  const repair = resolveRepairResources({ apply: false, env: { ASH_DATA_DIR: data } });
  assert.equal(repair.runsDir, join(data, "runs"));
  assert.equal(repair.productionDb, join(data, "ash.db"));

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

  // ── 搬到独立 app 之后新建的隔离档：宿主那条启动的是 ash 自己的 MCP 脚本 → 只把脚本入口换成
  //    这一份、跑不起来的 node 换成能跑的，**其余字段（cwd/timeout/env/远端目标/工具白名单）原样留着**；
  //    用户自定义 / 远程的登记 → 原样搬 ──
  const moved = probe({ ASH_DATA_DIR: data }, `
const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const { CODE_DIR } = await import(${JSON.stringify(new URL("paths.js", src).href)});
const { registerAshMcp, mcpNodeCommand } = await import(${JSON.stringify(new URL("mcp-registry/register.js", src).href)});
const { launchesAshMcp, relocateHostFact } = await import(${JSON.stringify(new URL("mcp-registry/relocate.js", src).href)});
const root = ${JSON.stringify(join(root, "mcp-move"))};
const bench = async (name, claudeEntry, codexToml) => {
  const host = join(root, name, "home"), dir = join(root, name, "iso");
  mkdirSync(join(host, ".codex"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(host, ".claude.json"), JSON.stringify({ mcpServers: { ash: claudeEntry } }));
  writeFileSync(join(host, ".codex", "config.toml"), codexToml);
  const claude = await registerAshMcp({ agentType: "claude", dir, hostHome: host, env: {} });
  const codex = await registerAshMcp({ agentType: "codex", dir, hostHome: host, env: {} });
  return {
    claude, codex,
    claudeEntry: JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers.ash,
    codexText: readFileSync(join(dir, "config.toml"), "utf8"),
  };
};
// 旧检出 + 一个已经不存在的 node,外加用户自己的定制和一个只写在 HARNESS_URL 里的远端目标。
const tailored = await bench("tailored",
  { type: "stdio", command: "/gone/bin/node", args: ["/old-checkout/mcp/dist/index.js"], cwd: "/work", timeout: 120000,
    env: { HARNESS_URL: "https://remote.example:8443", ASH_RECONNECT_MS: "7000" } },
  [
    "[mcp_servers.ash]",
    'command = "/gone/bin/node"',
    'args = ["/old-checkout/mcp/dist/index.js"]',
    "startup_timeout_sec = 120",
    'enabled_tools = ["get_task"]',
    "",
    "[mcp_servers.ash.env]",
    'HARNESS_URL = "https://remote.example:8443"',
    'ASH_RECONNECT_MS = "7000"',
    "",
  ].join("\\n"));
// 用户挑的 node 跑得起来:不动它,只换脚本入口。
const ownNode = await bench("own-node",
  { command: process.execPath, args: ["/old-checkout/mcp/dist/index.js"] },
  '[mcp_servers.ash]\\ncommand = ' + JSON.stringify(process.execPath) + '\\nargs = ["/old-checkout/mcp/dist/index.js"]\\n');
// 合法但不是最简写法的 TOML:引号键、跨行数组、node 选项夹在脚本前。仍要搬成当前入口。
const multiline = await bench("multiline",
  { command: "node", args: ["--enable-source-maps", "/old-checkout/mcp/dist/index.js"] },
  [
    "[mcp_servers.ash]",
    'command = "/gone/bin/node"',
    '"args" = [',
    '  "--enable-source-maps",',
    '  "/old-checkout/mcp/dist/index.js", # 旧检出',
    "]",
    "startup_timeout_sec = 120",
    "",
  ].join("\\n"));
// 文件还在但不能执行的 node:按跑不起来算,换掉。
const deadNode = join(root, "dead", "bin", "node");
mkdirSync(join(root, "dead", "bin"), { recursive: true });
writeFileSync(deadNode, "", { mode: 0o644 });
const noexec = await bench("noexec",
  { command: deadNode, args: ["/old-checkout/mcp/dist/index.js"] },
  '[mcp_servers.ash]\\ncommand = ' + JSON.stringify(deadNode) + '\\nargs = ["/old-checkout/mcp/dist/index.js"]\\n');
const custom = await bench("custom",
  { type: "http", url: "https://ash.example/mcp" },
  '[mcp_servers.ash]\\ncommand = "/opt/my/ash-mcp"\\nargs = ["--fast"]\\n');
const to = { entry: "/new/mcp/dist/index.js", node: "/new/runtime/node", runnable: () => false };
const opencode = relocateHostFact({ status: "on", detail: "",
  raw: { type: "local", command: ["/gone/node", "/old/mcp/dist/index.js"], environment: { X: "1" }, timeout: 5 } }, to);
// 扫描器说是 ash 的脚本、块里却找不到那两条可改的语句:不许原样发布一条已知失效的登记。
const unmovable = relocateHostFact({ status: "on", detail: "", block: '[mcp_servers.ash]\\ncommand = "node"\\n',
  launch: { command: "node", args: ["/old/mcp/dist/index.js"], ashUrl: null } }, to);
const out = {
  built: existsSync(join(CODE_DIR, "mcp", "dist", "index.js")),
  entry: join(CODE_DIR, "mcp", "dist", "index.js"), node: mcpNodeCommand(), execPath: process.execPath,
  tailored, ownNode, multiline, noexec, custom, opencode: opencode.fact.raw, unmovable,
  shapes: [
    launchesAshMcp("node", ["/a/mcp/dist/index.js"]),
    launchesAshMcp("/usr/bin/node", ["/a/mcp/dist/index.js", "--x"]),
    launchesAshMcp("node", ["/a/my-mcp.js"]),
    launchesAshMcp("node", ["--inspect", "/a/mcp/dist/index.js"]),
    launchesAshMcp("/opt/my/ash-mcp", ["/a/mcp/dist/index.js"]),
  ],
};`) as Record<string, any>;
  assert.deepEqual(moved.shapes, [true, true, false, true, false], "认 node(可带选项)起 ash 自己那份 MCP 脚本的写法");
  // 纯函数那一层(不依赖本地有没有 build 过 MCP):
  assert.deepEqual(moved.opencode, {
    type: "local", command: ["/new/runtime/node", "/new/mcp/dist/index.js"], environment: { X: "1" }, timeout: 5,
  }, "opencode 那种数组写法:只换 node 和入口,别的键原样");
  assert.ok(typeof moved.unmovable.why === "string" && moved.unmovable.why.includes("/new/mcp/dist/index.js"),
    "改不动就报失败,并说清该改成什么");
  for (const bench of ["tailored", "ownNode", "multiline", "noexec"]) {
    assert.equal(moved[bench].claude.ok, true, `${bench}:claude`);
    assert.equal(moved[bench].codex.ok, true, `${bench}:codex`);
  }
  if (moved.built) {
    const { claudeEntry, codexText } = moved.tailored;
    assert.deepEqual(claudeEntry, {
      type: "stdio", command: moved.node, args: [moved.entry], cwd: "/work", timeout: 120000,
      env: { HARNESS_URL: "https://remote.example:8443", ASH_RECONNECT_MS: "7000" },
    }, "只换脚本入口和跑不起来的 node;cwd/timeout/env(含 HARNESS_URL 远端)原样留着");
    for (const kept of [
      "startup_timeout_sec = 120", 'enabled_tools = ["get_task"]', "[mcp_servers.ash.env]",
      'HARNESS_URL = "https://remote.example:8443"', 'ASH_RECONNECT_MS = "7000"',
      `command = ${JSON.stringify(moved.node)}`, `args = [${JSON.stringify(moved.entry)}]`,
    ]) assert.ok(codexText.includes(kept), `TOML 族:${kept}\n${codexText}`);
    assert.ok(!codexText.includes("/old-checkout/") && !codexText.includes("/gone/"), `TOML 族:旧位置不许留下\n${codexText}`);
    assert.deepEqual(moved.ownNode.claudeEntry, { command: moved.execPath, args: [moved.entry] }, "跑得起来的 node 不动");
    assert.ok(moved.ownNode.codexText.includes(`command = ${JSON.stringify(moved.execPath)}`));
    const ml = moved.multiline.codexText;
    assert.ok(ml.includes(`args = [${JSON.stringify("--enable-source-maps")}, ${JSON.stringify(moved.entry)}]`), `引号键 + 跨行数组 + node 选项:\n${ml}`);
    assert.ok(ml.includes(`command = ${JSON.stringify(moved.node)}`) && ml.includes("startup_timeout_sec = 120"), ml);
    assert.ok(!ml.includes("/old-checkout/") && !ml.includes("/gone/"), `旧位置不许留下:\n${ml}`);
    assert.deepEqual(moved.multiline.claudeEntry.args, ["--enable-source-maps", moved.entry], "JSON 族同理:选项留着,只换脚本");
    assert.equal(moved.noexec.claudeEntry.command, moved.node, "文件在但不能执行的 node 按跑不起来算");
    assert.ok(moved.noexec.codexText.includes(`command = ${JSON.stringify(moved.node)}`));
  } else {
    console.log("（没 build 过 mcp/dist/index.js：没有当前入口可换，退回原样搬，登记那一半跳过）");
    assert.deepEqual(moved.tailored.claudeEntry.args, ["/old-checkout/mcp/dist/index.js"]);
  }
  assert.deepEqual(moved.custom.claudeEntry, { type: "http", url: "https://ash.example/mcp" }, "远程登记原样搬");
  assert.ok(moved.custom.codexText.includes('command = "/opt/my/ash-mcp"'), "自定义启动命令原样搬");

  console.log("test-data-root: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

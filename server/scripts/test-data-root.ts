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
const { relocateHostFact, relocateLaunch } = await import(${JSON.stringify(new URL("mcp-registry/relocate.js", src).href)});
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
    claudeEntry: existsSync(join(dir, ".claude.json")) ? JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers?.ash : null,
    codexText: existsSync(join(dir, "config.toml")) ? readFileSync(join(dir, "config.toml"), "utf8") : null,
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
// 带独立取值的 node 选项夹在脚本前(第 4 轮审查):脚本照样认出来、换成当前入口,选项和它的值原样留着。
const boot = join(root, "boot.cjs");
mkdirSync(root, { recursive: true });
writeFileSync(boot, "");
const requireOpt = await bench("require",
  { command: "node", args: ["--require", boot, "/old-checkout/mcp/dist/index.js"] },
  '[mcp_servers.ash]\\ncommand = "node"\\nargs = ["--require", ' + JSON.stringify(boot) + ', "/old-checkout/mcp/dist/index.js"]\\n');
// 旧路径嵌在一条 shell 命令里:没法安全改写 → 登记失败,不许照搬一条起不来的还报成功。
const embedded = await bench("embedded",
  { command: "sh", args: ["-c", "exec node /old-checkout/mcp/dist/index.js"] },
  '[mcp_servers.ash]\\ncommand = "sh"\\nargs = ["-c", "exec node /old-checkout/mcp/dist/index.js"]\\n');
// 同一个值里先拿当前入口做检查、再跑旧入口(第 5 轮审查):出现过当前入口证明不了没有旧入口。
const current = join(CODE_DIR, "mcp", "dist", "index.js");
const mixedShell = "node --check " + JSON.stringify(current) + " && exec node /old-checkout/mcp/dist/index.js";
const mixed = await bench("mixed",
  { command: "/bin/sh", args: ["-c", mixedShell] },
  '[mcp_servers.ash]\\ncommand = "/bin/sh"\\nargs = ["-c", ' + JSON.stringify(mixedShell) + ']\\n');
// 启动方式换干净了,env 里还让 node 预加载旧入口:同样起不来,同样不许发布。
const nodeOptions = await bench("node-options",
  { command: "node", args: ["/old-checkout/mcp/dist/index.js"], env: { NODE_OPTIONS: "--require /old-checkout/mcp/dist/index.js" } },
  '[mcp_servers.ash]\\ncommand = "node"\\nargs = ["/old-checkout/mcp/dist/index.js"]\\n\\n[mcp_servers.ash.env]\\nNODE_OPTIONS = "--require /old-checkout/mcp/dist/index.js"\\n');
// 路径藏在 TOML 的合法转义里(第 6 轮审查):原文上看不见 mcp/dist,codex 解码后就是旧入口。
const escaped = await bench("escaped",
  { command: "node", args: ["-e", "require(process.env.ASH_ENTRY)"], env: { ASH_ENTRY: "/old-checkout/mcp/dist/index.js" } },
  '[mcp_servers.ash]\\ncommand = "node"\\nargs = ["-e", "require(process.env.ASH_ENTRY)"]\\n\\n[mcp_servers.ash.env]\\nASH_ENTRY = "/old-checkout/mcp\\\\u002fdist/index.js"\\n');
const custom = await bench("custom",
  { type: "http", url: "https://ash.example/mcp" },
  '[mcp_servers.ash]\\ncommand = "/opt/my/ash-mcp"\\nargs = ["--fast"]\\n');
const to = { entry: "/new/mcp/dist/index.js", node: "/new/runtime/node", runnable: () => false };
const opencode = relocateHostFact({ status: "on", detail: "",
  raw: { type: "local", command: ["/gone/node", "/old/mcp/dist/index.js"], environment: { X: "1" }, timeout: 5 } }, to);
// 旧路径嵌在选项值里、或者读不出 command:都改不动,报失败并说清该改成什么。
const unmovable = [
  '[mcp_servers.ash]\\ncommand = "node"\\nargs = ["--require=/old/mcp/dist/index.js"]\\n',
  '[mcp_servers.ash]\\nargs = ["/old/mcp/dist/index.js"]\\n',
].map((block) => relocateHostFact({ status: "on", detail: "", block }, to));
// 截出来的那段只有 command,扫整份文件得到的启动方式里才有旧脚本(启动字段写在表头之外):不许照搬那一段。
unmovable.push(relocateHostFact({ status: "on", detail: "", block: '[mcp_servers.ash]\\ncommand = "node"\\n',
  launch: { command: "node", args: ["/old/mcp/dist/index.js"], ashUrl: null } }, to));
// JSON 族同一道收口:目录写法(node 会解析到 index.js)、当前入口只是更长路径的一截。
const raw = (entry) => relocateHostFact({ status: "on", detail: "", raw: entry }, to);
unmovable.push(raw({ command: "node", args: ["/old/mcp/dist"] }));
unmovable.push(raw({ command: "sh", args: ["-c", "node /x/new/mcp/dist/index.js"] }));
unmovable.push(raw({ command: "node", args: ["/new/mcp/dist/index.js"], cwd: "/old/mcp/dist" }));
// 注释里提到旧路径不算引用;能换的照换。
const commented = relocateHostFact({ status: "on", detail: "",
  block: '[mcp_servers.ash]\\n# 以前是 /old/mcp/dist/index.js\\ncommand = "node"\\nargs = ["/old/mcp/dist/index.js"]\\n' }, to);
const L = (command, args) => relocateLaunch({ command, args }, to);
const out = {
  built: existsSync(join(CODE_DIR, "mcp", "dist", "index.js")),
  entry: join(CODE_DIR, "mcp", "dist", "index.js"), node: mcpNodeCommand(), execPath: process.execPath,
  tailored, ownNode, multiline, noexec, requireOpt, embedded, mixed, nodeOptions, escaped, custom, opencode: opencode.fact.raw,
  unmovable, commented,
  shapes: [
    L("node", ["--require", "/x/boot.cjs", "/old/mcp/dist/index.js"]),
    L("node", ["-r", "/x/boot.cjs", "--inspect", "/old/mcp/dist/index.js", "--x"]),
    L("/old/mcp/dist/index.js", ["--x"]),
    L("/opt/my/ash-mcp", ["/old/mcp/dist/index.js"]),
    L("node", ["/a/my-mcp.js"]),
    L("/new/runtime/node", ["/new/mcp/dist/index.js"]),
    L("node", ["--require=/old/mcp/dist/index.js"]),
    L("sh", ["-c", "node /old/mcp/dist/index.js"]),
    L("node", ["/Users/me/My Projects/ash/mcp/dist/index.js"]),
    L("cmd", ["/c", "C:\\\\node\\\\node.exe C:\\\\old\\\\mcp\\\\dist\\\\index.js"]),
    L("node", ["NODE_X=/old/mcp/dist/index.js"]),
    L("node", ["/new/./mcp/dist/index.js"]),
  ],
};`) as Record<string, any>;
  // 认脚本只看「整个值是不是一条 ash 脚本路径」,不解析 argv:位置、前面的选项、启动器都不限。
  const [req, withOpts, bare, launcher, unrelated, current, eqForm, shell, spaced, winShell, assign, dotted] = moved.shapes;
  assert.deepEqual(dotted.args, ["/new/mcp/dist/index.js"], "指着当前这份但写法不同:统一成当前入口的写法");
  assert.deepEqual(req, { command: "/new/runtime/node", args: ["--require", "/x/boot.cjs", "/new/mcp/dist/index.js"] },
    "--require <文件> 这类带独立取值的选项:取值原样留着,只换脚本");
  assert.deepEqual(withOpts.args, ["-r", "/x/boot.cjs", "--inspect", "/new/mcp/dist/index.js", "--x"]);
  assert.deepEqual(bare, { command: "/new/runtime/node", args: ["/new/mcp/dist/index.js", "--x"] }, "命令本身就是脚本:改成 node + 当前入口");
  assert.deepEqual(launcher, { command: "/opt/my/ash-mcp", args: ["/new/mcp/dist/index.js"] }, "自定义启动器:不换启动器,只换脚本");
  assert.equal(unrelated, null, "跟 ash 脚本无关的启动方式原样");
  assert.equal(current, null, "已经是当前这一份:原样");
  assert.deepEqual(spaced.args, ["/new/mcp/dist/index.js"], "路径里带空格照样是一条路径");
  for (const why of [eqForm, shell, winShell, assign]) {
    assert.ok(typeof why === "string" && why.includes("/new/mcp/dist/index.js"), `嵌着旧路径改不动:报失败并说清该改成什么(${why})`);
  }
  // 纯函数那一层(不依赖本地有没有 build 过 MCP):
  assert.deepEqual(moved.opencode, {
    type: "local", command: ["/new/runtime/node", "/new/mcp/dist/index.js"], environment: { X: "1" }, timeout: 5,
  }, "opencode 那种数组写法:只换 node 和入口,别的键原样");
  for (const result of moved.unmovable) {
    assert.ok(typeof result.why === "string" && result.why.includes("/new/mcp/dist/index.js"),
      `改不动就报失败,并说清该改成什么:${JSON.stringify(result)}`);
  }
  assert.ok(moved.commented.fact?.block.includes('args = ["/new/mcp/dist/index.js"]'), `注释不算引用:${JSON.stringify(moved.commented)}`);
  for (const bench of ["tailored", "ownNode", "multiline", "noexec", "requireOpt"]) {
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
    const boot = join(root, "mcp-move", "boot.cjs");
    assert.deepEqual(moved.requireOpt.claudeEntry.args, ["--require", boot, moved.entry], "JSON 族:--require <文件> 之后的旧脚本照样换掉");
    assert.ok(moved.requireOpt.codexText.includes(`args = [${["--require", boot, moved.entry].map((a) => JSON.stringify(a)).join(", ")}]`),
      `TOML 族:--require <文件> 之后的旧脚本照样换掉\n${moved.requireOpt.codexText}`);
    for (const family of ["claude", "codex"]) {
      assert.equal(moved.embedded[family].ok, false, `${family}:嵌在 shell 命令里的旧路径改不动,不许报成功`);
      assert.match(moved.embedded[family].why, /旧的安装位置/);
    }
    assert.ok(!moved.embedded.claudeEntry, "改不动就什么都不写进新隔离档");
    for (const [bench, field] of [["mixed", /旧的安装位置/], ["nodeOptions", /NODE_OPTIONS/], ["escaped", /ASH_ENTRY/]] as const) {
      for (const family of ["claude", "codex"]) {
        assert.equal(moved[bench][family].ok, false, `${bench}:${family} 还引用着旧入口,不许报成功`);
        assert.match(moved[bench][family].why, field, `${bench}:${family} 说清是哪一处`);
      }
      assert.ok(!moved[bench].claudeEntry && !moved[bench].codexText?.includes("/old-checkout/"), `${bench}:什么都不写`);
    }
    assert.ok(!moved.embedded.codexText?.includes("/old-checkout/"), "改不动就什么都不写进新隔离档");
  } else {
    console.log("（没 build 过 mcp/dist/index.js：没有当前入口可换，退回原样搬，登记那一半跳过）");
    assert.deepEqual(moved.tailored.claudeEntry.args, ["/old-checkout/mcp/dist/index.js"]);
  }
  assert.deepEqual(moved.custom.claudeEntry, { type: "http", url: "https://ash.example/mcp" }, "远程登记原样搬");
  assert.ok(moved.custom.codexText.includes('command = "/opt/my/ash-mcp"'), "自定义启动命令原样搬");

  // ── 收口判的是 CLI 解码后实际读到的值(纯函数,不依赖本地有没有 build 过 MCP) ──
  const { relocateHostFact, relocateLaunch } = await import("../src/mcp-registry/relocate.js");
  const { tomlStringValues } = await import("../src/codex-toml.js");
  assert.deepEqual(tomlStringValues(String.raw`["a\u002fb", 'c\d', "\U0001F600", """
x \
   y""", '''z''']`), ["a/b", "c\\d", "😀", "x y", "z"], "TOML 四种引法 + 转义 + 行尾反斜杠");
  assert.equal(tomlStringValues(String.raw`"\q"`), null, "不认的转义:解不开就是 null,不拿一截当整条");
  assert.equal(tomlStringValues(String.raw`"\/"`), null, "JSON 认、TOML 不认的转义");
  const target = { entry: "/new/mcp/dist/index.js", node: "/new/runtime/node", runnable: () => false };
  const block = (text: string) => relocateHostFact({ status: "on", detail: "", block: text }, target) as Record<string, any>;
  const raw = (entry: Record<string, unknown>) => relocateHostFact({ status: "on", detail: "", raw: entry }, target) as Record<string, any>;
  // 行尾注释 codex 不读:提到旧路径也不算引用(第 6 轮审查的另一半)。
  const comment = block('[mcp_servers.ash]\ncommand = "node"\nargs = ["/old/mcp/dist/index.js"]\n[mcp_servers.ash.env]\n'
    + 'HARNESS_URL = "https://r.example" # 原先在 /old/mcp/dist/index.js\n');
  assert.ok(comment.fact?.block.includes('args = ["/new/mcp/dist/index.js"]'), `行尾注释不算引用:${JSON.stringify(comment)}`);
  for (const [name, text] of [
    ["转义藏着的旧入口", String.raw`[mcp_servers.ash]
command = "node"
args = ["/new/mcp/dist/index.js"]
[mcp_servers.ash.env]
NODE_OPTIONS = "--require /old/mcp\u002Fdist/index.js"`],
    ["多行字符串里的旧入口", '[mcp_servers.ash]\ncommand = "sh"\nargs = ["-c", """\nexec node /old/mcp/dist/index.js"""]\n'],
    ["解不开的值", String.raw`[mcp_servers.ash]
command = "node"
args = ["/new/mcp/dist/index.js"]
[mcp_servers.ash.env]
X = "\q"`],
  ] as const) {
    const result = block(text);
    assert.ok(typeof result.why === "string" && result.why.includes("/new/mcp/dist/index.js"), `${name}:报失败并说清该改成什么 ${JSON.stringify(result)}`);
  }
  // 路径的等价写法:整值的照样认出来换掉,嵌着的照样拦下。
  assert.deepEqual(relocateLaunch({ command: "node", args: ["/old/mcp//dist/./index.js"] }, target),
    { command: "/new/runtime/node", args: ["/new/mcp/dist/index.js"] }, "分隔符连写、./ 的整值路径照样换");
  for (const [name, args] of [
    ["x/..", ["-c", "node /old/mcp/dist/../dist/index.js"]],
    ["反斜杠", ["/c", String.raw`node C:\old\mcp\dist\index.js`]],
    ["百分号编码", ["--import=file:///old/mcp%2Fdist/index.js"]],
    ["shell 引号拼接", ["-c", `node '/old/mcp/'"dist/index.js"`]],
  ] as const) {
    const result = raw({ command: "sh", args: [...args] });
    assert.ok(typeof result.why === "string", `${name}:${JSON.stringify(result)}`);
  }
  assert.ok(raw({ command: "sh", args: ["-c", 'exec node "/new/mcp/dist/index.js"'] }).fact, "只引用当前入口的 shell 包装照样搬");

  console.log("test-data-root: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

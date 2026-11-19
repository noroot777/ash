// 独立 app 首启「替本机 CLI 接好 navi MCP」(mcp-registry/host-setup.ts)：
//  · 只碰 PATH 上装了的那几家，没装的配置目录一个字节都不写；
//  · 没登记的补一条指向这份 navi 的（added），再问一次就是 ours；
//  · 已有登记指向别处（别的 MCP 入口 / 别的端口）一律不改，原样交回「现在指向哪、该改成什么」；
//  · pointsAt 的判据：node 真正执行的入口、命令、规范化后的完整地址三样都对上才算指向这里。
//
// 每个场景一个子进程、一个临时家目录(HOME 与 USERPROFILE 都指它)，碰不到用户的真 ~/.claude.json。
//
// Run: npm -w server run test:host-navi-mcp
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
// realpath：macOS 的临时目录是条软链，而模块自己的位置（代码根由它算）是解析过的那一个。
const root = realpathSync(mkdtempSync(join(tmpdir(), "navi-host-mcp-")));
// 从这里起建的东西(拷出来的代码树、借来的链接)都在 try 里:借包借到一半失败,已经建好的那几条
// 也得经过 finally 摘掉。
const links: string[] = [];

try {
  // 被测代码认的「这份 navi 的 MCP 入口」是 `<代码根>/mcp/dist/index.js`，一份构建产物：验收门禁的快照里
  // 没有它，开发机上有没有也看人。所以不拿真仓库当代码根，另摆一份：server/src 抄过去（代码根是按源文件
  // 自己的位置算的，软链会被解析回原处）、依赖用链借、入口放一个占位文件 —— 补接只认它在不在，不跑它。
  const codeRoot = join(root, "code");
  const serverDir = fileURLToPath(new URL("..", import.meta.url));
  cpSync(join(serverDir, "src"), join(codeRoot, "server", "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) copyFileSync(join(serverDir, file), join(codeRoot, "server", file));
  // 依赖**逐个按包**借:server 声明的每一个包,照 Node 从真 server 目录出发的查找顺序找到它住在
  // 哪,在拷出来的代码树里链一条过去。原先是整个借「往上第一个 node_modules」,而那个目录可能
  // 只装了一部分 —— win-remote 的工作区里 `node_modules` 只有 `@navi/*` 几条 junction,其余靠
  // 逐级向上解析到主仓,于是拷出来的那份找不到 drizzle-orm(2026-11-19 真机)。开发机的 worktree
  // 补了 `@navi/*` 软链之后也是同一个形状。
  const serverPkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  // 只借运行时的那两组:被测代码是被 import 来跑的,devDependencies(类型、tsx 本身)用不上 —— tsx 由
  // `--import` 按真检出的绝对地址给。
  const declared = [serverPkg.dependencies, serverPkg.optionalDependencies].flatMap((deps) => Object.keys(deps ?? {}));
  const lookup = createRequire(join(serverDir, "package.json")).resolve.paths("x") ?? [];
  const borrowed = join(codeRoot, "node_modules");
  for (const name of declared) {
    const home = lookup.map((dir) => join(dir, name)).find((dir) => existsSync(join(dir, "package.json")));
    if (!home) {
      // 可选依赖没装是正常的;必需的找不到就是这台机器的检出不全,当场说清是哪一个。
      assert.ok(serverPkg.optionalDependencies?.[name], `按 Node 的查找顺序找不到 server 声明的依赖 ${name}`);
      continue;
    }
    mkdirSync(dirname(join(borrowed, name)), { recursive: true });
    symlinkSync(home, join(borrowed, name), "junction");
    links.push(join(borrowed, name));
  }
  assert.ok(existsSync(join(borrowed, "drizzle-orm", "package.json")), "夹具前提:拷出来的代码树借得到依赖");
  const src = pathToFileURL(join(codeRoot, "server", "src") + sep);
  const mcpEntry = pathToFileURL(join(codeRoot, "mcp", "dist", "index.js"));
  const mcpEntryPath = fileURLToPath(mcpEntry); // 不用 URL 的 pathname:Windows 上那是 `/C:/…`,不是路径
  mkdirSync(dirname(fileURLToPath(mcpEntry)), { recursive: true });
  writeFileSync(mcpEntry, "// 占位：测试只要这个入口存在\n");

  function run(home: string, bin: string, body: string): Record<string, unknown> {
    const script = `${body}\nconsole.log("PROBE=" + JSON.stringify(out));`;
    // 家目录两个名字都给:Windows 上 `homedir()` 认的是 USERPROFILE,只给 HOME 的话它读写的是这台机器
    // 用户真实的 ~/.claude.json(2026-11-19 真机上就这样读到了真配置)。SystemRoot 是 Windows 上 node
    // 自己要的(没有它网络、加密那几块起不来),PATH 用平台分隔符拼。
    const system = process.platform === "win32"
      ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
      : ["/usr/bin", "/bin"];
    const env: Record<string, string> = {
      HOME: home, USERPROFILE: home, PATH: [bin, ...system].join(delimiter),
      NAVI_DATA_DIR: join(home, "data"), NAVI_DB: join(home, "data", "ash.db"),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const stdout = execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { env, encoding: "utf8" });
    const line = stdout.split("\n").find((l) => l.startsWith("PROBE="));
    assert.ok(line, `子进程没交回结果：\n${stdout}`);
    return JSON.parse(line.slice("PROBE=".length));
  }

  // resolveBin 除了 PATH 还会找 Homebrew、~/.local/bin 这些常见位置，所以开发机上真装着的 CLI 也会
  // 被认出来（它们的配置照样落在临时 HOME 里）。断言只钉 claude 这一家，其余按「装没装」对账。
  const setUp = `
  const { setUpHostNaviMcp } = await import(${JSON.stringify(new URL("mcp-registry/host-setup.js", src).href)});
  const { AGENT_TYPES } = await import("@navi/shared");
  const { resolveBin } = await import(${JSON.stringify(new URL("executors/bin-resolve.js", src).href)});
  const { cliSpec } = await import(${JSON.stringify(new URL("executors/catalog/index.js", src).href)});
  const { hostCliConfigFile } = await import(${JSON.stringify(new URL("auth/user-cli-mcp.js", src).href)});
  const { existsSync } = await import("node:fs");
  const hosts = await setUpHostNaviMcp();
  const reported = new Set(hosts.map((h) => h.agentType));
  const untouched = AGENT_TYPES.filter((t) => !cliSpec(t).bins.some((b) => resolveBin(b)))
    .every((t) => { const f = hostCliConfigFile(t); return !f || !existsSync(f); });
  const out = { claude: hosts.find((h) => h.agentType === "claude") ?? null, untouched,
    onlyInstalled: [...reported].every((t) => cliSpec(t).bins.some((b) => resolveBin(b))) };`;

  type SetUp = { claude: Record<string, string> | null; untouched: boolean; onlyInstalled: boolean };

  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // 只「装」claude：codex 等十几家都不在 PATH 上。Windows 上 PATH 查找只认 PATHEXT 里的后缀,
  // 不认 shebang,壳按平台换(docs/windows-testing.md 第三节)。
  if (process.platform === "win32") writeFileSync(join(bin, "claude.cmd"), "@exit /b 0\r\n");
  else {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
  }
  const claudeJson = join(home, ".claude.json");

  // ── 没登记：补一条指向这份 navi，只动装了的那家 ──
  let result = run(home, bin, setUp) as unknown as SetUp;
  assert.equal(result.claude?.state, "added", JSON.stringify(result));
  assert.ok(result.onlyInstalled, "只问装了的那几家");
  assert.ok(result.untouched, "没装的 CLI 不该被建配置");
  const written = JSON.parse(readFileSync(claudeJson, "utf8"));
  assert.deepEqual(written.mcpServers.navi.args, [mcpEntryPath]);
  assert.equal(written.mcpServers.navi.env.NAVI_URL, "http://127.0.0.1:4317");

  // ── 再问一次：已经指向这里 ──
  result = run(home, bin, setUp) as unknown as SetUp;
  assert.equal(result.claude?.state, "ours");

  // ── 指向别处：不改，原样交回 ──
  const foreign = JSON.stringify({
    keep: "user stuff",
    mcpServers: { navi: { type: "stdio", command: "node", args: ["/Users/someone/code/navi/mcp/dist/index.js"], env: { NAVI_URL: "http://127.0.0.1:4317" } } },
  }, null, 2);
  writeFileSync(claudeJson, foreign);
  result = run(home, bin, setUp) as unknown as SetUp;
  const claude = result.claude!;
  assert.equal(claude.state, "elsewhere");
  assert.ok(claude.current!.includes("/Users/someone/code/navi/mcp/dist/index.js"), claude.current);
  // 交回的是配置原文,路径在里面是 JSON 字符串的写法(Windows 上 `\` 成对)。
  assert.ok(claude.wanted!.includes(JSON.stringify(mcpEntryPath)), claude.wanted);
  assert.equal(claude.file, claudeJson);
  assert.equal(readFileSync(claudeJson, "utf8"), foreign, "指向别处的登记一个字节都不许改");

  // ── pointsAt：node 真正执行的入口、命令、完整地址都要对上（只有本机回环别名算同一台）──
  const points = run(home, bin, `
const { pointsAt } = await import(${JSON.stringify(new URL("mcp-registry/host-setup.js", src).href)});
const wanted = { command: "/app/node", args: [${JSON.stringify(mcpEntryPath)}], env: { NAVI_URL: "http://127.0.0.1:4317" } };
const entry = wanted.args[0];
const out = {
  same: pointsAt({ command: "/app/node", args: [entry], naviUrl: "http://localhost:4317" }, wanted),
  defaultUrl: pointsAt({ command: "/app/node", args: [entry], naviUrl: null }, wanted),
  otherPort: pointsAt({ command: "/app/node", args: [entry], naviUrl: "http://127.0.0.1:14317" }, wanted),
  otherNode: pointsAt({ command: "node", args: [entry], naviUrl: null }, wanted),
  otherEntry: pointsAt({ command: "/app/node", args: ["/elsewhere/mcp/dist/index.js"], naviUrl: null }, wanted),
  bareNode: pointsAt({ command: "node", args: [entry], naviUrl: null }, { ...wanted, command: "node" }),
  withOptions: pointsAt({ command: "/app/node", args: ["--import", "/x/hook.mjs", "--no-warnings", entry], naviUrl: "http://[::1]:4317/" }, wanted),
  otherHost: pointsAt({ command: "/app/node", args: [entry], naviUrl: "http://192.0.2.1:4317" }, wanted),
  otherScheme: pointsAt({ command: "/app/node", args: [entry], naviUrl: "https://127.0.0.1:4317" }, wanted),
  otherPath: pointsAt({ command: "/app/node", args: [entry], naviUrl: "http://127.0.0.1:4317/another-navi" }, wanted),
  sameHostName: pointsAt({ command: "/app/node", args: [entry], naviUrl: "http://remote.example:4317" },
    { ...wanted, env: { NAVI_URL: "http://REMOTE.example:4317/" } }),
  evalMode: pointsAt({ command: "/app/node", args: ["--eval", "1", entry], naviUrl: null }, wanted),
  entryAsArgument: pointsAt({ command: "/app/node", args: ["/elsewhere/proxy.js", entry], naviUrl: null }, wanted),
  entryAfterValueOption: pointsAt({ command: "/app/node", args: ["--require", entry, "/elsewhere/index.js"], naviUrl: null }, wanted),
  garbageUrl: pointsAt({ command: "/app/node", args: [entry], naviUrl: "not a url" }, wanted),
};`);
  assert.deepEqual(points, {
    same: true, defaultUrl: true, otherPort: false, otherNode: false, otherEntry: false, bareNode: true,
    withOptions: true, otherHost: false, otherScheme: false, otherPath: false, sameHostName: true,
    evalMode: false, entryAsArgument: false, entryAfterValueOption: false, garbageUrl: false,
  });

  console.log("test-host-navi-mcp: ok");
} finally {
  // 借来的链接先一条条摘掉、再删目录:它们指着这台机器真装着的依赖(win-remote 的工作区里就是
  // 对端主仓的 node_modules),删目录时一旦顺着链接进去,删的就是人家的依赖。
  // 一条摘不掉不能挡住后面几条;有摘不掉的就不删目录(那条链接还连着真依赖),报出来留给人看。
  const stuck = links.flatMap((link) => {
    try {
      unlinkSync(link);
      return [];
    } catch (error) {
      return [`${link}: ${(error as Error).message}`];
    }
  });
  if (stuck.length) throw new Error(`借来的依赖链接摘不掉,临时目录 ${root} 没删:\n${stuck.join("\n")}`);
  rmSync(root, { recursive: true, force: true });
}

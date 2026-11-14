// 独立 app 首启「替本机 CLI 接好 ash MCP」(mcp-registry/host-setup.ts)：
//  · 只碰 PATH 上装了的那几家，没装的配置目录一个字节都不写；
//  · 没登记的补一条指向这份 ash 的（added），再问一次就是 ours；
//  · 已有登记指向别处（别的 MCP 入口 / 别的端口）一律不改，原样交回「现在指向哪、该改成什么」；
//  · pointsAt 的判据：node 真正执行的入口、命令、规范化后的完整地址三样都对上才算指向这里。
//
// 每个场景一个子进程、一个临时 HOME：homedir() 认 HOME，碰不到用户的真 ~/.claude.json。
//
// Run: npm -w server run test:host-ash-mcp
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const src = new URL("../src/", import.meta.url);
const mcpEntry = new URL("../../mcp/dist/index.js", import.meta.url);
assert.ok(existsSync(mcpEntry), "先 build 出 mcp/dist（npm -w mcp run build）：补接要指向一个真实存在的入口");

function run(home: string, bin: string, body: string): Record<string, unknown> {
  const script = `${body}\nconsole.log("PROBE=" + JSON.stringify(out));`;
  const env: Record<string, string> = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, ASH_DATA_DIR: join(home, "data"), ASH_DB: join(home, "data", "ash.db"),
  };
  const stdout = execFileSync(process.execPath, ["--import", tsx, "--input-type=module", "-e", script], { env, encoding: "utf8" });
  const line = stdout.split("\n").find((l) => l.startsWith("PROBE="));
  assert.ok(line, `子进程没交回结果：\n${stdout}`);
  return JSON.parse(line.slice("PROBE=".length));
}

// resolveBin 除了 PATH 还会找 Homebrew、~/.local/bin 这些常见位置，所以开发机上真装着的 CLI 也会
// 被认出来（它们的配置照样落在临时 HOME 里）。断言只钉 claude 这一家，其余按「装没装」对账。
const setUp = `
const { setUpHostAshMcp } = await import(${JSON.stringify(new URL("mcp-registry/host-setup.js", src).href)});
const { AGENT_TYPES } = await import("@ash/shared");
const { resolveBin } = await import(${JSON.stringify(new URL("executors/bin-resolve.js", src).href)});
const { cliSpec } = await import(${JSON.stringify(new URL("executors/catalog/index.js", src).href)});
const { hostCliConfigFile } = await import(${JSON.stringify(new URL("auth/user-cli-mcp.js", src).href)});
const { existsSync } = await import("node:fs");
const hosts = await setUpHostAshMcp();
const reported = new Set(hosts.map((h) => h.agentType));
const untouched = AGENT_TYPES.filter((t) => !cliSpec(t).bins.some((b) => resolveBin(b)))
  .every((t) => { const f = hostCliConfigFile(t); return !f || !existsSync(f); });
const out = { claude: hosts.find((h) => h.agentType === "claude") ?? null, untouched,
  onlyInstalled: [...reported].every((t) => cliSpec(t).bins.some((b) => resolveBin(b))) };`;

type SetUp = { claude: Record<string, string> | null; untouched: boolean; onlyInstalled: boolean };

const root = mkdtempSync(join(tmpdir(), "ash-host-mcp-"));
try {
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // 只「装」claude：codex 等十几家都不在 PATH 上。
  writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "claude"), 0o755);
  const claudeJson = join(home, ".claude.json");

  // ── 没登记：补一条指向这份 ash，只动装了的那家 ──
  let result = run(home, bin, setUp) as unknown as SetUp;
  assert.equal(result.claude?.state, "added", JSON.stringify(result));
  assert.ok(result.onlyInstalled, "只问装了的那几家");
  assert.ok(result.untouched, "没装的 CLI 不该被建配置");
  const written = JSON.parse(readFileSync(claudeJson, "utf8"));
  assert.deepEqual(written.mcpServers.ash.args, [new URL(mcpEntry).pathname]);
  assert.equal(written.mcpServers.ash.env.ASH_URL, "http://127.0.0.1:4317");

  // ── 再问一次：已经指向这里 ──
  result = run(home, bin, setUp) as unknown as SetUp;
  assert.equal(result.claude?.state, "ours");

  // ── 指向别处：不改，原样交回 ──
  const foreign = JSON.stringify({
    keep: "user stuff",
    mcpServers: { ash: { type: "stdio", command: "node", args: ["/Users/someone/code/ash/mcp/dist/index.js"], env: { ASH_URL: "http://127.0.0.1:4317" } } },
  }, null, 2);
  writeFileSync(claudeJson, foreign);
  result = run(home, bin, setUp) as unknown as SetUp;
  const claude = result.claude!;
  assert.equal(claude.state, "elsewhere");
  assert.ok(claude.current!.includes("/Users/someone/code/ash/mcp/dist/index.js"), claude.current);
  assert.ok(claude.wanted!.includes(new URL(mcpEntry).pathname), claude.wanted);
  assert.equal(claude.file, claudeJson);
  assert.equal(readFileSync(claudeJson, "utf8"), foreign, "指向别处的登记一个字节都不许改");

  // ── pointsAt：node 真正执行的入口、命令、完整地址都要对上（只有本机回环别名算同一台）──
  const points = run(home, bin, `
const { pointsAt } = await import(${JSON.stringify(new URL("mcp-registry/host-setup.js", src).href)});
const wanted = { command: "/app/node", args: [${JSON.stringify(new URL(mcpEntry).pathname)}], env: { ASH_URL: "http://127.0.0.1:4317" } };
const entry = wanted.args[0];
const out = {
  same: pointsAt({ command: "/app/node", args: [entry], ashUrl: "http://localhost:4317" }, wanted),
  defaultUrl: pointsAt({ command: "/app/node", args: [entry], ashUrl: null }, wanted),
  otherPort: pointsAt({ command: "/app/node", args: [entry], ashUrl: "http://127.0.0.1:14317" }, wanted),
  otherNode: pointsAt({ command: "node", args: [entry], ashUrl: null }, wanted),
  otherEntry: pointsAt({ command: "/app/node", args: ["/elsewhere/mcp/dist/index.js"], ashUrl: null }, wanted),
  bareNode: pointsAt({ command: "node", args: [entry], ashUrl: null }, { ...wanted, command: "node" }),
  withOptions: pointsAt({ command: "/app/node", args: ["--import", "/x/hook.mjs", "--no-warnings", entry], ashUrl: "http://[::1]:4317/" }, wanted),
  otherHost: pointsAt({ command: "/app/node", args: [entry], ashUrl: "http://192.0.2.1:4317" }, wanted),
  otherScheme: pointsAt({ command: "/app/node", args: [entry], ashUrl: "https://127.0.0.1:4317" }, wanted),
  otherPath: pointsAt({ command: "/app/node", args: [entry], ashUrl: "http://127.0.0.1:4317/another-ash" }, wanted),
  sameHostName: pointsAt({ command: "/app/node", args: [entry], ashUrl: "http://remote.example:4317" },
    { ...wanted, env: { ASH_URL: "http://REMOTE.example:4317/" } }),
  evalMode: pointsAt({ command: "/app/node", args: ["--eval", "1", entry], ashUrl: null }, wanted),
  entryAsArgument: pointsAt({ command: "/app/node", args: ["/elsewhere/proxy.js", entry], ashUrl: null }, wanted),
  entryAfterValueOption: pointsAt({ command: "/app/node", args: ["--require", entry, "/elsewhere/index.js"], ashUrl: null }, wanted),
  garbageUrl: pointsAt({ command: "/app/node", args: [entry], ashUrl: "not a url" }, wanted),
};`);
  assert.deepEqual(points, {
    same: true, defaultUrl: true, otherPort: false, otherNode: false, otherEntry: false, bareNode: true,
    withOptions: true, otherHost: false, otherScheme: false, otherPath: false, sameHostName: true,
    evalMode: false, entryAsArgument: false, entryAfterValueOption: false, garbageUrl: false,
  });

  console.log("test-host-ash-mcp: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

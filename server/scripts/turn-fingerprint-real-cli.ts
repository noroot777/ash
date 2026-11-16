// test-turn-fingerprint.ts 里要真 CLI 的那两段。只走到「启动报告」那一步就收手:claude 拿到 init、
// codex 拿到 ash 的 startupStatus,不调模型、不花额度;各用临时配置目录,不碰用户的。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { claudeAshMcpProblem, CodexAshMcpStatus } from "../src/executors/ash-mcp-confirm.js";
import { claudeAshMcpInjection, codexAshMcpArgs } from "../src/executors/ash-mcp-inject.js";
import { resolveLaunch } from "../src/executors/bin-resolve.js";
import { withoutTurnIdentity } from "../src/turn-identity.js";

type Env = Record<string, string | undefined>;
type Picked = { taskId: string; turnToken: string; refused: string | null };

export type RealCliContext = {
  root: string;
  /** MCP 桩的登记:真 resolveTurnIdentity 挑身份、落盘,拒绝就退出 */
  entry: { command: string; args: string[]; env: Record<string, string> };
  /** 本回合的身份变量,不带 PATH 上的身份目录 */
  currentVars: Env;
  /** 真任务回合的起跑环境:变量 + PATH 上的身份目录(turnIdentityEnv) */
  currentEnv: Env;
  stale: Record<string, string>;
  allStale: Record<string, string>;
  current: { taskId: string; turnToken: string };
  /** 团队调度台的任务 id:它的起跑环境只有这一个变量(team/session.ts) */
  lead: string;
  /** 桩这一次挑出的身份(读完即删);桩没起来就是 null */
  picked: () => Picked | null;
};

// 跑这个测试的进程自己可能就在一个 ash 回合里:它的身份变量和 PATH 上的身份目录一律摘掉。
const baseEnv = (): Env => withoutTurnIdentity({ ...process.env });

const errorText = (e: AgentEvent | null) => (e?.kind === "error" ? e.message : "");

/** 真 claude:settings.json 的 env 写死旧身份。 */
export async function checkRealClaude(ctx: RealCliContext): Promise<void> {
  if (!resolveLaunch("claude", ["--version"])) { console.log("⚠ 没装 claude,跳过真 claude 那一段"); return; }
  const probe = async (settingsEnv: Record<string, string>, spawnEnv: Env) => {
    const home = mkdtempSync(join(ctx.root, "claude-home-"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ env: settingsEnv }));
    const injection = claudeAshMcpInjection(spawnEnv, { entry: ctx.entry, dir: join(home, "inject") });
    const plan = resolveLaunch("claude", ["-p", "--output-format", "stream-json", "--verbose", "--max-turns", "1", ...injection.args])!;
    const child = spawn(plan.file, plan.args, {
      cwd: home, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
      // 模型端点指到死端口、key 是占位:init 一到就收手,不会真发请求。
      env: { ...baseEnv(), ...spawnEnv, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: "ash-test-not-a-key",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    let out = "";
    child.stdout!.on("data", (d) => { out += d; if (out.includes('"subtype":"init"')) child.kill(); });
    child.stdin!.end("Say OK");
    const timer = setTimeout(() => child.kill(), 30_000);
    await new Promise((r) => child.once("close", r));
    clearTimeout(timer);
    const init = out.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
      .find((e) => e.type === "system" && e.subtype === "init");
    assert.ok(init, `真 claude 没给出 init:${out.slice(0, 500)}`);
    return { picked: ctx.picked(), problem: claudeAshMcpProblem(injection, init.mcp_servers, init.tools) };
  };

  const recovered = await probe(ctx.stale, ctx.currentEnv);
  assert.equal(recovered.picked?.taskId, ctx.current.taskId, `settings.env 换掉了正名:MCP 照样拿到本回合身份:${JSON.stringify(recovered.picked)}`);
  assert.equal(recovered.picked?.turnToken, ctx.current.turnToken);
  assert.equal(recovered.problem, null, "接上的是本回合身份 ⇒ 不出声");

  // 变量全被换掉、又没有 PATH 那条(比如身份目录没写下来)
  const refused = await probe(ctx.allStale, ctx.currentVars);
  assert.match(refused.picked?.refused ?? "", /回合身份对不上/, "所有通道都是旧的 ⇒ MCP 拒绝启动");
  assert.match(errorText(refused.problem), /ash 的工具在这一回合没接上（claude 启动时报告 ash MCP 的状态是 failed/,
    "不再是 connected 却交不了卷:ash 留下一条持久诊断");

  const side = await probe(ctx.stale, withoutTurnIdentity({}));
  assert.deepEqual([side.picked?.taskId, side.picked?.turnToken, side.picked?.refused], ["", "", null],
    "非任务回合:配置里写死的旧身份不认");
  assert.equal(side.problem, null);

  const team = await probe({ ASH_TURN_TOKEN: "turn-old" }, { ASH_TASK_ID: ctx.lead });
  assert.deepEqual([team.picked?.taskId, team.picked?.turnToken, team.picked?.refused], [ctx.lead, "", null],
    "团队调度台:带着自己的任务 id 连上,不捎配置里残留的旧令牌");
  assert.equal(team.problem, null);
  console.log("✓ 真 claude:settings.env 写死旧身份时接上本回合那份;全是旧的 ⇒ ash 没接上并留诊断;非任务回合不认旧身份;团队调度台保住任务 id");
}

/** 真 codex app-server:[mcp_servers.ash.env] 写死旧身份。只走到 thread/start,不发 turn/start。 */
export async function checkRealCodex(ctx: RealCliContext): Promise<void> {
  if (!resolveLaunch("codex", ["app-server", "--stdio"])) { console.log("⚠ 没装 codex,跳过真 codex 那一段"); return; }
  const probe = async (staticEnv: Record<string, string>, spawnEnv: Env) => {
    const home = mkdtempSync(join(ctx.root, "codex-home-"));
    mkdirSync(home, { recursive: true });
    const lines = Object.entries(staticEnv).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
    writeFileSync(join(home, "config.toml"), `[mcp_servers.ash]\ncommand = "unused"\n[mcp_servers.ash.env]\n${lines}\n`);
    const launch = resolveLaunch("codex", ["app-server", "--stdio", ...codexAshMcpArgs(spawnEnv, ctx.entry)])!;
    const child = spawn(launch.file, launch.args, {
      cwd: home, env: { ...baseEnv(), ...spawnEnv, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true as const } : {}),
    });
    const status = new CodexAshMcpStatus();
    const said: AgentEvent[] = [];
    const waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let next = 0;
    let settled: () => void = () => {};
    const ashDone = new Promise<void>((r) => { settled = r; });
    // 每一问都有界:codex 卡住不答时照样走到 finally 收掉进程,而不是把整条验收挂到哨兵超时。
    const request = (method: string, params: unknown, timeoutMs = 15_000) => new Promise<unknown>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`codex ${method} ${timeoutMs}ms 没应答`)); }, timeoutMs);
      const done = <T>(f: (v: T) => void) => (v: T) => { clearTimeout(timer); waiters.delete(id); f(v); };
      waiters.set(id, { resolve: done(resolve), reject: done(reject) });
      child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    child.once("exit", (code) => {
      for (const w of [...waiters.values()]) w.reject(new Error(`codex app-server 退出了(${code})`));
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let m: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
      try { m = JSON.parse(line); } catch { return; }
      if (m.id !== undefined && !m.method) {
        const w = waiters.get(m.id);
        if (m.error) w?.reject(new Error(JSON.stringify(m.error)));
        else w?.resolve(m.result);
        return;
      }
      if (m.method !== "mcpServer/startupStatus/updated") return;
      const e = status.update(m.params!);
      if (e) said.push(e);
      status.checkTools(request, m.params!.threadId, (x) => said.push(x));
      if (m.params!.name === "ash" && m.params!.status !== "starting") settled();
    });
    try {
      await request("initialize", { clientInfo: { name: "ash-test", version: "1" }, capabilities: { experimentalApi: true } });
      child.stdin!.write('{"method":"initialized"}\n');
      await request("thread/start", { cwd: home, approvalPolicy: "never", sandbox: "danger-full-access" });
      await Promise.race([ashDone, new Promise((r) => setTimeout(r, 20_000))]);
      const e = await status.settle(10_000);
      if (e) said.push(e);
      return { picked: ctx.picked(), said };
    } finally {
      child.kill();
      await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("close", r)));
    }
  };

  const recovered = await probe(ctx.stale, ctx.currentEnv);
  assert.equal(recovered.picked?.taskId, ctx.current.taskId, `登记里写死了旧身份:MCP 照样拿到本回合身份:${JSON.stringify(recovered.picked)}`);
  assert.equal(recovered.picked?.turnToken, ctx.current.turnToken);
  assert.deepEqual(recovered.said, [], "接上的是本回合身份 ⇒ 不出声");

  // 变量全被换掉、又没有 PATH 那条(比如身份目录没写下来)
  const refused = await probe(ctx.allStale, ctx.currentVars);
  assert.match(refused.picked?.refused ?? "", /回合身份对不上/, "所有通道都是旧的 ⇒ MCP 拒绝启动");
  assert.equal(refused.said.length, 1, `ash 留下一条诊断:${JSON.stringify(refused.said)}`);
  assert.match(errorText(refused.said[0]!), /ash 的工具在这一回合没接上（codex 报告 ash MCP 启动失败/);

  const side = await probe(ctx.stale, withoutTurnIdentity({}));
  assert.deepEqual([side.picked?.taskId, side.picked?.turnToken, side.picked?.refused], ["", "", null],
    "非任务回合:登记里写死的旧身份不认");
  assert.deepEqual(side.said, []);

  const team = await probe({ ASH_TURN_TOKEN: "turn-old" }, { ASH_TASK_ID: ctx.lead });
  assert.deepEqual([team.picked?.taskId, team.picked?.turnToken, team.picked?.refused], [ctx.lead, "", null],
    "团队调度台:带着自己的任务 id 连上,不捎登记里写死的旧令牌");
  assert.deepEqual(team.said, []);
  console.log("✓ 真 codex app-server:登记 env 写死旧身份时接上本回合那份;全是旧的 ⇒ ash 没接上并留诊断;非任务回合不认旧身份;团队调度台保住任务 id");
}

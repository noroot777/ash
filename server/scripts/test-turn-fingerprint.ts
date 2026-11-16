// 回合身份防配置覆盖:ash 注入的 MCP 登记带着本回合指纹,MCP 只认对得上它的那份身份
// (shared/src/turn-fingerprint.ts、mcp/src/turn-identity.ts、server/src/executors/ash-mcp-inject.ts)。
//
//   1. MCP 侧挑身份:没指纹照旧逐项取;指纹是「无身份」时哪条通道里有都不认;正名被换掉时从别名 /
//      PATH 里挑出对得上的那份;一份都对不上就拒绝启动;团队调度台只有任务 id,保住它、不捎旧令牌
//   2. server 侧注入:claude 的注入文件按回合写在任务自己的 runs 目录、写新的删旧的;非任务回合写明
//      无身份;codex 的 `-c` 里带指纹、不带令牌值
//   3. 真 claude:settings.json 的 env 写死了旧身份 —— 照样接上本回合的身份;所有通道都是旧的 ⇒
//      MCP 不起来、init 报 failed、ash 留诊断;非任务回合不继承配置里的旧身份;团队调度台保住任务 id
//   4. 真 codex app-server:[mcp_servers.ash.env] 写死了旧身份,同上四种
//
// MCP 用的是一个桩:真 resolveTurnIdentity 挑身份(落盘给测试看),拒绝就退出,否则只答握手。
// 不调模型、不碰用户的 CLI 配置。没装对应 CLI 就跳过那一段(打一行 ⚠)。
//
// 跑:npx tsx scripts/test-turn-fingerprint.ts(cwd = server)
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ASH_MCP_TOOLS } from "@ash/shared/mcp";
import { ASH_TURN_FINGERPRINT_ENV, turnFingerprint } from "@ash/shared/turn-fingerprint";

const root = mkdtempSync(join(tmpdir(), "ash-turn-fingerprint-"));
process.env.ASH_DATA_DIR = join(root, "data");

const current = { taskId: "task-now", turnToken: "turn-now", directionToken: "dir-now" };
const fp = turnFingerprint(current);
const currentVars = {
  ASH_TASK_ID: current.taskId, ASH_TURN_TOKEN: current.turnToken, ASH_DIRECTION_TOKEN: current.directionToken,
  ASH_TURN_TICKET: current.turnToken, ASH_DIRECTION_TICKET: current.directionToken,
};
const stale = { ASH_TASK_ID: "task-old", ASH_TURN_TOKEN: "turn-old", ASH_DIRECTION_TOKEN: "dir-old" };
const allStale = { ...stale, ASH_TURN_TICKET: "turn-old", ASH_DIRECTION_TICKET: "dir-old" };

try {
  const { resolveTurnIdentity } = await import("../../mcp/src/turn-identity.js");
  const { claudeAshMcpInjection, codexAshMcpArgs } = await import("../src/executors/ash-mcp-inject.js");
  const { withoutTurnIdentity } = await import("../src/turn-identity.js");
  // paths.js 必须在设好 ASH_DATA_DIR 之后再加载(它在加载时就定下数据目录),所以不静态导入。
  const { RUNS_DIR, DATA_DIR } = await import("../src/paths.js");

  // ── 1. MCP 侧挑身份 ───────────────────────────────────────────────────────
  {
    const pathDir = (id: typeof current) => {
      const dir = join(root, "path-identity", id.taskId, "turn-identity", id.turnToken);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "identity.json"), JSON.stringify(id));
      return dir;
    };
    const pick = (env: Record<string, string | undefined>) => resolveTurnIdentity(env);
    const ok = { ...current, refused: null };

    assert.deepEqual(pick({ ...stale }), { taskId: "task-old", turnToken: "turn-old", directionToken: "dir-old", refused: null },
      "没带指纹(ash 不注入的那几家):照旧逐项取,正名优先");
    assert.deepEqual(pick({ ASH_TASK_ID: "t", ASH_TURN_TICKET: "k" }), { taskId: "t", turnToken: "k", directionToken: "", refused: null },
      "没带指纹:正名被过滤掉时退到别名");
    assert.deepEqual(pick({ ...currentVars, [ASH_TURN_FINGERPRINT_ENV]: fp }), ok, "对得上:照常");
    assert.deepEqual(pick({ ...currentVars, ASH_TURN_TOKEN: "turn-old", ASH_DIRECTION_TOKEN: "dir-old", [ASH_TURN_FINGERPRINT_ENV]: fp }), ok,
      "两个令牌的正名被配置换成旧的:从别名里挑出本回合那份");
    assert.deepEqual(pick({ ...currentVars, ...stale, PATH: pathDir(current), [ASH_TURN_FINGERPRINT_ENV]: fp }), ok,
      "任务 id 也被换掉(它只有正名一个变量):从 PATH 上的身份文件里挑");
    assert.match(pick({ ...currentVars, ...stale, [ASH_TURN_FINGERPRINT_ENV]: fp }).refused ?? "", /回合身份对不上/,
      "任务 id 被换掉、又没有 PATH 那条:拒绝,不拿旧任务 id 配新令牌");
    assert.deepEqual(pick({ ...allStale, PATH: ["/usr/bin", pathDir(current)].join(delimiter), [ASH_TURN_FINGERPRINT_ENV]: fp }), ok,
      "变量全被换掉:从 PATH 上的身份文件里挑");
    assert.deepEqual(pick({ ...allStale, ASH_TASK_ID: current.taskId, ASH_TURN_TICKET: current.turnToken, ASH_DIRECTION_TICKET: "dir-old",
      ASH_DIRECTION_TOKEN: current.directionToken, [ASH_TURN_FINGERPRINT_ENV]: fp }), ok, "各项分别从不同通道来也挑得出来");
    const noDirection = turnFingerprint({ ...current, directionToken: "" });
    assert.deepEqual(pick({ ASH_TASK_ID: current.taskId, ASH_TURN_TOKEN: current.turnToken, [ASH_TURN_FINGERPRINT_ENV]: noDirection }),
      { ...current, directionToken: "", refused: null }, "回合没有方向令牌时按空串对");

    const refused = pick({ ...allStale, PATH: pathDir({ taskId: "task-old", turnToken: "turn-old-2", directionToken: "d" }), [ASH_TURN_FINGERPRINT_ENV]: fp });
    assert.equal(refused.taskId + refused.turnToken + refused.directionToken, "", "对不上:一份身份都不带");
    assert.match(refused.refused ?? "", /回合身份对不上 ash 注入的回合指纹/);
    assert.match(refused.refused ?? "", /settings\.json 里的 env/, "说清多半是哪里写死了");
    assert.match(pick({ [ASH_TURN_FINGERPRINT_ENV]: fp }).refused ?? "", /一份身份都没收到/);

    const leadFp = turnFingerprint({ taskId: "lead", turnToken: "", directionToken: "" });
    assert.deepEqual(pick({ ASH_TASK_ID: "lead", ASH_TURN_TOKEN: "turn-old", [ASH_TURN_FINGERPRINT_ENV]: leadFp }),
      { taskId: "lead", turnToken: "", directionToken: "", refused: null },
      "团队调度台(只有任务 id):保住来源任务 id,不捎配置里残留的旧令牌");
    assert.match(pick({ ASH_TASK_ID: "task-old", [ASH_TURN_FINGERPRINT_ENV]: leadFp }).refused ?? "", /回合身份对不上/,
      "团队调度台的任务 id 被换成别的:照样拒绝");
    assert.deepEqual(pick({ ...allStale, PATH: pathDir(current), [ASH_TURN_FINGERPRINT_ENV]: "none" }),
      { taskId: "", turnToken: "", directionToken: "", refused: null }, "非任务回合:哪条通道里有都不认,也不拒绝启动");
    console.log("✓ MCP 挑身份:没指纹逐项取、对得上的那份从任一通道挑出、对不上拒绝启动、团队只认任务 id、无身份一律不认");
  }

  // ── 2. server 侧注入 ──────────────────────────────────────────────────────
  {
    const entry = { command: "node", args: ["/code/mcp/dist/index.js"], env: { ASH_URL: "http://127.0.0.1:4317" } };
    const first = claudeAshMcpInjection({ ...currentVars }, { entry });
    assert.equal(first.failure, null);
    const taskDir = join(RUNS_DIR, current.taskId, "ash-mcp");
    assert.equal(first.args[1]!.startsWith(taskDir), true, `任务回合写在任务自己的 runs 目录下:${first.args[1]}`);
    const body = JSON.parse(readFileSync(first.args[1]!, "utf8"));
    assert.equal(body.mcpServers.ash.env[ASH_TURN_FINGERPRINT_ENV], fp, "带着本回合指纹");
    assert.ok(!readFileSync(first.args[1]!, "utf8").includes(current.turnToken), "文件里只有指纹,没有令牌");
    const next = claudeAshMcpInjection({ ...currentVars, ASH_TURN_TOKEN: "turn-next" }, { entry });
    assert.notEqual(next.args[1], first.args[1], "下一回合另一份");
    assert.deepEqual(readdirSync(taskDir), [next.args[1]!.slice(taskDir.length + 1)], "写新的就删这个任务旧的那份");

    // 团队调度台的起跑环境只有任务 id(team/session.ts):是有身份的,不是「无身份」
    const team = { ASH_TASK_ID: "lead" };
    const leadFp = turnFingerprint({ taskId: "lead", turnToken: "", directionToken: "" });
    const teamFile = claudeAshMcpInjection(team, { entry }).args[1]!;
    assert.ok(teamFile.startsWith(join(RUNS_DIR, "lead", "ash-mcp")), "团队调度台也写在它自己的任务目录下");
    assert.equal(JSON.parse(readFileSync(teamFile, "utf8")).mcpServers.ash.env[ASH_TURN_FINGERPRINT_ENV], leadFp, "团队调度台带的是任务 id 的指纹");
    const teamCodex = codexAshMcpArgs(team, entry)[1]!;
    assert.ok(teamCodex.includes(`${ASH_TURN_FINGERPRINT_ENV}="${leadFp}"`) && teamCodex.includes('env_vars=["ASH_TASK_ID"]'),
      "codex 的团队调度台同样带任务 id 的指纹、透传任务 id");

    const side = claudeAshMcpInjection(withoutTurnIdentity({ ...currentVars }), { entry });
    assert.equal(side.args[1]!.startsWith(join(DATA_DIR, "ash-mcp")), true, "非任务回合放数据目录下共用");
    assert.equal(JSON.parse(readFileSync(side.args[1]!, "utf8")).mcpServers.ash.env[ASH_TURN_FINGERPRINT_ENV], "none", "写明无身份");
    assert.equal(claudeAshMcpInjection(undefined, { entry }).args[1], side.args[1], "没传环境也按无身份,内容相同复用同一份");

    const [, codex] = codexAshMcpArgs({ ...currentVars }, entry);
    assert.ok(codex!.includes(`${ASH_TURN_FINGERPRINT_ENV}="${fp}"`), "codex 的覆盖里带指纹");
    assert.ok(!codex!.includes(current.turnToken) && !codex!.includes(current.directionToken), "argv 里没有令牌值");
    assert.ok(codexAshMcpArgs(withoutTurnIdentity({ ...currentVars }), entry)[1]!.includes(`${ASH_TURN_FINGERPRINT_ENV}="none"`),
      "codex 非任务回合同样写明无身份");
    console.log("✓ 注入:claude 文件按回合写进任务目录并删旧、团队调度台带任务 id 的指纹、非任务回合写明无身份;codex 覆盖带指纹不带令牌");
  }

  // ── 3/4. 真 CLI ───────────────────────────────────────────────────────────
  const stub = join(root, "mcp-stub.mjs");
  const dump = join(root, "identity.json");
  const resolver = new URL("../../mcp/src/turn-identity.ts", import.meta.url).href;
  writeFileSync(stub, `import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const { resolveTurnIdentity } = await import(${JSON.stringify(resolver)});
const picked = resolveTurnIdentity(process.env);
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(picked));
if (picked.refused) process.exit(1);
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...body }) + "\\n");
  if (m.method === "initialize") reply({ result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ash", version: "1" } } });
  else if (m.method === "tools/list") reply({ result: { tools: ${JSON.stringify(ASH_MCP_TOOLS)}.map((name) => ({ name, description: name, inputSchema: { type: "object" } })) } });
  else reply({ error: { code: -32601, message: "nope" } });
});
`);
  // 桩要 import 一份 .ts:沿用跑本测试的这套加载器(tsx)。
  const entry = { command: process.execPath, args: [...process.execArgv, stub], env: { ASH_URL: "http://127.0.0.1:9" } };
  const picked = () => {
    const raw = existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) as { taskId: string; turnToken: string; refused: string | null } : null;
    rmSync(dump, { force: true });
    return raw;
  };
  // 本回合的起跑环境照真任务回合那样由 turnIdentityEnv 给(变量 + PATH 上的身份目录)。
  const { turnIdentityEnv } = await import("../src/turn-identity.js");
  const ctx = { root, entry, currentVars, currentEnv: turnIdentityEnv(current), stale, allStale, current, lead: "task-lead", picked };
  const { checkRealClaude, checkRealCodex } = await import("./turn-fingerprint-real-cli.js");
  await checkRealClaude(ctx);
  await checkRealCodex(ctx);
} finally {
  rmSync(root, { recursive: true, force: true });
}

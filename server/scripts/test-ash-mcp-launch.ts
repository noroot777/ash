// 「起跑之前先确认这一轮交得了卷」推广到派审以外的起跑路径（原任务 RsE8V4MFZ39x 第 1 轮
// 审查第 3 条）：ash-mcp-launch-gate.ts（拦）、ash-mcp-turn-hint.ts（只提示）、
// review-channel-gap.ts 的 noteTurnChannelGap（普通回合事后说明）。
//
// 为什么非钉不可：第 1 版那道闸只装在派审一条路上，预设工作流的验证轮、审查意见辩论、普通
// 回合缺了 ash MCP 照样跑满才发现交不上 —— 而且普通任务只留下一句没有原因的「失败」。
//
// 覆盖：
//   1. 闸本体：确定没有 → 抛、文案点名是谁；有 → 放行；登记看着起不来 → 放行 + 时间线提示；
//      项目主仓也在候选里（工作区还没建出来时 claude 的项目级登记照样看得见）
//   2. 验证轮：交不了卷当场拒绝，且**一行状态都没写**（verifyRound / stage / 时间线）
//   3. 辩论：两边一起核，两边都够不着时两句都说；拒绝时一行辩论记录都没有
//   4. 普通回合提示：只说一次、修好再坏会再说、宽松协议下不说、写不进去不算说过；先说过软的
//      「看着起不来」，后来确定没有时那句硬的照样要说（记账分档，第 1 轮审查第 2 条）
//   5. 普通回合事后说明：只认点名 ash 的确定证据（claude init 里没有 ash / 状态是终局失败；
//      codex 报错在点名 server 的那个位置写着 ash），pending/connecting、别的 server 的报错
//      （哪怕行里带着 harness 仓库路径或 ~/.ash 路径，第 1 轮审查第 1 条）、没产出的回合、
//      旁路回合（第 1 轮审查第 3 条）都不说
//   6. 接线：普通回合两个起跑点在会话行落库之后调提示；单飞收尾在「没交卷」那一支调事后说明，
//      且排除原生命令回合
//   7. 预设工作流走到下一站自动验证、验证者交不了卷：收尾就此收掉（不进每半分钟一遍的重试环），
//      原因只说一句，重放同一段推进也不再多说（新链第 1 轮审查第 1 条）
//
// 开头**强制关掉内核圈定**（`ASH_KERNEL_CONFINE=0`）：判据走配置文件那一档，一个 CLI 进程都
// 不起（假 CLI 被执行就留痕），哪个平台上跑的都是同一套。
//
// 跑：npm -w server run test:ash-mcp-launch
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-mcp-launch-"));
process.env.ASH_DB = join(stage, "t.db");
process.env.HARNESS_DB = process.env.ASH_DB;
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_KERNEL_CONFINE = "0";
delete process.env.ASH_LAX_DONE;

const codexHome = join(stage, "codex");
const claudeDir = join(stage, "claude");
mkdirSync(codexHome, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const writeCodex = (toml: string) => writeFileSync(join(codexHome, "config.toml"), toml);
const writeClaude = (json: unknown) => writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify(json));
const ASH_CODEX = '[mcp_servers.ash]\ncommand = "node"\n';

// 假 CLI：判据只要「这台机器上有这个命令」，配置文件那一档一个进程都不该起。
const binDir = join(stage, "bin");
mkdirSync(binDir, { recursive: true });
const ran = join(stage, "cli-ran");
for (const name of ["codex", "claude"]) {
  if (process.platform === "win32") {
    writeFileSync(join(binDir, `${name}.cmd`), `@echo off\r\necho ran> "${ran}"\r\nexit /b 0\r\n`);
  } else {
    writeFileSync(join(binDir, name), `#!/bin/sh\necho ran > "${ran}"\n`);
    chmodSync(join(binDir, name), 0o755);
  }
}
const pathWas = process.env.PATH;
process.env.PATH = `${binDir}${delimiter}${pathWas ?? ""}`;

try {
  const { ensureSchema, db } = await import("../src/db/index.js");
  await ensureSchema();
  const { freeReviewDebates, freeReviewRounds, freeReviewRuns, projects, sessions, tasks } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { createTasks } = await import("../src/task-store.js");
  const { sessionTranscriptPath, appendSessionTrace } = await import("../src/transcript.js");
  const { gateAshMcpBeforeLaunch } = await import("../src/ash-mcp-launch-gate.js");

  const repo = join(stage, "repo");
  mkdirSync(repo, { recursive: true });
  // 得是 git 仓库：非 git 项目的任务一律不开 worktree，「工作区还没建出来」那条就造不出来。
  execFileSync("git", ["init", "-q", repo]);
  const at = "2026-10-30T00:00:00.000Z";
  await db.insert(projects).values({ id: "p", name: "p", repoPath: repo, createdAt: at, updatedAt: at });
  const makeTask = async (id: string, agentType: "codex" | "claude", extra: Record<string, unknown> = {}) => {
    await createTasks([{
      id, projectId: "p", title: id, body: "test", mode: "single", status: "done",
      agentType, executorId: null, autoTitle: false, workflowMode: "free",
      useWorktree: false, createdAt: at, updatedAt: at, ...extra,
    }]);
    return (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  };
  /** 时间线写在会话正文里，没有会话行就无处可写 —— 测试给每个任务配一条。 */
  const makeSession = async (taskId: string, agentType: string, sessId = `${taskId}-s`) => {
    await db.insert(sessions).values({
      id: sessId, taskId, role: "single", agentType, executor: agentType, cwd: repo,
      startedAt: at, turnStartedAt: at, activeMs: 0,
    } as typeof sessions.$inferInsert);
    return sessId;
  };
  const timeline = (taskId: string, sessId = `${taskId}-s`): string => {
    const path = sessionTranscriptPath(taskId, sessId);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  // ── 1. 闸本体 ────────────────────────────────────────────────────────────
  {
    const task = await makeTask("g1", "codex");
    await makeSession("g1", "codex");
    writeCodex('model = "x"\n');
    await assert.rejects(
      () => gateAshMcpBeforeLaunch(task, { agentType: "codex", executorId: null }, "某位验证者"),
      /^Error: 某位验证者交不了卷：.*读配置文件得出/s,
      "确定没有就拦，文案点名是谁、写明证据来源",
    );
    writeCodex(ASH_CODEX);
    await gateAshMcpBeforeLaunch(task, { agentType: "codex", executorId: null }, "某位验证者");
    await gateAshMcpBeforeLaunch(task, { agentType: "grok", executorId: null }, "别的执行器");

    writeCodex('[mcp_servers.ash]\ncommand = "definitely-not-a-real-bin-ash"\n');
    await gateAshMcpBeforeLaunch(task, { agentType: "codex", executorId: null }, "审查者");
    assert.match(timeline("g1"), /起跑预检提示（审查者）：.*找不到/, "登记看着起不来：放行，但留一句提示");
    writeCodex(ASH_CODEX);

    // 一条会话都没有、工作区也没建：claude 的项目级登记挂在项目主仓上，照样要看得见。
    const fresh = await makeTask("g2", "claude", { useWorktree: true });   // worktree 还没建出来
    assert.equal(fresh.useWorktree, true, "前提：这条任务要开 worktree");
    writeClaude({ projects: { [repo]: { mcpServers: { ash: { command: "node" } } } } });
    await gateAshMcpBeforeLaunch(fresh, { agentType: "claude", executorId: null }, "执行者");
    writeClaude({});
    await assert.rejects(() => gateAshMcpBeforeLaunch(fresh, { agentType: "claude", executorId: null }, "执行者"),
      /执行者交不了卷/, "项目主仓也没有才拦");
    writeClaude({ mcpServers: { ash: { command: "node" } } });
  }

  // ── 2. 验证轮：拦在任何状态提交之前 ─────────────────────────────────────────
  {
    const { startVerifyRound } = await import("../src/review.js");
    await makeTask("v1", "codex", { workflowMode: "preset" });
    await makeSession("v1", "codex");
    writeCodex('model = "x"\n');
    await assert.rejects(() => startVerifyRound("v1"), /第 1 轮验证的验证者交不了卷/, "验证者够不着 ash MCP 就当场拒绝");
    const row = (await db.select().from(tasks).where(eq(tasks.id, "v1")))[0]!;
    assert.equal(row.verifyRound, null, "拒绝时 verifyRound 不能留下（否则任务永久卡在「正在验证」）");
    assert.equal(row.stage, null, "拒绝时 stage 不能被写成 verifying");
    assert.doesNotMatch(timeline("v1"), /验证开始/, "拒绝时不能写「验证开始」");
    writeCodex(ASH_CODEX);
  }

  // ── 3. 辩论：两边一起核 ────────────────────────────────────────────────────
  {
    const { startFreeReviewDebate } = await import("../src/free-review-debate.js");
    await makeTask("d1", "claude");
    await makeSession("d1", "claude");
    await db.insert(freeReviewRuns).values({
      id: "d1-run", taskId: "d1", reviewerId: "reviewer", reviewerName: "审查者甲", agentType: "codex",
      executorId: null, checkMode: "logic", retryLimit: 1, currentRound: 1,
      status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
    });
    await db.insert(freeReviewRounds).values({
      id: "d1-round", runId: "d1-run", round: 1, status: "failed", conclusion: "verify_failed",
      reportMarkdown: "第 3 行的 null 检查缺失", startedAt: at, endedAt: at,
      disputeReason: "第 1 条不成立", disputeAt: at,
    });
    writeCodex('model = "x"\n');
    writeClaude({});
    await assert.rejects(() => startFreeReviewDebate("d1", { exchanges: 1 }), (error: Error) => {
      assert.match(error.message, /审查者交不了卷/, "审查者那边（codex）够不着要说");
      assert.match(error.message, /执行者交不了卷/, "执行者那边（claude）也够不着，两句都说");
      return true;
    });
    assert.equal((await db.select().from(freeReviewDebates).where(eq(freeReviewDebates.taskId, "d1"))).length, 0,
      "拒绝时一行辩论记录都不能有（否则「已经有一轮辩论正在进行」会把重开挡死）");
    writeCodex(ASH_CODEX);
    await assert.rejects(() => startFreeReviewDebate("d1", { exchanges: 1 }), (error: Error) => {
      assert.doesNotMatch(error.message, /审查者交不了卷/, "修好的那一边不再提");
      assert.match(error.message, /执行者交不了卷/);
      return true;
    });
    writeClaude({ mcpServers: { ash: { command: "node" } } });
  }

  // ── 4. 普通回合提示 ───────────────────────────────────────────────────────
  {
    const { hintAshMcpForTurn, resetAshMcpTurnHints } = await import("../src/ash-mcp-turn-hint.js");
    resetAshMcpTurnHints();
    await makeTask("h1", "codex");
    const sessionId = await makeSession("h1", "codex");
    const q = (cwd: string) => ({ taskId: "h1", agentType: "codex", executorId: null, ownerUserId: null, cwd, sessionId });
    const NEEDLE = "起跑预检提示：这一轮的 agent 可能用不了 ash MCP";
    const dirs = ["a", "b", "c", "d"].map((n) => { const d = join(stage, `cwd-${n}`); mkdirSync(d); return d; });

    writeCodex('model = "x"\n');
    await hintAshMcpForTurn(q(dirs[0]!));
    assert.equal(count(timeline("h1"), NEEDLE), 1, "确定没有：说一句");
    assert.match(timeline("h1"), /只是提示，不阻止本轮继续/, "明说没拦");
    assert.match(timeline("h1"), /若本轮需要确认完成.*不需要交卷的纯追问不因此记未完成/, "起跑只说明通道能力，不预判纯追问失败");
    assert.doesNotMatch(timeline("h1"), /干得再好也只能按|跑完必然/, "不能把缺登记说成本轮必然失败");
    await hintAshMcpForTurn(q(dirs[0]!));
    await hintAshMcpForTurn(q(dirs[1]!));
    assert.equal(count(timeline("h1"), NEEDLE), 1, "同一条任务同一个执行器只说一次，不刷屏");

    writeCodex(ASH_CODEX);
    await hintAshMcpForTurn(q(dirs[2]!));                // 新上下文，不吃缓存：查出来通了
    writeCodex('model = "x"\n');
    await hintAshMcpForTurn(q(dirs[3]!));
    assert.equal(count(timeline("h1"), NEEDLE), 2, "修好之后再坏，还得说出来");

    process.env.ASH_LAX_DONE = "1";
    resetAshMcpTurnHints();
    await hintAshMcpForTurn(q(dirs[0]!));
    assert.equal(count(timeline("h1"), NEEDLE), 2, "宽松完成协议本来就不靠交卷，不说");
    delete process.env.ASH_LAX_DONE;

    // 会话行还没落库（写不进去）：不算说过，下一次还说。
    resetAshMcpTurnHints();
    await makeTask("h2", "codex");
    const early = { taskId: "h2", agentType: "codex", executorId: null, ownerUserId: null, cwd: dirs[0]!, sessionId: "h2-s" };
    await hintAshMcpForTurn(early);
    await makeSession("h2", "codex");
    await hintAshMcpForTurn(early);
    assert.equal(count(timeline("h2"), NEEDLE), 1, "第一次没写进去，第二次要补上");

    // 先软后硬：软的那句占了名额，不能把后来那句硬的吞掉。
    resetAshMcpTurnHints();
    await makeTask("h3", "codex");
    const h3 = await makeSession("h3", "codex");
    const q3 = (cwd: string) => ({ taskId: "h3", agentType: "codex", executorId: null, ownerUserId: null, cwd, sessionId: h3 });
    const SOFT = /起跑预检提示：[^\n]*找不到/;
    writeCodex('[mcp_servers.ash]\ncommand = "definitely-not-a-real-bin-ash"\n');
    await hintAshMcpForTurn(q3(dirs[0]!));
    assert.match(timeline("h3"), SOFT, "登记看着起不来：先说一句软的");
    assert.equal(count(timeline("h3"), NEEDLE), 0);
    writeCodex('model = "x"\n');
    await hintAshMcpForTurn(q3(dirs[1]!));
    assert.equal(count(timeline("h3"), NEEDLE), 1, "后来确定没有了：那句硬的照说，不被软的那句占掉名额");
    await hintAshMcpForTurn(q3(dirs[2]!));
    assert.equal(count(timeline("h3"), NEEDLE), 1, "同一档不重复");
    writeCodex(ASH_CODEX);
  }

  // ── 5. 普通回合事后说明 ────────────────────────────────────────────────────
  {
    const { claudeMcpEvidence, codexMcpEvidence, noteTurnChannelGap } = await import("../src/review-channel-gap.js");
    const { detachedPathsFor } = await import("../src/executors/detached.js");
    const { RUNS_DIR } = await import("../src/paths.js");
    let n = 0;
    /** 造一轮：干没干过活、claude 的 stdout / codex 的 stderr 里写了什么。 */
    const turn = async (agentType: "claude" | "codex", o: { work?: boolean; out?: string; err?: string; side?: boolean }) => {
      const taskId = `n${++n}`;
      await makeTask(taskId, agentType);
      const sessId = await makeSession(taskId, agentType);
      if (o.side) await db.update(sessions).set({ sideTurn: true }).where(eq(sessions.id, sessId));
      const turnStart = `2026-10-30T00:0${n % 10}:00.000Z`;
      if (o.work !== false) appendSessionTrace(taskId, sessId, turnStart, { kind: "text", text: "改好了", at: turnStart } as never);
      const paths = detachedPathsFor(join(RUNS_DIR, taskId), sessId, turnStart);
      mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
      writeFileSync(paths.out, o.out ?? "");
      writeFileSync(paths.err, o.err ?? "");
      const said = await noteTurnChannelGap({ taskId, sessId, turnStart, agentType });
      return { said, text: timeline(taskId, sessId) };
    };
    const init = (servers: string) =>
      `{"type":"system","subtype":"init","mcp_servers":${servers}}\n{"type":"assistant"}\n`;
    const statuses = ["failed", "needs-auth", "disabled", "pending", "connecting", "connected", "future-status", "", null, undefined, 7];
    const terminalFailures = new Set(["failed", "needs-auth", "disabled"]);
    for (const primary of statuses) for (const legacy of statuses) {
      const rows = [{ name: "ash", status: primary }, { name: "harness", status: legacy }];
      const evidence = claudeMcpEvidence(init(JSON.stringify(rows)));
      const connected = [primary, legacy].includes("connected");
      const definite = !connected && [primary, legacy].every((status) => typeof status === "string" && terminalFailures.has(status));
      assert.equal(evidence?.connected, connected, `任一兼容登记连通即成功：${JSON.stringify(rows)}`);
      assert.equal(evidence?.definite, definite, `只有全部明确终局失败才确定不可用：${JSON.stringify(rows)}`);
      assert.deepEqual(claudeMcpEvidence(init(JSON.stringify([...rows].reverse()))), evidence,
        "相同兼容登记的证据与顺序无关");
    }
    for (const status of ["pending", "connecting", "connected", "", null]) {
      const rows = [{ name: "ash", status: "failed" }, { name: "harness", status }];
      for (const ordered of [rows, [...rows].reverse()]) {
        assert.equal((await turn("claude", { out: init(JSON.stringify(ordered)) })).said, false,
          "失败和未知/成功混合时不写确定归因，交换顺序也一样");
      }
    }
    assert.equal((await turn("claude", { out: init('[{"name":"ash","status":"failed"},{"name":"harness","status":"disabled"}]') })).said, true,
      "兼容登记全部终局失败：保留确定归因");

    const missing = await turn("claude", { out: init('[{"name":"kb","status":"connected"}]') });
    assert.equal(missing.said, true, "init 清单里没有 ash：确定证据，要说");
    assert.match(missing.text, /没交卷多半不是 agent 漏了/);
    assert.match(missing.text, /里面没有 ash/, "证据原样带上");
    assert.match(missing.text, /claude mcp get ash/, "带上自查办法");

    assert.equal((await turn("claude", { out: init('[{"name":"ash","status":"failed"}]') })).said, true,
      "ash 状态 failed：确定证据");
    assert.equal((await turn("claude", { out: init('[{"name":"ash","status":"needs-auth"}]') })).said, true,
      "ash 状态 needs-auth：终局失败，确定证据");
    assert.equal((await turn("claude", { out: init('[{"name":"ash","status":"pending"}]') })).said, false,
      "pending 还在连，工具可能稍后就到 —— 不算证据");
    assert.equal((await turn("claude", { out: init('[{"name":"ash","status":"connecting"}]') })).said, false,
      "没列举的状态（connecting 之类）未知即不确定 —— 白名单，不是黑名单");
    assert.equal((await turn("claude", { side: true, out: init('[{"name":"kb","status":"connected"}]') })).said, false,
      "旁路回合（验证轮、辩论执行者段、计划模式）不靠 complete_task 交卷，这句话不是说给它的");
    assert.equal((await turn("claude", { out: init('[{"name":"ash","status":"connected"}]') })).said, false,
      "连上了：普通回合没交卷的头号原因是漏调，不许说成通道坏了");
    assert.equal((await turn("claude", { out: "" })).said, false, "没有 init 事件：没有证据就不说");
    assert.equal((await turn("claude", { work: false, out: init("[]") })).said, false,
      "没产出过正文的回合另有诊断，不说");

    assert.equal((await turn("codex", { err: "ERROR rmcp: MCP server linear failed: OAuth required\n" })).said, false,
      "别的 server 的报错不算 ash 的证据");
    assert.equal((await turn("codex", {
      err: "ERROR rmcp: MCP server `linear` failed to start: OAuth required (cwd=/Users/fjh/code/harness)\n",
    })).said, false, "别家报错的行里带着仓库路径（本仓就叫 harness）：不是 ash 的证据");
    assert.equal((await turn("codex", {
      err: "ERROR rmcp: MCP server `linear` failed to start: cannot read /Users/fjh/.ash/linear.json\n",
    })).said, false, "别家报错的行里带着 ~/.ash 路径：不是 ash 的证据");
    assert.equal((await turn("codex", {
      err: "ERROR rmcp: MCP server `linear` failed to start: tool name 'ash' collides\n",
    })).said, false, "别家报错里顺带引到 'ash'：点名的位置写的是 linear，不算");
    const named = await turn("codex", { err: "\u001b[31mERROR\u001b[0m MCP client for `ash` failed to start: No such file\n" });
    assert.equal(named.said, true, "stderr 点名 ash 的 MCP 报错：确定证据");
    assert.doesNotMatch(named.text, /\u001b\[/, "ANSI 着色要去掉");
    assert.equal((await turn("codex", { err: "ERROR MCP server 'harness' failed to initialize: authentication required\n" })).said, true,
      "旧名的明确初始化失败也能作为确定证据");
    for (const diagnostic of [
      "WARN MCP server `ash` returned error: unknown tool `not_a_tool`",
      "ERROR MCP client for `ash` tool call failed: request timed out",
      'WARN MCP server "harness" returned error: tool execution failed',
    ]) {
      assert.equal(codexMcpEvidence(diagnostic)?.definite, false, "点名不等于启动失败");
      assert.equal((await turn("codex", { err: `${diagnostic}\n` })).said, false, "调用级报错不归因为整组工具不在");
    }
    const startupFailure = "ERROR MCP client for `ash` failed to start: missing binary";
    const unknownFailure = "WARN MCP server `harness` returned error: unknown tool `not_a_tool`";
    for (const diagnostics of [[startupFailure, unknownFailure], [unknownFailure, startupFailure]]) {
      assert.equal((await turn("codex", { err: diagnostics.join("\n") })).said, false,
        "终局失败与非终局告警混合时不能确定全部不可用，交换顺序不改变结果");
    }
  }

  // ── 6. 接线 ───────────────────────────────────────────────────────────────
  {
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    for (const [file, insert] of [
      ["task-run.ts", "await db.insert(sessions).values(sessRow);"],
      ["orchestrator.ts", "else await persistRunner(db);"],
    ] as const) {
      const text = src(file);
      const hint = text.indexOf("void hintAshMcpForTurn(");
      assert.ok(hint > 0, `${file} 的普通回合必须调起跑提示`);
      assert.ok(text.indexOf(insert) > 0 && text.indexOf(insert) < hint,
        `${file}：提示必须排在会话行落库之后（之前调会无处可写）`);
    }
    assert.match(src("orchestrator.ts"), /if \(!sideTurn\) void hintAshMcpForTurn\(/,
      "旁路回合（验证轮、审查、辩论）在起跑处已过闸，不再重复提示");
    const run = src("single-run.ts");
    assert.ok(run.indexOf("noteSessionNotice(settled.note") < run.indexOf("await noteTurnChannelGap("),
      "原因接在结算说明后面（先结果、后原因）");
    assert.match(src("free-review-round.ts"), /await gateAshMcpBeforeLaunch\(task, \{ agentType: run\.agentType/,
      "派审走同一道闸，不另留一份");
  }

  // ── 7. 验证收尾：交不了卷是停在这一站，不是待重试 ─────────────────────────────
  {
    const { drainRegressionFinalization, finalization } = await import("../src/regression-finalization.js");
    const { advanceWorkflowFrom } = await import("../src/workflow-advance.js");
    const { taskWorkflowDef } = await import("../src/workflows.js");
    const { regressionEvidence } = await import("../src/db/schema.js");
    // 干活 → 验证 → 再验证 → 人工：第一站刚验过，推进器要去第二站开一轮。
    const line = JSON.stringify({ workspace: "shared", steps: [
      { id: "s0", kind: "run", p: { instruction: null, executorId: null, model: null, reasoningEffort: null }, fail: null },
      { id: "s1", kind: "verify", p: { executorId: null, model: null, reasoningEffort: null, checks: [] }, fail: { mode: "stop", max: 2 } },
      { id: "s2", kind: "verify", p: { executorId: null, model: null, reasoningEffort: null, checks: [] }, fail: { mode: "stop", max: 2 } },
      { id: "s3", kind: "human", p: { show: [], notify: [] }, fail: null },
    ] });
    const target = await makeTask("w1", "codex", { workflowMode: "preset", workflow: line, workflowAt: "s1", endedAt: at });
    await makeSession("w1", "codex");
    const payload = { target, round: 1, reviewTaskId: null, station: "s1", stationRound: 1,
      outcome: "done", conclusion: "verified", frozen: false, stageChanged: false };
    await db.insert(regressionEvidence).values({
      directory: "w1-dir", taskId: "w1", generation: "w1-g", excludedMonitors: [],
      settlement: { outcome: "done", conclusion: "verified", ownerTaskId: "w1", round: 1, pending: false,
        target: { turnToken: null, directionToken: null, directionEpoch: target.directionEpoch } },
      finalization: finalization("preset", payload),
    });
    const SAID = "但没开起来";
    writeCodex('model = "x"\n');
    const thrown = await drainRegressionFinalization("w1-dir").then(() => null, (error: unknown) => error);
    assert.equal(thrown, null, "交不了卷不是待重试的失败：收尾不该往外抛（外层每半分钟重试的就是抛出来的那种）");
    const state = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, "w1-dir")))[0]!;
    assert.equal(state.finalization?.completed, true, "收尾落 completed，不再被定时器捡起来");
    assert.equal(count(timeline("w1"), SAID), 1, "原因说一句");
    assert.match(timeline("w1"), /交不了卷.*线停在这一站.*再验一轮/s, "说清线停在哪、接好之后怎么接着走");
    const row = (await db.select().from(tasks).where(eq(tasks.id, "w1")))[0]!;
    assert.equal(row.workflowAt, "s2", "游标停在开不起来的那一站，「再验一轮」据此知道该验哪一站");
    assert.equal(row.verifyRound, null, "这一轮一个字都没开起来");

    // 别的拒绝照旧会让收尾重放整段推进：同一次尝试、同一个原因只说一句。
    for (let i = 0; i < 3; i++) await advanceWorkflowFrom(row, taskWorkflowDef(line), "s1");
    assert.equal(count(timeline("w1"), SAID), 1, "重放同一段推进不再多说");
    writeCodex(ASH_CODEX);
  }

  {
    const { settleTaskStatus } = await import("../src/settle-status.js");
    const scenarios = [
      { id: "normal", extra: {}, exit: 0, stopped: null, status: "failed", missing: true },
      { id: "followup", extra: { followUpFrom: "failed" }, exit: 0, stopped: null, status: "failed", missing: false },
      { id: "followup-question", extra: { followUpFrom: "failed", question: "为什么？" }, exit: 0, stopped: null, status: "failed", missing: false },
      { id: "followup-crash", extra: { followUpFrom: "failed" }, exit: 1, stopped: null, status: "failed", missing: false },
      { id: "confirmed", extra: { completeConfirmedAt: at }, exit: 0, stopped: null, status: "done", missing: false },
      { id: "native", extra: { nativeTurn: true }, exit: 0, stopped: null, status: "done", missing: false },
      { id: "crash", extra: {}, exit: 1, stopped: null, status: "failed", missing: false },
      { id: "stop", extra: {}, exit: 0, stopped: "canceled", status: "canceled", missing: false },
      { id: "pause", extra: { resumePrompt: "继续" }, exit: 0, stopped: null, status: "paused", missing: false },
    ] as const;
    for (const scenario of scenarios) {
      const taskId = `settle-${scenario.id}`;
      await makeTask(taskId, "codex", { status: "running", ...scenario.extra });
      const settled = await settleTaskStatus(taskId, scenario.exit, scenario.stopped);
      assert.equal(settled.status, scenario.status, scenario.id);
      assert.equal(settled.failureReason, scenario.missing ? "missing_completion_confirmation" : undefined, scenario.id);
    }

    const { consumeSingleRun } = await import("../src/single-run.js");
    const { detachedPathsFor } = await import("../src/executors/detached.js");
    const { RUNS_DIR } = await import("../src/paths.js");
    for (const scenario of scenarios.filter((entry) => entry.stopped === null)) {
      const taskId = `flow-${scenario.id}`;
      await makeTask(taskId, "codex", { status: "running", ...scenario.extra });
      const sessId = await makeSession(taskId, "codex");
      const paths = detachedPathsFor(join(RUNS_DIR, taskId), sessId, at);
      mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
      writeFileSync(paths.err, "ERROR MCP client for `ash` failed to start: missing binary\n");
      const out = createWriteStream(sessionTranscriptPath(taskId, sessId), { flags: "a" });
      const closed = new Promise<void>((resolve, reject) => { out.once("close", resolve); out.once("error", reject); });
      await consumeSingleRun({
        taskId, sessId, agentType: "codex", cwd: repo, turnStart: at, cliSessionId: sessId, autoTitle: false, out,
        ex: { model: null, reasoningEffort: null, resumeFields: () => ({}) } as never,
        handle: {
          sessionId: sessId, commandLine: "fake", kill() {}, async cleanup() {},
          events: (async function* () {
            yield { kind: "text" as const, text: "仅解释上次失败的原因，本轮没有修改文件。" };
            yield { kind: "done" as const, exitStatus: scenario.exit };
          })(),
        },
      });
      await closed;
      const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
      assert.equal(row.status, scenario.status, `真实收流与结算：${scenario.id}`);
      assert.equal(timeline(taskId).includes("没交卷多半不是 agent 漏了"), scenario.missing,
        `只对本轮确实因缺确认失败的执行回合追加通道归因：${scenario.id}`);
      if (scenario.id.startsWith("followup")) {
        assert.doesNotMatch(timeline(taskId), /本回合没有交卷|修好之后点重试|只补交卷/, "恢复旧 failed 不是本轮漏交卷");
      }
    }
  }

  assert.ok(!existsSync(ran), "配置文件那一档一个 CLI 进程都不该起");
  console.log("✅ 起跑前 ash MCP 检查推广到验证轮 / 辩论 / 普通回合（拦、提示、事后说明、接线）通过");
} finally {
  process.env.PATH = pathWas;
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

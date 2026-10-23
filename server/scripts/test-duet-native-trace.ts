import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import type { AgentExecutor } from "../src/executors/types.js";
import { applyDuetEvent, emptyDuet, rebuildDuetState, type PersistedDuetEntry } from "../../web/src/duet/duetState.ts";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-duet-native-trace-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-duet-native-trace");

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { runTurn } = await import("../src/duet/turn.js");
const { parseClaudeStream } = await import("../src/executors/claude.js");
// 这两个也必须走动态 import:静态 import 会在上面那几行设 ASH_RUNS_DIR **之前**求值,
// 而 transcript.js 在模块初始化时就定下 RUNS_DIR —— 于是夹具的产物会落进真实的 data/runs。
const { failedTurnNotices } = await import("../src/session-waiting.js");
const { parseSessionTrace } = await import("../src/transcript.js");
const { turnOutcome } = await import("../src/session-turns.js");
const { bus } = await import("../src/bus.js");
const at = new Date().toISOString();

const tool = (id: string, name: string, input: unknown, parent?: string) => ({
  type: "assistant", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const lines = [
  tool("before", "Bash", { command: "git status --short" }),
  tool("child", "Agent", { description: "查资料", prompt: "核对方案" }),
  ...Array.from({ length: 2000 }, () => ({ type: "stream_event", parent_tool_use_id: "child",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "word" } } })),
  { type: "assistant", parent_tool_use_id: "child", message: { content: [
    { type: "text", text: "word".repeat(2000) }, { type: "thinking", thinking: "子智能体分析" },
  ] } },
  tool("nested", "Agent", { description: "嵌套派活" }, "child"),
  tool("child-read", "Read", { file_path: "child-only.ts" }, "child"),
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "child", content: "查证完成" }] } },
  tool("after-edit", "Edit", { file_path: "plan.md", old_string: "旧方案", new_string: "新方案" }),
  tool("after-read", "Read", { file_path: "plan.md" }),
  tool("after-bash", "Bash", { command: "npm test" }),
  // 上游重试:CLI 唯一一次说出「不是我卡住了,是上游不给响应」(claude-stream 的 api_retry)。
  // 这一轮随后正常答完 —— 它正是用户那句「本条命令执行成功了就没必要显示在会话结尾处」。
  { type: "system", session_id: "fixture-thread", subtype: "api_retry",
    attempt: 1, max_retries: 10, error_status: 502, retry_delay_ms: 600 },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "讨论者自己的结论" } } },
  { type: "assistant", message: { content: [{ type: "text", text: "讨论者自己的结论" }] } },
];

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "p", name: "fixture", repoPath: stage, createdAt: at });
  for (const speaker of ["A", "B"] as const) {
    const taskId = `duet-native-${speaker}`;
    const role = speaker === "A" ? "voiceA" : "voiceB";
    await db.insert(tasks).values({ id: taskId, projectId: "p", title: taskId, body: "fixture", mode: "duet",
      status: "running", autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at });
    let live = emptyDuet();
    const published: AgentEvent[] = [];
    const unsubscribe = bus.subscribe((event) => {
      if (!("taskId" in event) || event.taskId !== taskId) return;
      live = applyDuetEvent(live, event);
      if (event.type === "agent.event") published.push(event.event);
    });
    const executor: AgentExecutor = {
      type: "claude", label: "fixture",
      run: () => {
        const child = spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdin.end(lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
        return { sessionId: "", commandLine: "fixture", events: parseClaudeStream(child), kill: () => { child.kill(); } };
      },
      resumeCommand: () => "fixture",
      resumeFields: () => ({ resumeCommand: "fixture", resumeEnv: null, resumeArgs: null }),
    };
    try {
      await runTurn({ taskId, role, speaker, round: 1, executor, runOwner: null, prompt: "fixture", cwd: stage });
    } finally {
      unsubscribe();
    }
    const entries = readFileSync(join(stage, "runs", taskId, "transcript.jsonl"), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as PersistedDuetEntry);
    const reloaded = rebuildDuetState(entries);
    const childEvents = published.filter((event) => event.kind === "tool" && event.nativeWork?.type === "activity");
    assert.ok(childEvents.length > 200, "the fixture exceeds duet's trace cap using real parsed child activity");
    for (const [source, state] of [["persisted", reloaded], ["live", live]] as const) {
      assert.equal(state.turns.length, 1);
      const turn = state.turns[0]!;
      assert.equal(turn.speaker, speaker);
      assert.equal(turn.text.trim(), "讨论者自己的结论");
      assert.equal(turn.done, true);
      assert.deepEqual(turn.events.filter((event) => event.kind === "tool").map((event) => event.label),
        ["Bash", "Agent", "Edit", "Read", "Bash"], `${source}: child events cannot displace the speaker's tools`);
      assert.equal(turn.events.length, 6, `${source}: only the speaker's tools (plus the upstream-retry notice) enter the trace`);
      // ── 过程提示只进结构化过程,不进正文(第 5 轮审查 F1) ───────────────────────────
      // 从前这一支两边都写:`trace.push` 之外还往 `out`(就是手机读的那份 `.md`)写一行
      // 「ⓘ 上游返回 502…」。于是一场重试过、后来正常答完的讨论,那句提示作为**正文**
      // 永久留在回答里 —— 刷新、重启、换台都在,正是用户要删掉的东西。单飞与团队早就只
      // 走 trace,讨论是最后一处。
      const notices = turn.events.filter((event) => event.kind === "notice");
      assert.equal(notices.length, 1, `${source}: 上游重试没进执行过程`);
      assert.ok(notices[0]!.detail?.includes("正在重试"), `${source}: 提示的正文该在 detail 那一格`);
      assert.ok(turn.events.every((event) => event.detail), `${source}: no empty Agent rows`);
      assert.ok(!JSON.stringify(turn.events).includes("child-only.ts"));
    }
    assert.deepEqual(JSON.parse(JSON.stringify(live.turns[0]!.events)), reloaded.turns[0]!.events,
      "the live event stream and persisted transcript produce the same execution process");
    // 手机读的是 `.md`:那份里一个字都不许有(上面那段注释讲的就是这条链的另一头)。
    const mdFiles = readdirSync(join(stage, "runs", taskId)).filter((name) => name.endsWith(".md"));
    assert.equal(mdFiles.length, 1, "这一轮该只有一份会话正文");
    const md = readFileSync(join(stage, "runs", taskId, mdFiles[0]!), "utf8");
    assert.ok(md.includes("讨论者自己的结论"), "正文压根没落盘,下面那条断言就成了空断言");
    assert.ok(!md.includes("正在重试"), "讨论的过程提示又写进了正文 —— 手机上它会永久留在回答里(F1)");
    // 但它必须进**会话** trace:讨论自己那份 transcript 只有讨论界面读,而手机那个窄出口的
    // 「失败现场」从会话 trace 回放 —— 不落这一笔,一场**真失败**的讨论在手机上一条线索都
    // 没有(F1 要的「为当前等待和明确失败提供一致投影」)。
    const sessId = mdFiles[0]!.replace(/\.md$/, "");
    const tracePath = join(stage, "runs", taskId, `${sessId}.trace.jsonl`);
    assert.ok(existsSync(tracePath), "讨论压根没落会话 trace —— 手机那个窄出口在讨论上永远是空的(F1)");
    const traceEntries = parseSessionTrace(readFileSync(tracePath, "utf8"));
    const turnStartedAt = traceEntries.at(0)?.turnStartedAt ?? null;
    assert.ok(turnStartedAt, "会话 trace 一条都没落,窄出口在讨论上永远是空的(F1)");
    assert.deepEqual(
      failedTurnNotices(traceEntries, { turnStartedAt, outcome: "failed" }).map((item) => item.text.includes("正在重试")),
      [true],
      "真收在失败上的那一轮,窄出口照样给不出它卡在哪儿(F1)",
    );
    // 而这一轮其实成功了:同一份 trace,按它自己的结局投影出来就该是空的(这正是用户的诉求)。
    assert.deepEqual(
      failedTurnNotices(traceEntries, { turnStartedAt, outcome: "completed" }),
      [],
      "一场重试过、随后正常答完的讨论,提示又被当成失败现场挂了出来",
    );
    // 这一轮自己的结局也得落上(duet 的收尾写入口):没有它,上面那个 completed 投影在生产里
    // 永远拿不到答案 —— 窄出口会退回「不知道」,一轮真失败的讨论照样一条都不回放(F3)。
    assert.equal(
      await turnOutcome(sessId, turnStartedAt),
      "completed",
      "讨论这一轮收尾时没落下自己的结局",
    );
    console.log(`duet ${speaker}: ${childEvents.length} child activities, 5 tool rows + 1 notice; all later tools survive live and reload`);
  }
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

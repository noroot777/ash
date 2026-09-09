import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      assert.equal(turn.events.length, 5, `${source}: only the speaker's tools enter the trace`);
      assert.ok(turn.events.every((event) => event.detail), `${source}: no empty Agent rows`);
      assert.ok(!JSON.stringify(turn.events).includes("child-only.ts"));
    }
    assert.deepEqual(JSON.parse(JSON.stringify(live.turns[0]!.events)), reloaded.turns[0]!.events,
      "the live event stream and persisted transcript produce the same execution process");
    console.log(`duet ${speaker}: ${childEvents.length} child activities, 5 visible trace rows; all later tools survive live and reload`);
  }
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

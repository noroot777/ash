import assert from "node:assert/strict";
import type { Task, Session } from "@ash/shared";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { canForkReply, forkTaskBody, snapshotConversationFork } from "../src/task-detail/conversationFork.ts";

const task = { id: "source", title: "来源任务", body: "原始需求", mode: "single" } as Task;
const session = {
  id: "s1", taskId: task.id, role: "single", agentType: "codex",
  startedAt: "2026-09-10T01:00:00Z", endedAt: "2026-09-10T01:05:00Z",
  cliSessionId: "DO_NOT_RESUME", transcriptPath: "/later/full-transcript.md",
} as Session;
const marker = (t: string, text: string, at: string) => `\x1e${JSON.stringify({ t, text, at })}\n`;
const output = "第一条答复\n" + marker("agentEnd", "", "2026-09-10T01:01:00Z")
  + marker("user", "此前的追问", "2026-09-10T01:02:00Z")
  + "选中的答复\n" + marker("agentEnd", "", "2026-09-10T01:03:00Z")
  + marker("user", "不应带入的后续追问", "2026-09-10T01:04:00Z")
  + "不应带入的后续答复\n";
const items = buildConversationItems([{ session, output }], [session], []);
const replies = items.filter((item) => item.kind === "agent");
const target = replies[1]!;
target.segments[0]!.attachments.push("/tmp/earlier.png");
target.segments[0]!.events.push({ kind: "tool", label: "Read", detail: "earlier-file.ts" });
replies[2]!.segments[0]!.attachments.push("/tmp/later.png");
const seed = snapshotConversationFork(task, items, target.id);
assert.equal(seed.fork.messageCount, 3);
assert.deepEqual(seed.fork.attachmentPaths, ["/tmp/earlier.png"]);
const body = forkTaskBody(seed.fork, "接下来研究方案 B");
for (const expected of ["原始需求", "第一条答复", "此前的追问", "选中的答复", "earlier-file.ts", "接下来研究方案 B"]) {
  assert.ok(body.includes(expected), expected);
}
for (const excluded of ["不应带入", "later.png", "DO_NOT_RESUME", "full-transcript.md"]) assert.ok(!body.includes(excluded), excluded);
target.markdown += "此后新增";
task.body += "此后修改正文";
assert.ok(!seed.fork.context.includes("此后"));
const first = snapshotConversationFork(task, items, replies[0]!.id);
assert.ok(!first.fork.context.includes("此前的追问"));
assert.throws(() => snapshotConversationFork(task, items, "missing"));
assert.throws(() => snapshotConversationFork(task, [{ ...target, session: { ...session, taskId: "other-task" } }], target.id));
assert.equal(canForkReply({ ...target, endedAt: null }), false);
assert.equal(canForkReply({ ...target, markdown: "" }), false);
assert.throws(() => snapshotConversationFork(task, [{ ...target, endedAt: null }], target.id));
const longReply = { ...target, markdown: "长文本".repeat(50_000) };
assert.ok(snapshotConversationFork(task, [longReply], target.id).fork.context.includes(longReply.markdown));
assert.equal(forkTaskBody(undefined, " 普通新任务 "), "普通新任务");
console.log("conversation fork boundaries, immutable history, attachments, fresh context: passed");

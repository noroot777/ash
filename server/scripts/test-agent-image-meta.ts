// 子智能体 message/result(快照式正文)的图片账(markdown-image-meta.ts)回归 —— 审查第 8
// 轮 R2 同类漏口:这三段正文原先没有任何版本捕获,展示端直接读任务工作目录的当前文件。
//
// 验的事:
//   · 协议读到带图的 message 那一刻字节就冻住:之后文件被重写、正文改版挪位置,终态交代出
//     的记录仍是**先看到**的那一版,pos 落在终稿坐标上;
//   · 同一份文档同一字段**至多交代一次**:重复终态、close() 都不再出第二条(快照式正文没有
//     前缀推进,交代两版会让展示端同目的地计数翻倍,整组作废);
//   · result 事件(type:"result")一到就交代,不等 agent 终态;
//   · 账本合并:field 记录没有 text 事件可核,final 按原样补回、幂等不翻倍;
//   · meta 记录不进执行记录文档的身份计数:续聊种子里该文档的 refs 不被 field 记录推高。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, NativeWorkEvent } from "@ash/shared";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const red = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 1)]);
const blue = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 2)]);
const root = mkdtempSync(join(tmpdir(), "ash-image-meta-"));
process.env.ASH_UPLOADS_DIR = join(root, "data", "uploads");
process.env.ASH_RUNS_DIR = join(root, "data", "runs");
const { markdownImageSink } = await import("../src/executors/markdown-image-stream.js");
const { childActivity } = await import("../src/executors/native-agent-activity.js");
const { loadMarkdownImageSeed, markdownImageAccounting, mergeImageJournal } = await import("../src/agent-image-journal.js");
const { appendSessionTrace, parseSessionTrace, sessionTracePath } = await import("../src/transcript.js");

const TURN = "2026-10-22T12:00:00.000Z";
const colorOf = (path: string | undefined) =>
  path === undefined ? "NONE" : readFileSync(path).equals(red) ? "RED" : readFileSync(path).equals(blue) ? "BLUE" : "OTHER";
const agentEvent = (work: NativeWorkEvent): AgentEvent => ({ kind: "tool", name: "Agent", nativeWork: work });
/** 事件堆里捞出 field 标记的快照式记录(执行记录文档的附件没有 field,不混)。 */
const metaShots = (events: { event?: AgentEvent }[] | AgentEvent[]) =>
  events.flatMap((item) => {
    const event = ("event" in item ? item.event : item) as AgentEvent;
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    if (work?.type === "activity" && work.event.kind === "attachment" && work.event.field) {
      return [{ doc: work.id, field: work.event.field, source: work.event.source, ref: work.event.ref, pos: work.event.pos, path: work.event.path }];
    }
    return [];
  });

try {
  // ① message:读到那一刻冻字节;改版挪位置、文件重写都不动它;终态只交代一次。
  {
    writeFileSync(join(root, "img.png"), red);
    const sink = markdownImageSink(root);
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    const early = agentEvent({ type: "agent", id: "c1", status: "running", message: "看 ![a](img.png)" });
    assert.equal(metaShots(feed(early)).length, 0, "非终态不交代");
    writeFileSync(join(root, "img.png"), blue);
    const moved = agentEvent({ type: "agent", id: "c1", status: "running", message: "改版 ![a](img.png) 之后" });
    assert.equal(metaShots(feed(moved)).length, 0, "改版只换坐标,不交代也不重拍");
    const done = agentEvent({ type: "agent", id: "c1", status: "completed", closed: true, message: "改版 ![a](img.png) 之后" });
    const settledEvents = feed(done);
    const settled = metaShots(settledEvents);
    assert.deepEqual(
      settled.map((shot) => [shot.doc, shot.field, shot.source, shot.ref, shot.pos, colorOf(shot.path)]),
      [["c1", "message", "img.png", 0, 3, "RED"]],
      "终态交代:字节是第一次读到时的红图,pos 落在终稿坐标",
    );
    assert.equal(metaShots(feed(done)).length, 0, "重复终态不出第二条");
    assert.equal(metaShots(sink.close()).length, 0, "close 也不再交代已交代过的");
  }

  // ② result 事件一到就交代,不等 agent 终态;终态也不再补第二条。
  {
    writeFileSync(join(root, "r.png"), red);
    const sink = markdownImageSink(root);
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    feed(agentEvent({ type: "agent", id: "r1", status: "running", result: "![r](r.png)" }));
    writeFileSync(join(root, "r.png"), blue);
    const settled = metaShots(feed(agentEvent({ type: "result", id: "r1", result: "![r](r.png)", failed: false })));
    assert.deepEqual(
      settled.map((shot) => [shot.field, colorOf(shot.path)]),
      [["result", "RED"]],
      "result 事件即交代,字节是先看到的那一版",
    );
    const after = metaShots(feed(agentEvent({ type: "agent", id: "r1", status: "completed", closed: true, result: "![r](r.png)" })));
    assert.equal(after.length, 0, "终态不再重复交代 result");
  }

  // ③ 账本合并:消费者死在落笔前,field 的 final 没有 text 可核,按原样补回;幂等。
  //   同时钉身份隔离:同 id 的执行记录文档自己有 0 号附件,种子 refs 不被 field 记录推高。
  {
    writeFileSync(join(root, "k.png"), red);
    writeFileSync(join(root, "m.png"), red);
    const taskId = "task-meta";
    const sessId = "sess-meta";
    const sink = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    // 执行记录文档:一条正文一处引用 → 0 号附件,写进 trace(消费者对它尽了责)。
    const text = childActivity("c1", { kind: "text", text: "执行:![k](k.png)\n\n" });
    for (const event of [...feed(text), ...sink.close()]) appendSessionTrace(taskId, sessId, TURN, event);
    // 快照式正文:终态交代了 field 记录,但消费者死在写 trace 之前(这里就是不写)。
    const sink2 = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    sink2.capture(agentEvent({ type: "agent", id: "c1", status: "running", message: "说明 ![m](m.png)" }));
    const lost = metaShots(sink2.release(agentEvent({ type: "agent", id: "c1", status: "completed", closed: true, message: "说明 ![m](m.png)" })));
    assert.equal(lost.length, 1, "field 记录确实交代过(前提摆对)");
    const bare = parseSessionTrace(readFileSync(sessionTracePath(taskId, sessId), "utf8"));
    assert.equal(metaShots(bare.map((entry) => entry.event)).length, 0, "trace 里确实没有 field 记录(前提摆对)");
    const merged = await mergeImageJournal(taskId, sessId, bare);
    const restored = metaShots(merged.map((entry) => entry.event));
    assert.deepEqual(
      restored.map((shot) => [shot.doc, shot.field, shot.source, shot.ref, colorOf(shot.path)]),
      [["c1", "message", "m.png", 0, "RED"]],
      "field 的 final 按原身份补回(没有 text 事件可核,按原样)",
    );
    const again = await mergeImageJournal(taskId, sessId, merged);
    assert.equal(metaShots(again.map((entry) => entry.event)).length, 1, "合并幂等:trace 有的以 trace 为准");
    const seed = await loadMarkdownImageSeed(taskId, sessId);
    assert.equal(seed?.get("c1")?.refs, 1, "field 记录不进执行记录文档的身份计数");
  }

  console.log("test-agent-image-meta: all cases passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

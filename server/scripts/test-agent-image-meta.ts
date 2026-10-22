// 子智能体 message/result(快照式正文)的图片账(markdown-image-meta.ts)回归 —— 审查第 8
// 轮 R2 开的口子,复审 R1 钉死身份与版本:同一线程、同一路径、同一字段都不能证明属于同一份
// 正文。
//
// 验的事:
//   · 协议读到带图的 message 那一刻字节就冻住:之后文件被重写、正文改版挪位置,终态交代出
//     的记录仍是**先看到**的那一版,pos 落在终稿坐标上;同代至多交代一次;
//   · message 与 result 是两份独立正文:不共享「首见冻结」,各按自己到达那一刻拍字节;
//   · 清场(协议发空串)与已交代后换稿都开新一代(rev+1):新代重新冻结、重新交代,ref
//     发号器跨代连续;展示端按最高代取,这里只验记录带对 rev;
//   · 账本合并:field 的 final 要对着**落盘正文**(trace 里 agent/result 事件的最后一版)核
//     节点 —— 对得上按原身份补回、幂等;对不上(落盘的是旧版)不补 final,改按旧版坐标的
//     临时账补**合成身份**记录;消费者死在交代之前(只有临时账)同样按临时账恢复;
//   · 种子接回:refs 发号器、代号(上一进程最高代+1)、同目的地冻结字节都从种子续,磁盘上
//     文件已换也不重拍;
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
const { metaSeedKey } = await import("../src/executors/markdown-image-meta.js");
const { childActivity } = await import("../src/executors/native-agent-activity.js");
const { loadMarkdownImageSeed, markdownImageAccounting, mergeImageJournal } = await import("../src/agent-image-journal.js");
const { appendSessionTrace, parseSessionTrace, sessionTracePath } = await import("../src/transcript.js");

const TURN = "2026-10-22T12:00:00.000Z";
const SYNTH_REF_BASE = 1 << 30;
const colorOf = (path: string | undefined) =>
  path === undefined ? "NONE" : readFileSync(path).equals(red) ? "RED" : readFileSync(path).equals(blue) ? "BLUE" : "OTHER";
const agentEvent = (work: NativeWorkEvent): AgentEvent => ({ kind: "tool", name: "Agent", nativeWork: work });
/** 事件堆里捞出 field 标记的快照式记录(执行记录文档的附件没有 field,不混)。 */
const metaShots = (events: { event?: AgentEvent }[] | AgentEvent[]) =>
  events.flatMap((item) => {
    const event = ("event" in item ? item.event : item) as AgentEvent;
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    if (work?.type === "activity" && work.event.kind === "attachment" && work.event.field) {
      return [{ doc: work.id, field: work.event.field, rev: work.event.rev ?? 0, source: work.event.source, ref: work.event.ref, pos: work.event.pos, path: work.event.path }];
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
    const settled = metaShots(feed(done));
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

  // ③ 字段独立(复审 R1):message 与 result 不共享「首见冻结」—— message 先见到红图,
  //   result 后到时文件已换蓝,result 那份按 result 到达那一刻算。
  {
    writeFileSync(join(root, "shot.png"), red);
    const sink = markdownImageSink(root);
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    feed(agentEvent({ type: "agent", id: "f1", status: "running", message: "瞧 ![m](shot.png)" }));
    writeFileSync(join(root, "shot.png"), blue);
    feed(agentEvent({ type: "agent", id: "f1", status: "running", message: "瞧 ![m](shot.png)", result: "收 ![r](shot.png)" }));
    const settled = metaShots(feed(agentEvent({ type: "agent", id: "f1", status: "completed", closed: true, message: "瞧 ![m](shot.png)", result: "收 ![r](shot.png)" })));
    assert.deepEqual(
      settled.map((shot) => [shot.field, colorOf(shot.path)]),
      [["message", "RED"], ["result", "BLUE"]],
      "两个字段各按自己首见那一刻冻字节,不共享",
    );
  }

  // ④ 代(rev):清场(协议发空串)与已交代后换稿都开新一代;新代重新冻结、ref 跨代连续。
  {
    writeFileSync(join(root, "x.png"), red);
    const sink = markdownImageSink(root);
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    const first = metaShots(feed(agentEvent({ type: "agent", id: "g1", status: "completed", message: "一版 ![a](x.png)" })));
    assert.deepEqual(first.map((s) => [s.rev, s.ref, colorOf(s.path)]), [[0, 0, "RED"]], "第 0 代交代红图");
    // turn/started 清场:同线程继续发言,新结论必须配新冻结,不是上一段首见的旧字节。
    feed(agentEvent({ type: "agent", id: "g1", status: "running", message: "" }));
    writeFileSync(join(root, "x.png"), blue);
    const second = metaShots(feed(agentEvent({ type: "agent", id: "g1", status: "completed", message: "二版 ![a](x.png)" })));
    assert.deepEqual(second.map((s) => [s.rev, s.ref, colorOf(s.path)]), [[1, 1, "BLUE"]], "清场开新代:重新冻结,ref 连续");
    // 已交代之后直接换稿(没有清场信号):交代过的那版已定格,新稿是新一代。
    writeFileSync(join(root, "x.png"), red);
    const third = metaShots(feed(agentEvent({ type: "agent", id: "g1", status: "completed", message: "三版 ![a](x.png)" })));
    assert.deepEqual(third.map((s) => [s.rev, s.ref, colorOf(s.path)]), [[2, 2, "RED"]], "已交代后换稿也开新代");
  }

  // ⑤ 账本合并:final 对着落盘正文核节点。消费者死在「终态事件已写进 trace、attachment 还
  //   没写」的缝里 → 按原身份补回;幂等;身份隔离(meta 记录不推高执行记录文档的 refs)。
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
    // 快照式正文:正文事件(running + 终态)都落了盘,attachment 没落 —— 消费者死在落笔前。
    const sink2 = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    const running = agentEvent({ type: "agent", id: "c1", status: "running", message: "说明 ![m](m.png)" });
    sink2.capture(running);
    for (const event of sink2.release(running)) appendSessionTrace(taskId, sessId, TURN, event);
    appendSessionTrace(taskId, sessId, TURN, running);
    const doneEvent = agentEvent({ type: "agent", id: "c1", status: "completed", closed: true, message: "说明 ![m](m.png)" });
    sink2.capture(doneEvent);
    const lost = metaShots(sink2.release(doneEvent));
    assert.equal(lost.length, 1, "field 记录确实交代过(前提摆对)");
    appendSessionTrace(taskId, sessId, TURN, doneEvent);
    const bare = parseSessionTrace(readFileSync(sessionTracePath(taskId, sessId), "utf8"));
    assert.equal(metaShots(bare.map((entry) => entry.event)).length, 0, "trace 里确实没有 field 记录(前提摆对)");
    const merged = await mergeImageJournal(taskId, sessId, bare);
    const restored = metaShots(merged.map((entry) => entry.event));
    assert.deepEqual(
      restored.map((shot) => [shot.doc, shot.field, shot.rev, shot.source, shot.ref, colorOf(shot.path)]),
      [["c1", "message", 0, "m.png", 0, "RED"]],
      "final 对着落盘的那版正文核过节点,按原身份补回",
    );
    const again = await mergeImageJournal(taskId, sessId, merged);
    assert.equal(metaShots(again.map((entry) => entry.event)).length, 1, "合并幂等:trace 有的以 trace 为准");
    const seed = await loadMarkdownImageSeed(taskId, sessId);
    assert.equal(seed?.get("c1")?.refs, 1, "field 记录不进执行记录文档的身份计数");
    const metaSeed = seed?.get(metaSeedKey("c1", "message"));
    assert.equal(metaSeed?.refs, 1, "meta 种子:发号器接在已交代身份之后");
    assert.equal(metaSeed?.rev, 1, "meta 种子:新进程从上一进程最高代+1 起算");
    assert.equal(colorOf(metaSeed?.snapshots?.[0]?.path), "RED", "meta 种子:冻结字节按目的地接回");

    // ⑤b 种子接回:协议把同一份正文重放给新进程,文件已换蓝 —— 同目的地沿用当时的红图,
    //   ref 续号、代号用种子代,不跟上一进程共代。
    writeFileSync(join(root, "m.png"), blue);
    const sink3 = markdownImageSink(root, { ...markdownImageAccounting(taskId, sessId, TURN), seed });
    const replay = agentEvent({ type: "agent", id: "c1", status: "completed", closed: true, message: "说明 ![m](m.png)" });
    sink3.capture(replay);
    const reborn = metaShots(sink3.release(replay));
    assert.deepEqual(
      reborn.map((shot) => [shot.field, shot.rev, shot.ref, colorOf(shot.path)]),
      [["message", 1, 1, "RED"]],
      "接回进程:冻结字节与发号器从种子续,代号错开",
    );
  }

  // ⑥ 账本合并:消费者死在交代之前(只有临时账)→ 按临时账补合成身份;落盘的是旧版时,
  //   新版坐标的 final 不补(核不过节点),按旧版坐标的临时账恢复。
  {
    writeFileSync(join(root, "p.png"), red);
    writeFileSync(join(root, "s.png"), red);
    const taskId = "task-meta-crash";
    const sessId = "sess-meta-crash";
    const sink = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    // 文档 A:running 捕获了临时账,trace 里有这版正文,然后进程死了(没有终态、没有交代)。
    const runningA = agentEvent({ type: "agent", id: "a1", status: "running", message: "回 ![p](p.png)" });
    sink.capture(runningA);
    for (const event of sink.release(runningA)) appendSessionTrace(taskId, sessId, TURN, event);
    appendSessionTrace(taskId, sessId, TURN, runningA);
    // 文档 B:第一版落了盘;换稿挪坐标后的第二版没落盘,但终态按第二版交代了 final。
    const savedB = agentEvent({ type: "agent", id: "b1", status: "running", result: "甲 ![s](s.png)" });
    sink.capture(savedB);
    for (const event of sink.release(savedB)) appendSessionTrace(taskId, sessId, TURN, event);
    appendSessionTrace(taskId, sessId, TURN, savedB);
    const unsavedB = agentEvent({ type: "agent", id: "b1", status: "completed", closed: true, result: "乙乙 ![s](s.png)" });
    sink.capture(unsavedB);
    assert.equal(metaShots(sink.release(unsavedB)).length, 1, "B 的 final 确实按第二版交代过(前提摆对)");
    const bare = parseSessionTrace(readFileSync(sessionTracePath(taskId, sessId), "utf8"));
    const merged = await mergeImageJournal(taskId, sessId, bare);
    const restored = metaShots(merged.map((entry) => entry.event)).sort((x, y) => x.doc.localeCompare(y.doc));
    assert.deepEqual(
      restored.map((shot) => [shot.doc, shot.field, shot.source, colorOf(shot.path), (shot.ref ?? 0) >= SYNTH_REF_BASE, shot.pos]),
      [
        ["a1", "message", "p.png", "RED", true, 2],
        ["b1", "result", "s.png", "RED", true, 2],
      ],
      "临时账按落盘那版的坐标补合成身份;核不过节点的新版 final 一条不补",
    );
  }

  console.log("test-agent-image-meta: all cases passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// 子智能体 message/result(快照式正文)的图片账(markdown-image-meta.ts)回归 —— 审查第 8
// 轮 R2 开的口子,复审 R1 钉死身份与版本:同一线程、同一路径、同一字段都不能证明属于同一份
// 正文。
//
// 验的事:
//   · 代的判据是**正文本身**:前缀延长(流式长出来/重放)是同一代 —— 已见节点保持首见冻结,
//     延长里新出现的节点按**它出现那一刻**拍;非前缀改版、清场都开新一代,整代重拍(协议每条
//     消息都是完整快照,换稿后旧字节说的是已不存在的那版正文,第 9 轮复审 R1);同代至多交代一次;
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
  // ① message 前缀延长是同一代:已见节点保持首见冻结,延长里新出现的节点按它出现那一刻拍
  //   (复审 R1 snapshotNewOccurrence);终态只交代一次。
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
    const grownText = "看 ![a](img.png) 再看 ![b](img.png)";
    assert.equal(metaShots(feed(agentEvent({ type: "agent", id: "c1", status: "running", message: grownText }))).length, 0, "延长不交代");
    const done = agentEvent({ type: "agent", id: "c1", status: "completed", closed: true, message: grownText });
    const settled = metaShots(feed(done));
    assert.deepEqual(
      settled.map((shot) => [shot.doc, shot.field, shot.rev, shot.ref, shot.pos, colorOf(shot.path)]),
      [
        ["c1", "message", 0, 0, grownText.indexOf("![a"), "RED"],
        ["c1", "message", 0, 1, grownText.indexOf("![b"), "BLUE"],
      ],
      "同一代:旧节点仍是首见红图,新节点按出现那一刻拍成蓝图",
    );
    assert.equal(metaShots(feed(done)).length, 0, "重复终态不出第二条");
    assert.equal(metaShots(sink.close()).length, 0, "close 也不再交代已交代过的");
  }

  // ①b 非前缀改版(哪怕还没交代过)就是换稿开新代:协议每条消息都是完整快照,整代按
  //   现在的字节重拍(复审 R1 protocolMessageReplacement:第二条完整 message 不能沿用
  //   第一条冻住的字节)。
  {
    writeFileSync(join(root, "img2.png"), red);
    const sink = markdownImageSink(root);
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    feed(agentEvent({ type: "agent", id: "w1", status: "running", message: "初稿 ![a](img2.png)" }));
    writeFileSync(join(root, "img2.png"), blue);
    const rewritten = "重写 ![a](img2.png) 了";
    const settled = metaShots(feed(agentEvent({ type: "agent", id: "w1", status: "completed", closed: true, message: rewritten })));
    assert.deepEqual(
      settled.map((shot) => [shot.rev, shot.ref, shot.pos, colorOf(shot.path)]),
      [[1, 0, rewritten.indexOf("![a"), "BLUE"]],
      "非前缀改版开新代:按换稿后的字节重拍,旧代没交代过就一条都不出",
    );
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
    // 种子带的是上一进程的**最高代本身**与那版正文:要不要升代由正文判据(前缀/非前缀)
    // 决定,盲目 +1 会把协议重放的同一份正文当成新内容重拍(复审 R1 metaResumeNewTurn)。
    assert.equal(metaSeed?.rev, 0, "meta 种子:带最高代本身,不预支下一代");
    assert.equal(metaSeed?.text, "说明 ![m](m.png)", "meta 种子:带那一代的正文,接回后才能区分重放与新内容");
    assert.equal(colorOf(metaSeed?.snapshots?.[0]?.path), "RED", "meta 种子:冻结字节按节点接回");

    // ⑤b 种子接回:协议把同一份已交代的正文重放给新进程 —— 同一代、已交代,一个字节都
    //   不重拍、一条都不再出;随后真换稿(非前缀)才开新代,按现在的蓝图重拍,ref 续号。
    writeFileSync(join(root, "m.png"), blue);
    const sink3 = markdownImageSink(root, { ...markdownImageAccounting(taskId, sessId, TURN), seed });
    const replay = agentEvent({ type: "agent", id: "c1", status: "running", message: "说明 ![m](m.png)" });
    sink3.capture(replay);
    assert.equal(metaShots(sink3.release(replay)).length, 0, "重放同一份正文:同代已交代,不再出记录");
    const rewritten = agentEvent({ type: "agent", id: "c1", status: "completed", closed: true, message: "换稿 ![m](m.png)" });
    sink3.capture(rewritten);
    const reborn = metaShots(sink3.release(rewritten));
    assert.deepEqual(
      reborn.map((shot) => [shot.field, shot.rev, shot.ref, colorOf(shot.path)]),
      [["message", 1, 1, "BLUE"]],
      "接回后换稿:开新代按现在的字节重拍,发号器从种子续",
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

  // ⑦ 合并按代恢复(第 9 轮复审 R1-c):同一坐标上旧代交代过 final、新代只有临时账 ——
  //   恢复要从最新代往回找第一个核得过落盘正文的代,旧代 final 不许把新代的临时账挡掉
  //   (挡掉 = 清场换稿后只剩旧红图,蓝图永远丢失)。
  {
    writeFileSync(join(root, "g.png"), red);
    const taskId = "task-meta-gen";
    const sessId = "sess-meta-gen";
    const sink = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    for (const event of feed(agentEvent({ type: "agent", id: "gen1", status: "completed", message: "红色：![图](g.png)" }))) appendSessionTrace(taskId, sessId, TURN, event);
    for (const event of feed(agentEvent({ type: "agent", id: "gen1", status: "running", message: "" }))) appendSessionTrace(taskId, sessId, TURN, event);
    writeFileSync(join(root, "g.png"), blue);
    for (const event of feed(agentEvent({ type: "agent", id: "gen1", status: "running", message: "蓝色：![图](g.png)" }))) appendSessionTrace(taskId, sessId, TURN, event);
    sink.dispose();
    const bare = parseSessionTrace(readFileSync(sessionTracePath(taskId, sessId), "utf8"));
    const merged = await mergeImageJournal(taskId, sessId, bare);
    const restored = metaShots(merged.map((entry) => entry.event)).sort((x, y) => x.rev - y.rev);
    assert.deepEqual(
      restored.map((shot) => [shot.rev, colorOf(shot.path), (shot.ref ?? 0) >= SYNTH_REF_BASE]),
      [[0, "RED", false], [1, "BLUE", true]],
      "旧代 final 原样保留,新代临时账补合成身份 —— 展示端按最高代取到蓝图",
    );
  }

  // ⑧ 等长同坐标的换稿没落盘(第 9 轮复审第 2 轮 R1 journalAheadOfTrace):红版写进 trace,
  //   蓝版捕获了(临时账、字节都在)但一个字没保存。两版等长、同坐标、同路径 —— 节点核对
  //   分不出谁是谁,只有账上的正文指纹能:恢复与种子都只认**落盘那版**的红字节。
  {
    writeFileSync(join(root, "h.png"), red);
    const taskId = "task-meta-hash";
    const sessId = "sess-meta-hash";
    const sink = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    const saved = agentEvent({ type: "agent", id: "h1", status: "running", message: "修改前是红色：![图](h.png)" });
    sink.capture(saved);
    for (const event of sink.release(saved)) appendSessionTrace(taskId, sessId, TURN, event);
    appendSessionTrace(taskId, sessId, TURN, saved);
    writeFileSync(join(root, "h.png"), blue);
    const unsaved = agentEvent({ type: "agent", id: "h1", status: "running", message: "修改后是蓝色：![图](h.png)" });
    sink.capture(unsaved);
    sink.release(unsaved);
    const bare = parseSessionTrace(readFileSync(sessionTracePath(taskId, sessId), "utf8"));
    const restored = metaShots((await mergeImageJournal(taskId, sessId, bare)).map((entry) => entry.event));
    assert.deepEqual(
      restored.map((shot) => [shot.rev, shot.source, colorOf(shot.path), (shot.ref ?? 0) >= SYNTH_REF_BASE]),
      [[0, "h.png", "RED", true]],
      "恢复只认指纹对得上落盘正文的那一代:等长蓝版一条不补",
    );
    const doc = (await loadMarkdownImageSeed(taskId, sessId))?.get(metaSeedKey("h1", "message"));
    assert.equal(doc?.rev, 0, "种子的代号是落盘那版,不被没保存的新代推高");
    assert.equal(colorOf(doc?.snapshots?.[0]?.path), "RED", "种子接回的冻结是落盘那版的红字节");
    sink.dispose();
  }

  // ⑨ 快照身份换代(第 9 轮复审第 2 轮 R1 distinctPrefixMessages):同回合两条**完整消息**,
  //   第二条恰好是第一条的文字延长,但 messageId 换了 —— 文字前缀证明不了同一份正文,必须
  //   换代重拍;没带 messageId 的协议仍按前缀判据走(①已钉)。
  {
    writeFileSync(join(root, "m.png"), red);
    const sink = markdownImageSink(root);
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    feed(agentEvent({ type: "agent", id: "mid1", status: "running", message: "截图：![图](m.png)", messageId: "item-1" }));
    writeFileSync(join(root, "m.png"), blue);
    feed(agentEvent({ type: "agent", id: "mid1", status: "running", message: "截图：![图](m.png)\n已重拍为蓝色。", messageId: "item-2" }));
    const released = feed(agentEvent({ type: "agent", id: "mid1", status: "completed", closed: true, message: "截图：![图](m.png)\n已重拍为蓝色。", messageId: "item-2" }));
    assert.deepEqual(
      metaShots(released).map((shot) => [shot.rev, colorOf(shot.path)]),
      [[1, "BLUE"]],
      "身份换了就换代:交代的是第二条快照自己拍的蓝字节,同身份重放不再升代",
    );
    sink.dispose();
  }

  // ⑩ 结构化结果拆到子文档(第 9 轮复审第 2 轮 R1 encodedMarkdown):wait 的 statuses 包着
  //   子正文,title 带引号在原始 JSON 里是 \\" —— 按原文扫连图片节点都没有。提取按
  //   childResultTexts 与展示端同一把尺,账记在子智能体名下(doc=子 id,field=result),
  //   坐标按解码后的正文算。
  {
    writeFileSync(join(root, "w.png"), red);
    const sink = markdownImageSink(root);
    const feed = (event: AgentEvent) => {
      sink.capture(event);
      return sink.release(event);
    };
    feed(agentEvent({ type: "call", id: "wait-1", name: "wait", input: {} }));
    const released = feed(agentEvent({
      type: "result", id: "wait-1", failed: false,
      result: JSON.stringify({ statuses: { "child-9": { completed: '结果 ![图](w.png "截图说明")' } } }),
    }));
    assert.deepEqual(
      metaShots(released).map((shot) => [shot.doc, shot.field, shot.source, colorOf(shot.path), shot.pos]),
      [["child-9", "result", "w.png", "RED", 3]],
      "子正文的图按解码后的正文捕获与交代,账在子文档名下",
    );
    sink.dispose();
  }

  console.log("test-agent-image-meta: all cases passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

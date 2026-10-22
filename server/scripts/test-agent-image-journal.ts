// 「正文里的图」的持久账本(agent-image-journal.ts)回归 —— 审查第 7 轮 R2 第 2 行、R3。
//
// 验的事(全都拿**真写入**摆出来:真 trace 文件、真消费者、真账本 jsonl):
//   · 消费者死在「已交代」与「写进 trace」之间:按原身份把那条记录补回重建结果;
//   · 消费者死在交代之前(只有冻结的临时账):补一条合成身份的记录;
//   · final 和临时账都**只补已落盘正文里真有这个节点、目的地也对得上**的那一处(审查第 8
//     轮 R1 实测 B:没消费的正文补出 final,1 处引用 2 条记录,好图反被判作废);
//   · 续聊种子:从 trace + 账本读出每份文档「写到哪了、用掉几号、交代推进到哪、冻了什么」;
//   · 未交代引用跨重启要**继续交代**,字节用重启前冻结的那份(审查第 8 轮 R1 实测 A);
//   · 「读到了、写盘失败」(lost)的结论随临时账持久化,重建后拦住「读后来的文件」。
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";
import { markdownImageRefs } from "@ash/shared/markdown-images";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const red = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 1)]);
const blue = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 2)]);
const root = mkdtempSync(join(tmpdir(), "ash-image-journal-"));
process.env.ASH_UPLOADS_DIR = join(root, "data", "uploads");
process.env.ASH_RUNS_DIR = join(root, "data", "runs");
const { markdownImageSink, withMarkdownImages } = await import("../src/executors/markdown-image-stream.js");
const { eventQueue } = await import("../src/executors/event-queue.js");
const { childActivity } = await import("../src/executors/native-agent-activity.js");
const { loadMarkdownImageSeed, markdownImageAccounting, mergeImageJournal } = await import("../src/agent-image-journal.js");
const { appendSessionTrace, parseSessionTrace, sessionTracePath } = await import("../src/transcript.js");

const TURN = "2026-10-22T10:00:00.000Z";
const SYNTH_REF_BASE = 1 << 30;
const colorOf = (path: string | undefined) =>
  path === undefined ? "NONE" : readFileSync(path).equals(red) ? "RED" : readFileSync(path).equals(blue) ? "BLUE" : "OTHER";
const readTrace = (taskId: string, sessionId: string) =>
  parseSessionTrace(readFileSync(sessionTracePath(taskId, sessionId), "utf8"));
const shots = (entries: { event: { kind: string } }[]) =>
  entries.flatMap((entry) => {
    const event = entry.event as AgentEvent;
    if (event.kind === "attachment") return [{ ...entry, source: event.source, ref: event.ref, path: event.path, pos: event.pos, lost: event.lost }];
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    if (work?.type === "activity" && work.event.kind === "attachment") {
      return [{ ...entry, doc: work.id, source: work.event.source, ref: work.event.ref, path: work.event.path }];
    }
    return [];
  });

try {
  writeFileSync(join(root, "journal.png"), red);
  writeFileSync(join(root, "prov.png"), red);
  writeFileSync(join(root, "carried.png"), red);

  // ① 消费者死在「已交代」与「写进 trace」之间(落库抛错):正文到了 trace,attachment 没到。
  {
    const taskId = "task-final";
    const sessId = "sess-final";
    const stream = withMarkdownImages((async function* () {
      yield { kind: "text", text: "等定义：![待定][无定义]\n\n红图：![红图](journal.png)\n\n" } as AgentEvent;
      writeFileSync(join(root, "journal.png"), blue);
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root, markdownImageAccounting(taskId, sessId, TURN));
    await assert.rejects(async () => {
      for await (const event of stream) {
        if (event.kind === "attachment") throw new Error("fixture db write failed");
        if (event.kind === "text") appendSessionTrace(taskId, sessId, TURN, event);
      }
    }, /fixture db write failed/);
    const bare = readTrace(taskId, sessId);
    assert.equal(shots(bare).length, 0, "trace 本身确实缺了那条记录(前提摆对)");
    const merged = shots(await mergeImageJournal(taskId, sessId, bare));
    assert.deepEqual(
      merged.map((shot) => [shot.source, shot.ref, colorOf(shot.path), shot.turnStartedAt]),
      [["journal.png", 0, "RED", TURN]],
      "已交代没写进 trace 的记录按原身份补回来,字节是说到它那一刻的红图",
    );
    // 再读一遍 = 幂等:把合成结果当 trace 喂回去不会翻倍(trace 有的以 trace 为准)。
    const again = await mergeImageJournal(taskId, sessId, await mergeImageJournal(taskId, sessId, bare));
    assert.equal(shots(again).length, 1, "合并是幂等的");
  }

  // ② 消费者死在交代之前(停任务/翻页):只有冻结的临时账。
  {
    const taskId = "task-prov";
    const sessId = "sess-prov";
    const accounting = markdownImageAccounting(taskId, sessId, TURN);
    const stream = withMarkdownImages((async function* () {
      yield { kind: "text", text: "等定义：![待定][无定义]\n\n已露脸：![图](prov.png)\n\n" } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root, accounting);
    for await (const event of stream) {
      if (event.kind === "text") appendSessionTrace(taskId, sessId, TURN, event);
      break; // 消费者到此为止:交代永远不会来
    }
    // 正文没落盘的那一处不许补:手工记一笔「位置在正文之外」的临时账当对照。
    accounting.note?.({ doc: null, pos: 9999, source: "ghost.png", path: join(root, "prov.png"), final: false });
    const merged = shots(await mergeImageJournal(taskId, sessId, readTrace(taskId, sessId)));
    assert.deepEqual(
      merged.map((shot) => [shot.source, colorOf(shot.path)]),
      [["prov.png", "RED"]],
      "只冻结没交代的那一处用临时账补回;正文没落盘的一条都不补",
    );
    assert.ok((merged[0]!.ref as number) >= SYNTH_REF_BASE, "合成身份从 2^30 起,不跟真身份撞");
  }

  // ③ 续聊种子:正文认 trace,身份取 trace 与账本的并集。
  {
    const taskId = "task-seed";
    const sessId = "sess-seed";
    const first = "[proof]: carried.png\n\n第一次：![第一张][proof]\n\n";
    appendSessionTrace(taskId, sessId, TURN, childActivity("worker", { kind: "text", text: first }) as never);
    appendSessionTrace(taskId, sessId, TURN, childActivity("worker", { kind: "attachment", source: "carried.png", ref: 0, path: join(root, "prov.png") }) as never);
    // 账本里还有一条 trace 没赶上的最终账:重开后的身份也不许压到它。
    markdownImageAccounting(taskId, sessId, TURN).note?.({ doc: "worker", pos: 40, source: "carried.png", ref: 3, final: true });
    const seed = await loadMarkdownImageSeed(taskId, sessId);
    assert.deepEqual(
      [...(seed ?? new Map()).entries()].map(([id, doc]) => [id, doc.text === first, doc.refs]),
      [["worker", true, 4]],
      "种子 = trace 里的正文 + 两边都算上的最高身份",
    );
  }

  // ④ 消费者好好活着:合并一个字都不加。
  {
    const taskId = "task-noop";
    const sessId = "sess-noop";
    const stream = withMarkdownImages((async function* () {
      yield { kind: "text", text: "一切正常：![图](journal.png)\n\n" } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root, markdownImageAccounting(taskId, sessId, TURN));
    for await (const event of stream) {
      if (event.kind === "text" || event.kind === "attachment") appendSessionTrace(taskId, sessId, TURN, event as never);
    }
    const bare = readTrace(taskId, sessId);
    const merged = await mergeImageJournal(taskId, sessId, bare);
    assert.equal(merged.length, bare.length, "trace 已经齐全时合并不添一条");
  }

  // ⑤ 重启接回:回合没换、进程换了 —— **主文档**的前半截也要接(mainTurnStartedAt),
  // 不只是子文档。接回的 sink 不接,主文档的第一处引用又从 0 号发起,跟同一回合里重启前
  // 已交代的 0 号相撞;前半截给的定义它也不认。
  {
    const taskId = "task-reattach";
    const sessId = "sess-reattach";
    const firstHalf = "[proof]: carried.png\n\n重启前：![第一张][proof]\n\n";
    appendSessionTrace(taskId, sessId, TURN, { kind: "text", text: firstHalf } as never);
    appendSessionTrace(taskId, sessId, TURN, { kind: "attachment", source: "carried.png", ref: 0, path: join(root, "prov.png") } as never);
    // 别的回合的主正文不许混进来(主文档一回合一份)。
    appendSessionTrace(taskId, sessId, "2026-10-22T09:00:00.000Z", { kind: "text", text: "上一回合的话。" } as never);
    const seed = await loadMarkdownImageSeed(taskId, sessId, { mainTurnStartedAt: TURN });
    assert.deepEqual(
      [...(seed ?? new Map()).entries()].map(([id, doc]) => [id, doc.text === firstHalf, doc.refs]),
      [["", true, 1]],
      "主文档种子只装接回那一轮的正文与身份",
    );
    const resumed: AgentEvent[] = [];
    for await (const event of withMarkdownImages((async function* () {
      yield { kind: "text", text: "重启后：![第二张][proof]\n\n" } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root, { seed })) resumed.push(event);
    assert.deepEqual(
      resumed.flatMap((event) => (event.kind === "attachment" ? [[event.ref, event.source, !!event.path]] : [])),
      [[1, "carried.png", true]],
      "接回后主文档身份从 1 号接着发,重启前的定义照旧认得",
    );
  }

  // ⑥ **未交代引用跨重启**(审查第 8 轮 R1 实测 A:红蓝对调)。重启前:待定引用把后面那
  // 处红图扣着没交代,正文已落 trace、字节已冻结(临时账)。接回后重拍成蓝、继续说蓝图。
  // 种子必须核实「已交代 = 前 0 条」→ 交代线回到 0,接回的 sink 把红图**继续交代**出去:
  // 文档顺序红前蓝后、字节各是说到它那一刻的那份,红图用的是重启前冻结的拷贝。
  {
    const taskId = "task-restart-order";
    const sessId = "sess-restart-order";
    const shot = join(root, "shot.png");
    writeFileSync(shot, red);
    const text1 = { kind: "text", text: "等稍后的定义：![未定][never]\n\n修改前是红色：![修改前](shot.png)\n\n" } as AgentEvent;
    const sink1 = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    sink1.capture(text1);
    for (const event of sink1.release(text1)) appendSessionTrace(taskId, sessId, TURN, event as never);
    sink1.dispose();
    assert.equal(shots(readTrace(taskId, sessId)).length, 0, "前提:红图被待定引用扣着,重启前没交代");
    const seed = await loadMarkdownImageSeed(taskId, sessId, { mainTurnStartedAt: TURN });
    writeFileSync(shot, blue);
    for await (const event of withMarkdownImages((async function* () {
      yield { kind: "text", text: "修改后是蓝色：![修改后](shot.png)\n\n" } as AgentEvent;
      yield { kind: "done", exitStatus: 0 } as AgentEvent;
    })(), root, markdownImageAccounting(taskId, sessId, TURN, seed))) {
      if (event.kind === "text" || event.kind === "attachment") appendSessionTrace(taskId, sessId, TURN, event as never);
    }
    const merged = shots(await mergeImageJournal(taskId, sessId, readTrace(taskId, sessId)));
    assert.deepEqual(
      merged.map((shot2) => [shot2.ref, colorOf(shot2.path)]),
      [[0, "RED"], [1, "BLUE"]],
      "接回后继续交代:红图 0 号在前(重启前冻结的那份字节)、蓝图 1 号在后",
    );
    assert.ok(
      merged.every((item) => typeof item.pos === "number") && merged[0]!.pos! < merged[1]!.pos!,
      "每条记录带文档节点身份 pos,且与文档顺序一致",
    );
  }

  // ⑦ **尚未消费的正文不许补出 final**(审查第 8 轮 R1 实测 B:1 处引用恢复出 2 条记录,
  // 已交付的好图反被拖成作废)。第二段正文连同它的 attachment 都在队列里没被消费:协议
  // 入口已经写了最终账,但那段正文从没落盘 —— 恢复时按已落盘正文核对节点,这条不补。
  {
    const taskId = "task-final-ghost";
    const sessId = "sess-final-ghost";
    const shot = join(root, "shot2.png");
    writeFileSync(shot, red);
    const sink = markdownImageSink(root, markdownImageAccounting(taskId, sessId, TURN));
    const queue = eventQueue({ images: sink });
    queue.push({ kind: "text", text: "已交付：![修改前](shot2.png)\n\n" } as AgentEvent);
    const iterator = queue.drain()[Symbol.asyncIterator]();
    for (let index = 0; index < 2; index += 1) {
      const next = await iterator.next();
      if (!next.done) appendSessionTrace(taskId, sessId, TURN, next.value as never);
    }
    writeFileSync(shot, blue);
    queue.push({ kind: "text", text: "尚未写入：![修改后](shot2.png)\n\n" } as AgentEvent);
    await iterator.return?.();
    sink.dispose();
    const bare = readTrace(taskId, sessId);
    const persistedText = bare.flatMap((entry) => (entry.event.kind === "text" ? [entry.event.text] : [])).join("");
    const merged = shots(await mergeImageJournal(taskId, sessId, bare));
    assert.equal(markdownImageRefs(persistedText).length, 1, "前提:已落盘正文只有 1 处引用");
    assert.deepEqual(
      merged.map((shot2) => [shot2.source, colorOf(shot2.path)]),
      [["shot2.png", "RED"]],
      "恢复结果与已落盘正文一一对应:没落盘那处的 final 不补,已交付的红图原样",
    );
  }

  // ⑧ **「字节读到了、写盘失败」的结论也要持久化**(审查第 8 轮 R1 同类位置):消费者死后
  // 刷新重建,这处引用必须有一条 lost 记录拦着,否则前端会退去读后来的文件。
  {
    const taskId = "task-lost";
    const sessId = "sess-lost";
    const green = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 3)]);
    writeFileSync(join(root, "lost.png"), green);
    const uploadsDir = process.env.ASH_UPLOADS_DIR!;
    mkdirSync(uploadsDir, { recursive: true });
    chmodSync(uploadsDir, 0o500);
    try {
      const stream = withMarkdownImages((async function* () {
        yield { kind: "text", text: "丢了：![丢了](lost.png)\n\n" } as AgentEvent;
        yield { kind: "done", exitStatus: 0 } as AgentEvent;
      })(), root, markdownImageAccounting(taskId, sessId, TURN));
      for await (const event of stream) {
        // lost 的交代排在正文前面(release 先结清再放行原事件):把正文写进 trace 就停,
        // attachment 一条都不落盘 —— 消费者死在交代与落盘之间。
        if (event.kind === "text") {
          appendSessionTrace(taskId, sessId, TURN, event as never);
          break;
        }
      }
    } finally {
      chmodSync(uploadsDir, 0o755);
    }
    const seed = await loadMarkdownImageSeed(taskId, sessId, { mainTurnStartedAt: TURN });
    assert.ok(
      seed?.get("")?.snapshots?.some((snap) => snap.lost === true && snap.destination === "lost.png"),
      "种子接回「丢了」的结论,接回的 sink 不会去读后来的文件",
    );
    const merged = shots(await mergeImageJournal(taskId, sessId, readTrace(taskId, sessId)));
    assert.deepEqual(
      merged.map((shot2) => [shot2.source, shot2.lost, shot2.path ?? null]),
      [["lost.png", true, null]],
      "合并补回一条 lost 记录:这处那一刻的画面确实丢了,不拿现在的文件顶上",
    );
  }

  console.log("正文图片持久账本回归通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}

// 「正文里的图」的持久账本(agent-image-journal.ts)回归 —— 审查第 7 轮 R2 第 2 行、R3。
//
// 验三件事,全都拿**真写入**摆出来(真 trace 文件、真消费者、真账本 jsonl):
//   · 消费者死在「已交代」与「写进 trace」之间:按原身份把那条记录补回重建结果;
//   · 消费者死在交代之前(只有冻结的临时账):补一条合成身份的记录,但**只补正文真到了
//     trace 的那一处**,正文没落盘的引用一条都不补(硬补会把展示端的配对计数弄失衡);
//   · 续聊种子:从 trace + 账本读出每份子文档「写到哪了、用掉几号」。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@ash/shared";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const red = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 1)]);
const blue = Buffer.concat([Buffer.from(PNG_BASE64, "base64"), Buffer.alloc(4, 2)]);
const root = mkdtempSync(join(tmpdir(), "ash-image-journal-"));
process.env.ASH_UPLOADS_DIR = join(root, "data", "uploads");
process.env.ASH_RUNS_DIR = join(root, "data", "runs");
const { withMarkdownImages } = await import("../src/executors/markdown-image-stream.js");
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
    if (event.kind === "attachment") return [{ ...entry, source: event.source, ref: event.ref, path: event.path }];
    const work = event.kind === "tool" ? event.nativeWork : undefined;
    if (work?.type === "activity" && work.event.kind === "attachment") {
      return [{ ...entry, doc: work.id, source: work.event.source, ref: work.event.ref, path: work.event.path }];
    }
    return [];
  });

try {
  writeFileSync(join(root, "journal.png"), red);
  writeFileSync(join(root, "prov.png"), red);

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

  console.log("正文图片持久账本回归通过");
} finally {
  rmSync(root, { recursive: true, force: true });
}

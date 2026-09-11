// 崩掉的那一轮审查重跑时，到底是**接着做**还是**从头再来**——判据钉在这里。
//
// 认错的代价是两头的：认宽了（对一条从没见过本轮任务的 CLI 会话说「接着做」）它要么发呆、
// 要么接着上一轮的事往下说；认窄了就是每次掉线都把整轮审查重跑一遍，这一轮崩在 10M token
// 上，重来一次就是再烧 10M（2026-09-11 用户报的就是这个）。
// 跑:npm -w server run test:review-resume
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-review-resume-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

const TURN = "2026-09-11T06:41:48.783Z";
const PREV = "2026-09-11T05:00:00.000Z";

try {
  const { appendSessionTrace, sessionTracePath, turnProducedWork } = await import("../src/transcript.js");
  const { freeReviewResumeMessage } = await import("../src/free-review-prompts.js");

  const line = (turnStartedAt: string, event: Record<string, unknown>) =>
    JSON.stringify({ at: turnStartedAt, turnStartedAt, event });

  // ── ① 本轮说过话 / 动过工具 → 上下文在 CLI 会话里，接着做 ──────────────────
  {
    const path = sessionTracePath("t-spoke", "s1");
    mkdirSync(join(root, "runs", "t-spoke"), { recursive: true });
    writeFileSync(path, [
      line(TURN, { kind: "run", model: "claude-opus-5", reasoningEffort: "high" }),
      line(TURN, { kind: "text", text: "I'll start by reading the review context." }),
      line(TURN, { kind: "tool", name: "Read", detail: "{}" }),
    ].join("\n") + "\n");
    assert.equal(await turnProducedWork("t-spoke", "s1", TURN), true, "有正文/工具事件 = CLI 起来了、任务书到手了");
  }

  // ── ② 本轮只有 run/error（503 起不来、启动就挂）→ 无处可接，重发整份任务书 ──
  {
    const path = sessionTracePath("t-dead", "s1");
    mkdirSync(join(root, "runs", "t-dead"), { recursive: true });
    writeFileSync(path, [
      line(TURN, { kind: "run", model: "claude-opus-5", reasoningEffort: "high" }),
      line(TURN, { kind: "error", text: "no available account" }),
    ].join("\n") + "\n");
    assert.equal(await turnProducedWork("t-dead", "s1", TURN), false, "CLI 没开过口就没有可接的上下文");
  }

  // ── ③ 干过活的是**上一轮**：跨轮复用的会话上最容易认错的一种 ────────────────
  // 第 2 轮派下去，CLI 还没起来就崩了。会话里满是第 1 轮的正文，但那条 CLI 会话
  // 根本没见过第 2 轮的任务书，对它说「接着做」它会接着第 1 轮往下说。
  {
    const path = sessionTracePath("t-prev", "s1");
    mkdirSync(join(root, "runs", "t-prev"), { recursive: true });
    writeFileSync(path, [
      line(PREV, { kind: "text", text: "第 1 轮：我看完了，结论是通过。" }),
      line(PREV, { kind: "tool", name: "Bash", detail: "{}" }),
      line(TURN, { kind: "run", model: "claude-opus-5", reasoningEffort: "high" }),
    ].join("\n") + "\n");
    assert.equal(await turnProducedWork("t-prev", "s1", TURN), false, "上一轮的输出不能算作本轮的上下文");
    assert.equal(await turnProducedWork("t-prev", "s1", PREV), true, "按轮次分得开");
  }

  // ── ④ 尾部截断：判据只读尾巴，前面写多少都不影响结论 ─────────────────────────
  {
    mkdirSync(join(root, "runs", "t-long"), { recursive: true });
    const path = sessionTracePath("t-long", "s1");
    writeFileSync(path, "");
    for (let i = 0; i < 4000; i += 1) {
      appendSessionTrace("t-long", "s1", PREV, { kind: "text", text: `第 1 轮的第 ${i} 段正文`.repeat(4) }, PREV);
    }
    appendSessionTrace("t-long", "s1", TURN, { kind: "text", text: "第 2 轮开工" }, TURN);
    assert.equal(await turnProducedWork("t-long", "s1", TURN), true, "本轮的事件贴在文件末尾，尾巴一定读得到");
  }

  // ── ⑤ 没有 trace（老会话、产物被清过）→ 不猜，按重发整份走 ──────────────────
  assert.equal(await turnProducedWork("t-missing", "s1", TURN), false, "无从证明干过活时不许认成可接着做");

  // ── 续跑那句话必须自带收尾指令 ─────────────────────────────────────────────
  // 它刻意不重发任务书（那正是省下来的那部分），于是上文尾巴一旦被截断，报告落哪、
  // 结论怎么报就全丢了 —— 这两样必须在这句话里自带，否则这一轮又会以「没给出结论」收场。
  {
    const task = { id: "T-1" } as Parameters<typeof freeReviewResumeMessage>[0];
    const run = { id: "run-1", targetKind: "workspace" } as Parameters<typeof freeReviewResumeMessage>[1];
    const message = freeReviewResumeMessage(task, run, 2);
    assert.ok(message.includes("report.md"), "报告落盘路径必须带上");
    assert.ok(message.includes(`report_stage(taskId="T-1"`), "上报结论的调用必须带上");
    assert.ok(message.includes("directionToken"), "方向身份必须带上，否则 report_stage 会被拒");
    assert.ok(message.includes("不要调用 complete_task"), "旁路审查回合的边界必须重申");
    assert.ok(/不要从头/.test(message), "这句话的全部意义就是「别从头再来」");
    assert.ok(message.length < 700, `续跑指令要短，现在 ${message.length} 字`);
  }

  console.log("✓ review resume predicate");
} finally {
  rmSync(root, { recursive: true, force: true });
}

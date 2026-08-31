// 结算说明的落盘往返：server 写下的那一行，读端必须认得出它是「说明」而不是输入/故障。
//
// 病症（用户 2026-08-31 报的）：agent 没调 complete_task 就结束，任务照严格完成协议记
// failed，而那句说明被写成「.md 一段引用 + trace 一条 error」——界面上是一条红色的
// 「执行过程 · 22 工具 · 1 异常」，第一次用 ash 的人读到的结论是「它崩了」。现在它落成
// 带 level:"notice" 的 system 旁注行。两件事在这里钉住：
//   ① 往返不丢标记：writeTurn 写下的 level，parseSessionOutput 读得回来（展示端的语气
//      靠它，而不是靠关键词猜 —— 说明里天然带着「未完成」，猜出来永远是红的）；
//   ② 它不是「上一回合的输入」：结算说明恒排在最后一个真人回合之后，`lastInputOf` 必须
//      跳过它，否则每个「没交卷」的失败回合都会让「重跑上一回合」静默退回 resume。
// 跑：npm -w server run test:settlement-note
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { parseSessionOutput } from "@ash/shared";
import { writeTurn } from "../src/transcript.js";
import { lastInputOf } from "../src/task-retry-turn.js";

const NOTE = "本回合没有交卷:agent 结束前没有调用 complete_task 确认目标已达成,按 ash 的完成协议记为未完成。";

function persisted(write: (out: NodeJS.WritableStream) => void): string {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  write(stream);
  stream.end();
  return Buffer.concat(chunks).toString("utf8");
}

const output = persisted((out) => {
  writeTurn(out, { t: "user", agent: "claude", text: "把标题也改一下" }, "2026-08-31T09:40:00.000Z");
  out.write("\n改好了。\n");
  writeTurn(out, { t: "system", agent: "claude", text: NOTE, level: "notice" }, "2026-08-31T09:52:13.000Z");
});

const segs = parseSessionOutput(output);
const note = segs.at(-1);
assert.equal(note?.kind, "system", "结算说明该是独立的 system 段，不该糊进 agent 正文");
assert.equal(note?.kind === "system" ? note.level : undefined, "notice", "落盘往返把 level 丢了");
assert.equal(note?.text, NOTE);

const input = lastInputOf(output);
assert.equal(input?.kind, "user", "结算说明被当成了上一回合的输入");
assert.equal(input?.text, "把标题也改一下");

// 没标 level 的系统行照旧是「上一轮本来就是系统续跑」，重投它没有意义。
const resumed = persisted((out) => {
  writeTurn(out, { t: "user", agent: "claude", text: "开工" }, "2026-08-31T09:00:00.000Z");
  writeTurn(out, { t: "system", agent: "claude", text: "继续（从中断处）" }, "2026-08-31T09:10:00.000Z");
});
assert.equal(lastInputOf(resumed)?.kind, "system");

console.log("✓ settlement note round-trip");

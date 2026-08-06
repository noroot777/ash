/**
 * parseClaudeStream 对 **API 层失败** 的上报。
 *
 * 起因(2026-08-01):团队调度台配了 `claude --model kimi/kimi-k3` 打百炼的 anthropic
 * 端点,模型不存在 → 404。CLI 把这件事报成两条:
 *   1. 一条 `model:"<synthetic>"` 的 assistant 消息,text 里写着人话的错误原因
 *   2. 一条 `subtype:"success"` + `is_error:true` + `api_error_status:404` 的 result
 * 解析器当时两条都漏了 —— text 因为「已由 delta 流过」被跳过(合成消息根本没有
 * delta),result 因为只看 subtype 被判成正常结束。结果 .md 里只剩一行 agentEnd,
 * 用户看到的是「任务停在那不动」,查不出任何原因。
 *
 * 这份测试用假 CLI 输出把两条路都钉住。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseClaudeStream } = await import("../src/executors/claude.js");

const dir = mkdtempSync(join(tmpdir(), "harness-claude-stream-"));
let bad = 0;
const fail = (m: string) => { console.log("   ✕ " + m); bad++; };
const ok = (m: string) => console.log("   ✓ " + m);

/** 跑一段假 CLI stdout,收集 parseClaudeStream 吐出的事件。 */
async function collect(lines: unknown[], resident?: { interruptPending: boolean }) {
  const script = join(dir, `stub-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(
    script,
    lines.map((line) => `process.stdout.write(${JSON.stringify(JSON.stringify(line) + "\n")});`).join("\n"),
  );
  const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  const events: any[] = [];
  for await (const event of parseClaudeStream(child as any, resident)) events.push(event);
  return events;
}

const SYNTHETIC_404 = [
  { type: "system", session_id: "sess-1" },
  {
    type: "assistant",
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: "There's an issue with the selected model (kimi/kimi-k3)." }],
    },
    error: "model_not_found",
  },
  { type: "result", subtype: "success", is_error: true, api_error_status: 404, session_id: "sess-1", result: "There's an issue with the selected model (kimi/kimi-k3)." },
];

console.log("1) API 层失败(404 model_not_found)必须既留下原因、又报错");
{
  const events = await collect(SYNTHETIC_404);
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  const errors = events.filter((e) => e.kind === "error");
  if (text.includes("kimi/kimi-k3")) ok("合成消息的错误说明进了正文");
  else fail(`合成消息的 text 丢了(收到 ${JSON.stringify(text)})`);
  if (errors.length === 1) ok("报了一次 error");
  else fail(`期望 1 条 error,实到 ${errors.length}`);
  if (errors[0]?.message?.includes("404")) ok(`error 带上了 HTTP 状态:${errors[0].message}`);
  else fail(`error 没带状态码:${errors[0]?.message}`);
}

console.log("2) 真模型的正文仍然只走 delta,不因为这次改动重复一遍");
{
  const events = await collect([
    { type: "system", session_id: "sess-2" },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你好\n" } } },
    { type: "assistant", message: { model: "claude-opus-5", content: [{ type: "text", text: "你好" }] } },
    { type: "result", subtype: "success", session_id: "sess-2" },
  ]);
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  const errors = events.filter((e) => e.kind === "error");
  if (text.trim() === "你好") ok("正文没有重复");
  else fail(`正文重复或缺失:${JSON.stringify(text)}`);
  if (!errors.length) ok("成功回合不报错");
  else fail(`成功回合冒出了 error:${errors[0].message}`);
}

console.log("3) 用户主动打断仍然不算故障");
{
  const resident = { interruptPending: true };
  const events = await collect(
    [
      { type: "system", session_id: "sess-3" },
      { type: "result", subtype: "error_during_execution", is_error: true, session_id: "sess-3" },
    ],
    resident,
  );
  const errors = events.filter((e) => e.kind === "error");
  if (!errors.length) ok("自己发的 interrupt 不上报");
  else fail(`打断被误报成故障:${errors[0].message}`);
  if (events.some((e) => e.kind === "turnEnd")) ok("常驻回合正常收尾");
  else fail("常驻模式没有 turnEnd");
}

console.log(bad ? `\n✗ ${bad} 项未通过` : "\n✓ 全部通过");
process.exit(bad ? 1 : 0);

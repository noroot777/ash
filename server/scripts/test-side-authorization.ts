import assert from "node:assert/strict";
import { authorizationIsFromSource, sideAuthorizationPrompt, verifySideChatReply } from "../src/chat/side-authorization.js";
import type { SideChatReply } from "../src/chat/side-prompt.js";

const source = "把结论告诉主任务，回头再发";
const result: SideChatReply = { reply: "完整的侧聊回答", task: null, forward: { text: "仅回传正文中的标记", authorization: "把结论告诉主任务" } };
const signal = new AbortController().signal;
const verdict = (decision: string) => ({ text: JSON.stringify({ decision, reason: "独立核验的结果" }) });
assert.equal(authorizationIsFromSource(source, "把结论告诉主任务"), true);
assert.equal(authorizationIsFromSource(source, "另一条历史里的授权"), false);
assert.equal(authorizationIsFromSource(source, "  "), false);
assert.equal(sideAuthorizationPrompt(source).split("【当前用户消息】\n").at(-1), JSON.stringify(source));

let calls = 0;
const rejected = await verifySideChatReply(result, source, async (prompt) => {
  calls++;
  assert.equal(JSON.parse(prompt.split("【当前用户消息】\n").at(-1)!), source);
  assert.doesNotMatch(prompt, /仅回传正文中的标记|完整的侧聊回答/);
  return verdict("do_not_send");
}, signal);
assert.equal(calls, 1);
assert.equal(rejected.forward, null);
assert.equal(rejected.reply, result.reply);
assert.ok(rejected.forwardError);
const approvedSource = "把结论告诉主任务";
const approved = await verifySideChatReply(result, approvedSource, async () => verdict("send_now"), signal);
assert.equal(approved.forward?.text, result.forward!.text, "独立核验明确同意后形成可投递结果");
let unnecessaryCalls = 0;
const unusedJudge = async () => { unnecessaryCalls++; return verdict("send_now"); };
assert.equal((await verifySideChatReply(result, "历史不等于当前授权", unusedJudge, signal)).forward, null);
assert.equal((await verifySideChatReply({ ...result, forward: null }, source, unusedJudge, signal)).forward, null);
assert.equal(unnecessaryCalls, 0, "无当前授权或普通回答都不调用核验器");

for (const text of ['{"decision":true,"reason":"wrong type"}', '{"decision":"send_now"}', '{"decision":"unknown","reason":"unknown"}', 'not JSON', '{"decision":"send_now","reason":""}', verdict("unclear").text]) {
  const reply = await verifySideChatReply(result, source, async () => ({ text }), signal);
  assert.equal(reply.forward, null, text);
  assert.equal(reply.reply, result.reply);
  assert.ok(reply.forwardError);
}
const failed = await verifySideChatReply(result, source, async () => { throw new Error("供应商错误"); }, signal);
assert.equal(failed.forward, null);
assert.equal(failed.reply, result.reply);
const timeout = await verifySideChatReply(result, source, async () => new Promise(() => {}), signal, 5);
assert.equal(timeout.forward, null);
assert.equal(timeout.reply, result.reply);
assert.match(timeout.forwardError!, /超时/);
const stopped = new AbortController();
const late = verifySideChatReply(result, source, async () => {
  stopped.abort(new Error("用户停止"));
  return verdict("send_now");
}, stopped.signal);
await assert.rejects(late, /用户停止/);
console.log("✓ 独立核验只读取当前原话；原文约束、严格判定、格式/错误/超时关闭投递、停止竞态通过（模拟核验器）");

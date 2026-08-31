// 结算说明（「这一轮为什么落成这个状态」）在会话里长什么样。
//
// 病症：agent 没调 complete_task 就结束，server 照严格完成协议记 failed，然后把那句说明
// 写成「.md 里一段引用 + trace 里一条 error」。用户看到的是一条红色的「执行过程 · 22 工具 ·
// 1 异常」折叠条（收工即自动折起），展开才是那句话，而话里全是内部黑话。第一次用 ash 的
// 人读到的结论只有一个：它崩了。真出故障时它还会盖住真正的原因（docs/incidents.md
// 「接力到多用户机器」——那一轮页面上只有这一句，真凶是会话文件写错了目录）。
//
// 现在它是**会话旁注**，并由服务端显式标 level:"notice"：跟真故障分家（不再计进「N 异常」、
// 不再把折叠条染红），语气由标记决定而不是靠关键词猜——说明里天然带着「未完成」，猜出来
// 永远是红的。实时（SSE system 事件）与刷新（.md sentinel 行）必须给出同一个结论。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";

const STARTED = "2026-08-31T09:46:00.000Z";
const AT = "2026-08-31T09:52:13.000Z";
const NOTE = "本回合没有交卷:agent 结束前没有调用 complete_task 确认目标已达成,按 ash 的完成协议记为未完成。";

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "claude",
  role: "single",
  executor: "claude@ccb",
  startedAt: STARTED,
  endedAt: "2026-08-31T09:52:14.000Z",
};

const sentinel = (payload) => `\n\x1e${JSON.stringify(payload)}\n`;
const notes = (items) => items.filter((item) => item.kind === "event" && item.variant === "note");

// 1. 刷新后这条路：.md 的 sentinel 行带着 level，旁注拿到 notice 语气（不是 error）。
{
  const output = [
    "查清了，两个问题的成因不一样。",
    sentinel({ t: "system", agent: "claude", text: NOTE, at: AT, level: "notice" }),
  ].join("");
  const items = notes(buildConversationItems([{ session, output, trace: [] }], [session], []));
  assert.equal(items.length, 1, "结算说明该是一条独立旁注");
  assert.equal(items[0].text, NOTE);
  assert.equal(items[0].tone, "notice", "带 level 的旁注不该被判成故障");
}

// 2. 实时那条路（SSE 的 system 事件）：同一个结论，刷新前后不许换脸。
{
  const timeline = [{
    kind: "server",
    id: "live:1",
    event: {
      type: "agent.event",
      taskId: "t1",
      sessionId: "s1",
      role: "single",
      agentType: "claude",
      event: { kind: "system", text: NOTE, at: AT, level: "notice" },
    },
  }];
  const items = notes(buildConversationItems([{ session, output: "查清了。", trace: [] }], [session], timeline));
  assert.equal(items.length, 1);
  assert.equal(items[0].tone, "notice");
}

// 3. 没标 level 的旁注照旧按关键词判语气 —— 真失败仍要红（validation 打回、清理失败这些
//    都走同一条通道，别被这次改动一起洗白）。
{
  const output = sentinel({ t: "system", agent: "claude", text: "合并结果审查未通过。", at: AT });
  const items = notes(buildConversationItems([{ session, output, trace: [] }], [session], []));
  assert.equal(items[0].tone, "error");
}

// 4. 结算说明**不**再进执行过程：气泡里一个事件都不该多出来（红叉、「1 异常」的来源）。
{
  const output = [
    "查清了。",
    sentinel({ t: "system", agent: "claude", text: NOTE, at: AT, level: "notice" }),
  ].join("");
  const items = buildConversationItems([{ session, output, trace: [] }], [session], []);
  const events = items.filter((item) => item.kind === "agent").flatMap((item) => item.segments.flatMap((s) => s.events));
  assert.deepEqual(events, [], "结算说明不该以执行过程事件的身份再出现一次");
}

console.log("settlement note tests passed");

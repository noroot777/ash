// 回合级停滞看门狗的**解除条件**:到底什么算「上游真回话了」。
// 跑:npm -w server run test:turn-stall-progress
//
// 两档动手(阈值、熔断、回收、现场重放)在 test-turn-stall.ts;这一份只钉判据本身 ——
// 判据整份住在 `@ash/shared/waiting` 的 `producesWork`,它被三条消费链共用,漂一个字就会
// 让「同一次重试」在不同表面上给出不同结论。夹具见 stall-fixtures.ts。
import assert from "node:assert/strict";
import type { AgentEvent } from "@ash/shared";
import { codexErrorEvent } from "../src/executors/codex-error-event.js";
import { childActivity } from "../src/executors/native-agent-activity.js";
import { __resetTurnStalls, clearTurnStall, trackTurnStall } from "../src/turn-stall.js";
import { configure, hard, notice, RETRY, spy, TURN } from "./stall-fixtures.js";

// ── ③a 解除条件:**上游真的回话了**那一类 ───────────────────────────────────────
// 判据共用 `@ash/shared/waiting` 的 `resumesWaiting`(那个文件就是为了不让三处判据各自漂)。
{
  for (const resume of [
    { kind: "text", text: "续" },
    { kind: "thinking", text: "想" },
    { kind: "tool", name: "Bash", detail: "{}" },
    { kind: "attachment", path: "/tmp/a.png" },
    { kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    { kind: "turnEnd" },
    { kind: "done", exitStatus: 0 },
  ] as AgentEvent[]) {
    configure({ warnErrors: 2 });
    const { actions, log } = spy();
    const owner = {};
    trackTurnStall("s3", owner, TURN, notice(), actions);
    trackTurnStall("s3", owner, TURN, resume, actions);
    trackTurnStall("s3", owner, TURN, notice(), actions);
    assert.equal(log.warns.length, 0, `${resume.kind} 没能解除停滞 —— 上游真回话了就不许动手`);
  }
}

// ── ③b **辅助通知既不解除也不计数**(第 2 轮审查 F1,已实测) ─────────────────────
// 这一档从前被算进「非错误就是有进展」里,于是 Claude 每条重试提示后面紧跟的那条 `session`
// (只是把 CLI 会话 id 报一遍)把停滞当场解除 —— 8 次重试、远超阈值,页面上既不报警也不熔断,
// 任务一直显示运行中。`session`/`context`/`system` 都不是上游回话:会话身份是 adapter 自己
// 报的,上下文水位是本地算的,`system` 是旁注。真 adapter 序列那一面见 test-claude-retry-stall。
{
  for (const aside of [
    { kind: "session", cliSessionId: "abc" },
    { kind: "context", context: { used: 1, window: 2, windowEstimated: false } },
    { kind: "system", text: "旁注" },
  ] as AgentEvent[]) {
    configure({ warnErrors: 2 });
    const { actions, log } = spy();
    const owner = {};
    trackTurnStall("s3b", owner, TURN, notice(), actions);
    trackTurnStall("s3b", owner, TURN, aside, actions);
    trackTurnStall("s3b", owner, TURN, notice(), actions);
    assert.equal(log.warns.length, 1, `${aside.kind} 把停滞解除了 —— 它不是上游回话`);
    assert.equal(log.warns[0]!.facts.errors, 2, `${aside.kind} 自己被算成了一条错误`);
    // 诊断里「卡在哪一步」不许被它顶替:一条正常输出都没有过(连接从头没建起来)和
    // 「`tool` 之后挂住」是两种现场,把身份通知说成最后那步进展会把人带到另一条路上去查。
    assert.equal(
      log.warns[0]!.facts.lastProgressKind,
      null,
      `熔断诊断把「卡在哪一步」说成了 ${aside.kind} 这条辅助通知`,
    );
  }
}

// ── ③d **原生包装按「那一类本职装什么」认**(审查 F1 的根) ───────────────────────
// `type:"agent"` 是**状态投影**(驱动侧栏那张子智能体卡片),不是产出的载体 —— 同一份定位
// 早就写在 `isVisibleExecutionEvent` 里。真产出走 `activity`/`call`/`result`,而生产侧对同
// 一条原始通知是成对 push 的,所以这一类一律不算「上游回话了」,一条都不许解除停滞。
//
// 下面三种恰好是上一版那种结构判据(看 message/result 非空、看 status 终态)会**逐个放行**
// 的:真实 claude 心跳的 message 装着 last_tool_name,档位通知带 title/model,子智能体完成
// 通知带 result + 终态。靠结构猜就得逐个生产点打补丁,新增一个又漏一个。
{
  const wrap = (work: Record<string, unknown>): AgentEvent =>
    ({ kind: "tool", name: "Agent", nativeWork: { type: "agent", id: "child-1", ...work } } as AgentEvent);
  for (const [label, event] of [
    ["「仍在运行」心跳(message 装着当前那一步的名字)", wrap({ status: "running", message: "Bash" })],
    ["档位/身份通知", wrap({ status: "unknown", title: "reviewer", model: "gpt-5.6", effort: "high" })],
    ["子智能体完成通知(带结果 + 终态)", wrap({ status: "completed", result: "子任务做完了" })],
    ["子智能体失败通知", wrap({ status: "failed", result: "子任务没做成" })],
  ] as [string, AgentEvent][]) {
    configure({ warnErrors: 2 });
    const { actions, log } = spy();
    const owner = {};
    trackTurnStall("s3d", owner, TURN, notice(), actions);
    trackTurnStall("s3d", owner, TURN, event, actions);
    trackTurnStall("s3d", owner, TURN, notice(), actions);
    assert.equal(log.warns.length, 1, `${label} 解除了停滞 —— 主线程仍然一个字都没拿到`);
    assert.equal(log.warns[0]!.facts.errors, 2, `${label} 把错误计数清零过`);
    assert.equal(log.warns[0]!.facts.lastProgressKind, null, `诊断把「卡在哪一步」说成了${label}`);
  }
  // 不许拦过头:子线程**自己产出**的那三类照样解除,工具调用与结果也照样解除。
  for (const [label, event] of [
    ["子线程正文", { kind: "tool", name: "Agent", nativeWork: { type: "activity", id: "c", event: { kind: "text", text: "说话了" } } }],
    ["子线程工具", { kind: "tool", name: "Agent", nativeWork: { type: "activity", id: "c", event: { kind: "tool", name: "Bash" } } }],
    ["工具调用", { kind: "tool", name: "Bash", nativeWork: { type: "call", id: "c", name: "Bash", input: {} } }],
    ["工具结果", { kind: "tool", name: "Bash", nativeWork: { type: "result", id: "c", result: "ok", failed: false } }],
  ] as [string, AgentEvent][]) {
    configure({ warnErrors: 2 });
    const { actions, log } = spy();
    const owner = {};
    trackTurnStall("s3d2", owner, TURN, notice(), actions);
    trackTurnStall("s3d2", owner, TURN, event, actions);
    trackTurnStall("s3d2", owner, TURN, notice(), actions);
    assert.equal(log.warns.length, 0, `${label}是真产出,它该解除停滞 —— ③d 拦过头了`);
  }
  // 包装里那条 `error` 不算产出(它正是停滞本身),而且要穿过包装计进子线程错误数。
  {
    configure({ warnErrors: 2 });
    const { actions, log } = spy();
    const owner = {};
    const childError = {
      kind: "tool", name: "Agent",
      nativeWork: { type: "activity", id: "c", event: { kind: "error", message: "Reconnecting…", level: "notice" } },
    } as AgentEvent;
    trackTurnStall("s3d3", owner, TURN, notice(), actions);
    trackTurnStall("s3d3", owner, TURN, childError, actions);
    assert.equal(log.warns.length, 1, "包装里那条错误没被算进来");
    assert.equal(log.warns[0]!.facts.childErrors, 1, "子线程错误数没穿过包装");
  }
}

// ── ③c 混着来:辅助通知夹在中间,真进展照样解除得掉 ─────────────────────────────
// ③b 不许拦过头 —— 真回话了就得解除,哪怕前面刚来过一条身份通知。
{
  configure({ warnErrors: 2 });
  const { actions, log } = spy();
  const owner = {};
  trackTurnStall("s3c", owner, TURN, notice(), actions);
  trackTurnStall("s3c", owner, TURN, { kind: "session", cliSessionId: "abc" } as AgentEvent, actions);
  trackTurnStall("s3c", owner, TURN, { kind: "text", text: "模型回话了" } as AgentEvent, actions);
  trackTurnStall("s3c", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 0, "真进展被前面那条辅助通知带累,解除不掉了");
  // 解除之后重新起算,而且这一次「卡在哪一步」记的是那条真进展。
  trackTurnStall("s3c", owner, TURN, notice(), actions);
  assert.equal(log.warns.length, 1, "重新起算之后凑够阈值没报警");
  assert.equal(log.warns[0]!.facts.errors, 2, "解除之后错误数没重新起算");
  assert.equal(log.warns[0]!.facts.lastProgressKind, "text", "「卡在哪一步」没记住那条真进展");
}

// ── ⑩ 子智能体的错误被包成 kind:"tool",**包装不算进展** ──────────────────────────
// 子线程(codex 子线程、claude 的 parent_tool_use_id 子回合)的每一条活动都被 childActivity()
// 包成 `{kind:"tool", name:"Agent", nativeWork:{type:"activity", event}}` —— 外层恒为 tool。
// 只看外层的那一版把子线程的重连风暴读成「有工具在动」:既开不了停滞,还会把父线程已经开着
// 的那一份当场解除,正好把看门狗关在最需要它的场合(第 1 轮审查第 1 条,已实测)。
{
  configure({ warnErrors: 3 });
  const { actions, log } = spy();
  const owner = {};
  const childRetry = childActivity("thread-1", { kind: "error", message: RETRY, level: "notice" });
  assert.equal(childRetry.kind, "tool", "夹具不对:子智能体活动的外层本来就该是 tool");
  for (let i = 0; i < 3; i += 1) trackTurnStall("s11", owner, TURN, childRetry, actions);
  assert.equal(log.warns.length, 1, "子线程的重连风暴一条都没被计入 —— 整条链上只有它在报错");
  const facts = log.warns[0]!.facts;
  assert.equal(facts.errors, 3);
  assert.equal(facts.retries, 3, "包装里的 level:\"notice\" 没读出来,重试被当成真故障");
  assert.equal(facts.childErrors, 3, "没记下这几条来自子线程 —— 诊断里分不清是谁卡住了");
  assert.match(log.warns[0]!.text, /子智能体线程/, "诊断没说清停滞来自子线程");

  // 另一半:子线程的错误**不许**解除父线程已经开着的停滞。
  configure({ warnErrors: 2 });
  const parent = spy();
  const owner2 = {};
  trackTurnStall("s12", owner2, TURN, notice(), parent.actions);
  trackTurnStall("s12", owner2, TURN, childRetry, parent.actions);
  assert.equal(parent.log.warns.length, 1, "子线程的错误把父线程的停滞当成进展解除掉了");

  // 反向闸:子线程**真的在干活**(正文/工具)照样解除 —— 它证明这条流还在动。
  configure({ warnErrors: 2 });
  const live = spy();
  const owner3 = {};
  trackTurnStall("s13", owner3, TURN, notice(), live.actions);
  trackTurnStall("s13", owner3, TURN, childActivity("thread-1", { kind: "tool", name: "exec" }), live.actions);
  trackTurnStall("s13", owner3, TURN, notice(), live.actions);
  assert.equal(live.log.warns.length, 0, "子线程在干活却被算成停滞 —— 误杀正在跑的回合");
}

__resetTurnStalls();
console.log("test:turn-stall-progress ok：只有上游真产出才解除停滞;辅助通知、状态投影、包装外层一律不算");

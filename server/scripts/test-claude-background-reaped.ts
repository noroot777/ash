// 「派了个后台子代理去查，结束回合等它回来」——2026-11-03 任务 Yx0fsyjeZC3X 的事故。
//
// 后台子代理 / 后台 Bash 寄生在智能体进程里，回合一结束随进程消失，完成通知只注回那条随之
// 结束的会话，从来唤不醒任务。这份回归钉两件配套的事：
//
// ① 事后：回合收尾时数出被收走的那些，在任务时间线上留一笔（claude-background-reaped.ts）。
//    口径照抬内置 Monitor 那句（第 4 轮审查 N1）：自己结束的、被智能体停掉的、被收走的分档说。
// ② 事前：每回合注入「跨回合的等待别交给内置后台」那一句，只发 claude 的执行回合；正文里
//    逐字讲过就不重发。体积与单源落款由 test-prompt-budget.ts 管，这里管判据与去重。
//
// 事件行序按事故 run 文件原样复刻（字段名、task_type、回执文案都是实测值）。
import { db, makeTask, now, sessions, teardown } from "./monitors-fixture.js";

const { ClaudeBackgroundTrace, backgroundReapedNotice } = await import("../src/claude-background-reaped.js");
const { BACKGROUND_WAIT_WARNING, backgroundWaitFor } = await import("../src/run-prompts.js");
const { assembleFreshPrompt, assembleTurnPrompt, NO_REMINDER } = await import("../src/turn-prompt.js");
const { bus } = await import("../src/bus.js");

type Trace = InstanceType<typeof ClaudeBackgroundTrace>;

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (ok) return;
  failures += 1;
  console.error(`✗ ${label}${detail ? ` —— ${detail}` : ""}`);
};

/** 像 claude-stream.ts 那样喂：先 `event()`，再逐块 `toolUse()`/`toolResult()`。 */
const call = (trace: Trace, name: string, id: string) => {
  trace.event({ type: "assistant", message: { content: [{ type: "tool_use", name, id }] } });
  trace.toolUse(name, id);
};
const returned = (trace: Trace, id: string) => {
  trace.event({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });
  trace.toolResult(id);
};
const started = (trace: Trace, taskId: string, toolUseId: string, taskType: string) =>
  trace.event({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, task_type: taskType });
const notified = (trace: Trace, taskId: string, status: string) =>
  trace.event({ type: "system", subtype: "task_notification", task_id: taskId, status });
const result = (trace: Trace) => trace.event({ type: "result", subtype: "success" });

async function main(): Promise<void> {
  // ── ① 事故原样：子代理派出去，调用返回，回合结束 ────────────────────────────
  const taskId = await makeTask();
  const cli = "15618fea-eb77-43a8-b1a7-bf7710c7a67d";
  await db.insert(sessions).values({
    id: "sess-bg", taskId, role: "single", agentType: "claude", executor: "claude@test",
    cliSessionId: cli, cwd: "/tmp/wt", startedAt: now(),
  });
  const texts: string[] = [];
  const asides: boolean[] = [];
  const stop = bus.subscribe((ev: any) => {
    if (ev.type !== "agent.event" || ev.taskId !== taskId) return;
    texts.push(String(ev.event?.text ?? ""));
    asides.push(ev.event?.aside === true);
  });

  const incident = new ClaudeBackgroundTrace(cli);
  // 同一轮里先有一条耗时稍长的**同步** Bash：它也发 task_started，但在自己的回执之前就完成了。
  call(incident, "Bash", "toolu_sync");
  started(incident, "b8r53bjnu", "toolu_sync", "local_bash");
  notified(incident, "b8r53bjnu", "completed");
  returned(incident, "toolu_sync");
  call(incident, "Agent", "toolu_01QSarwXH1Ri8QfhmutaEBGF");
  started(incident, "ac310c0a49443b5e0", "toolu_01QSarwXH1Ri8QfhmutaEBGF", "local_agent");
  returned(incident, "toolu_01QSarwXH1Ri8QfhmutaEBGF"); // "Async agent launched successfully…"
  result(incident);
  const tally = incident.tally();
  check(!tally.bash, "同步 Bash 不算后台（它没活过自己的调用）", JSON.stringify(tally));
  check(tally.agent?.total === 1 && tally.agent.reaped === 1, "子代理记成「回合结束时还在跑」", JSON.stringify(tally));
  await incident.finish();
  await new Promise((r) => setTimeout(r, 60));
  const notice = texts.find((t) => t.includes("后台子代理"));
  check(!!notice, "回合收尾在任务时间线上留了一笔", `收到 ${texts.length} 条`);
  check(!!notice?.includes("1 个后台子代理"), "说清起了几个", String(notice));
  check(!!notice?.includes("回合结束时还在跑"), "说清它们是怎么结束的", String(notice));
  check(!!notice?.includes("不会唤醒任务"), "答出「为什么没人被叫醒」", String(notice));
  check(!!notice?.includes("start_monitor") && !!notice?.includes("pause_task"), "指出跨回合该走哪条路", String(notice));
  check(asides.length > 0 && asides.every(Boolean), "这条说明是 aside：说给用户听，不塞进 agent 上下文");
  stop();

  // ── ② 分档：自己结束 / 被智能体停掉 / 被收走，三档不混 ─────────────────────
  const mixed = new ClaudeBackgroundTrace("mixed");
  for (const n of [1, 2, 3, 4]) {
    call(mixed, "Bash", `toolu_b${n}`);
    started(mixed, `bg${n}`, `toolu_b${n}`, "local_bash");
    returned(mixed, `toolu_b${n}`); // "Command running in background with ID: …"
  }
  notified(mixed, "bg1", "completed");
  notified(mixed, "bg2", "failed");
  call(mixed, "TaskStop", "toolu_stop");
  notified(mixed, "bg3", "stopped"); // 回合进行中：智能体自己停的
  returned(mixed, "toolu_stop");
  result(mixed);
  notified(mixed, "bg4", "stopped"); // `result` 之后：CLI 收台时一并收走
  const m = mixed.tally().bash;
  check(m?.total === 4 && m.finished === 2 && m.stopped === 1 && m.reaped === 1,
    "completed/failed 算自己结束，回合中 stopped 算智能体停掉，result 之后的 stopped 算收走", JSON.stringify(m));
  const mixedNotice = backgroundReapedNotice(mixed.tally());
  check(mixedNotice.includes("2 个自己结束了") && mixedNotice.includes("1 个被它自己停掉")
    && mixedNotice.includes("1 个回合结束时还在跑"), "时间线那句话分档说", mixedNotice);

  // ── ③ 全都在回合里正常结束 → 不打扰 ────────────────────────────────────────
  const healthy = new ClaudeBackgroundTrace("healthy");
  call(healthy, "Bash", "toolu_h");
  started(healthy, "bh", "toolu_h", "local_bash");
  returned(healthy, "toolu_h");
  notified(healthy, "bh", "completed");
  result(healthy);
  check(healthy.tally().bash?.finished === 1, "回合内跑完的后台 Bash 计入「自己结束」");
  check(backgroundReapedNotice(healthy.tally()) === "", "一个都没被收走就不写时间线");

  // ── ④ 内置 Monitor 起的 local_bash 归 claude-monitor-reaped.ts，这里不重复数 ──
  const mon = new ClaudeBackgroundTrace("monitor");
  call(mon, "Monitor", "toolu_m");
  started(mon, "bm", "toolu_m", "local_bash");
  returned(mon, "toolu_m");
  result(mon);
  check(Object.keys(mon.tally()).length === 0, "Monitor 起的后台任务不进这本账", JSON.stringify(mon.tally()));

  // ── ⑤ 常驻进程：后台任务跨回合活着，空档里 completed 是真跑完 ─────────────────
  const resident = new ClaudeBackgroundTrace("resident");
  call(resident, "Agent", "toolu_r");
  started(resident, "ar", "toolu_r", "local_agent");
  returned(resident, "toolu_r");
  result(resident);
  // 子代理自己的输出（带 parent_tool_use_id）不是「新的一回合开始了」。
  resident.event({ type: "assistant", parent_tool_use_id: "toolu_r", message: { content: [] } });
  notified(resident, "ar", "completed");
  check(resident.tally().agent?.finished === 1, "空档里报 completed 的子代理算自己结束", JSON.stringify(resident.tally()));
  const resident2 = new ClaudeBackgroundTrace("resident2");
  call(resident2, "Agent", "toolu_r2");
  started(resident2, "ar2", "toolu_r2", "local_agent");
  returned(resident2, "toolu_r2");
  result(resident2);
  resident2.event({ type: "assistant", parent_tool_use_id: "toolu_r2", message: { content: [] } });
  notified(resident2, "ar2", "stopped");
  check(resident2.tally().agent?.reaped === 1, "子代理自己的输出不把空档判成新回合（收台的 stopped 仍算收走）",
    JSON.stringify(resident2.tally()));

  // ── ⑥ 事前那一句：判据 + 去重 ─────────────────────────────────────────────
  check(backgroundWaitFor("claude", false) === BACKGROUND_WAIT_WARNING, "claude 的执行回合带警告句");
  check(backgroundWaitFor("claude", true) === "", "审查/验证回合不带");
  check(backgroundWaitFor("codex", false) === "", "codex 没有这两样内置后台，不带");
  const turnParts = {
    invite: "", brief: "", handoffNotice: "", peerNotice: "",
    craft: { freshContext: false, verifying: false }, workspaceReset: "",
    completion: "\n\n(完成协议)", backgroundWait: BACKGROUND_WAIT_WARNING,
    direction: "\n\n【当前方向身份】", reviewReminder: NO_REMINDER,
  };
  const count = (text: string) => text.split(BACKGROUND_WAIT_WARNING).length - 1;
  check(count(assembleTurnPrompt({ ...turnParts, userText: "继续。" })) === 1, "续聊/续跑尾部带一份");
  check(count(assembleTurnPrompt({ ...turnParts, userText: `继续。${BACKGROUND_WAIT_WARNING}` })) === 1,
    "正文里逐字讲过就不在尾部再拼第二份");
  const freshParts = {
    autonomy: "前言\n\n", craft: { freshContext: true, verifying: false }, backgroundWait: BACKGROUND_WAIT_WARNING,
    completion: "【完成协议】\n\n", direction: "", teamPreamble: "", reviewProtocol: "", handoffNotice: "", peerNotice: "",
  };
  check(count(assembleFreshPrompt({ ...freshParts, objective: "做一件事" })) === 1, "fresh 前言带一份");
  check(count(assembleFreshPrompt({ ...freshParts, objective: `做一件事。${BACKGROUND_WAIT_WARNING}` })) === 1,
    "任务正文里逐字讲过就不在前言再拼第二份");

  await teardown();
  if (failures) {
    console.error(`\n${failures} 条断言未通过`);
    process.exit(1);
  }
  console.log("✓ 后台子代理 / 后台 Bash：被收走时时间线留账且分档、同步与 Monitor 不混入、常驻空档不误判；事前警告只发 claude 执行回合且不重复");
}

await main();

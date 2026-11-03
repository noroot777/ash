// 「派了个后台子代理去查，结束回合等它回来」——2026-11-03 任务 Yx0fsyjeZC3X 的事故。
//
// 后台子代理 / 后台 Bash 寄生在智能体进程里，回合一结束随进程消失，完成通知只注回那条随之
// 结束的会话，从来唤不醒任务。这份回归钉两件配套的事：
//
// ① 事后：回合收尾时数出被收走的那些，在任务时间线上留一笔（claude-background-reaped.ts）。
//    口径照抬内置 Monitor 那句（第 4 轮审查 N1）：自己结束的、被智能体停掉的、被收走的分档说。
// ② 事前：每回合注入「跨回合的等待别交给内置后台」那一句，只发 claude（执行/审查/验证都发）；正文里
//    逐字讲过就不重发。体积与单源落款由 test-prompt-budget.ts 管，这里管判据与去重。
//
// 事件行序按事故 run 文件原样复刻（字段名、task_type、回执文案都是实测值）。
import { spawnSync } from "node:child_process";
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
const call = (trace: Trace, name: string, id: string, input: Record<string, unknown> = {}) => {
  trace.event({ type: "assistant", message: { content: [{ type: "tool_use", name, id, input }] } });
  trace.toolUse(name, id, input);
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
  call(mixed, "TaskStop", "toolu_stop", { task_id: "bg3" });
  notified(mixed, "bg3", "stopped"); // 有指名它的 TaskStop 为证：智能体自己停的
  returned(mixed, "toolu_stop");
  result(mixed);
  notified(mixed, "bg4", "stopped"); // `result` 之后：CLI 收台时一并收走
  const m = mixed.tally().bash;
  check(m?.total === 4 && m.finished === 2 && m.stopped === 1 && m.reaped === 1 && m.unknown === 0,
    "completed/failed 算自己结束，有 TaskStop 为证的算智能体停掉，result 之后无人请求的 stopped 算收走", JSON.stringify(m));
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

  // ── ②′ 停因只按证据归档：没证据就说不明，且照样记（第 1 轮审查 R1）──────────────
  const unclear = new ClaudeBackgroundTrace("unclear");
  call(unclear, "Agent", "toolu_u");
  started(unclear, "au", "toolu_u", "local_agent");
  returned(unclear, "toolu_u");
  notified(unclear, "au", "stopped"); // 回合进行中、没有任何 TaskStop
  result(unclear);
  const u = unclear.tally().agent;
  check(u?.unknown === 1 && u.stopped === 0, "没人请求过的中途停止不说成「它自己停掉」", JSON.stringify(u));
  const unclearNotice = backgroundReapedNotice(unclear.tally());
  check(unclearNotice.includes("原因不明"), "停因不明也写时间线，不静默丢掉", JSON.stringify(unclearNotice));
  check(!unclearNotice.includes("一并收走"), "没有被收走的就不说「已一并收走」", unclearNotice);

  const late = new ClaudeBackgroundTrace("late");
  call(late, "Bash", "toolu_l");
  started(late, "bl", "toolu_l", "local_bash");
  returned(late, "toolu_l");
  call(late, "KillShell", "toolu_kill", { shell_id: "bl" }); // 旧名工具、旧名字段
  returned(late, "toolu_kill");
  result(late);
  notified(late, "bl", "stopped"); // 停止请求在回合中，通知晚到 result 之后
  check(late.tally().bash?.stopped === 1, "回合中请求的停止、通知晚到，仍算智能体停掉而不是收走",
    JSON.stringify(late.tally()));

  const orphan = new ClaudeBackgroundTrace("orphan");
  call(orphan, "Agent", "toolu_o");
  started(orphan, "ao", "toolu_o", "local_agent");
  returned(orphan, "toolu_o");
  orphan.event({ type: "system", subtype: "task_notification", task_id: "ao", status: "stopped",
    summary: "Background agent \"查证\" didn't finish before the previous session ended" });
  check(orphan.tally().agent?.reaped === 1, "来源明说是会话结束收走的，算被收走", JSON.stringify(orphan.tally()));

  // ── ②″ 账本的身份与范围（第 1 轮审查 N1）─────────────────────────────────────
  const again = new ClaudeBackgroundTrace("again");
  call(again, "Agent", "toolu_a1");
  started(again, "aa", "toolu_a1", "local_agent");
  returned(again, "toolu_a1");
  notified(again, "aa", "completed");
  call(again, "SendMessage", "toolu_a2"); // 同一个子代理被续上，task_id 不变
  started(again, "aa", "toolu_a2", "local_agent");
  returned(again, "toolu_a2");
  result(again);
  const a = again.tally().agent;
  check(a?.total === 2 && a.finished === 1 && a.reaped === 1, "同一 task_id 再起一次，两条命各算各的", JSON.stringify(a));

  const turns = new ClaudeBackgroundTrace("turns");
  call(turns, "Bash", "toolu_t1");
  started(turns, "bt1", "toolu_t1", "local_bash");
  returned(turns, "toolu_t1");
  notified(turns, "bt1", "completed");
  result(turns);
  call(turns, "Bash", "toolu_t2"); // 常驻进程的下一回合
  started(turns, "bt2", "toolu_t2", "local_bash");
  returned(turns, "toolu_t2");
  result(turns);
  const t = turns.tally().bash;
  check(t?.total === 1 && t.reaped === 1, "常驻进程：上一回合已了结的不混进「本轮」", JSON.stringify(t));

  // ── ⑥ 事前那一句：判据 + 去重 ─────────────────────────────────────────────
  check(backgroundWaitFor("claude") === BACKGROUND_WAIT_WARNING, "claude 的回合（执行、审查、验证）都带警告句");
  check(backgroundWaitFor("codex") === "", "codex 没有这两样内置后台，不带");
  // 宽松模式（ASH_LAX_DONE）在模块求值时定，只能另起一个进程量：事实照说，只省掉 ash 的工具。
  const lax = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `const m = await import(${JSON.stringify(new URL("../src/run-prompts.ts", import.meta.url).href)});`
    + `process.stdout.write(m.backgroundWaitFor("claude"));`],
  { env: { ...process.env, ASH_LAX_DONE: "1" }, encoding: "utf8" });
  check(lax.status === 0 && lax.stdout.includes("唤不醒任务") && !lax.stdout.includes("start_monitor"),
    "宽松模式仍说「别交给内置后台」，只是不指 ash 的工具", `${lax.stdout}${lax.stderr.slice(-300)}`);
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
  console.log("✓ 后台子代理 / 后台 Bash：被收走时时间线留账且分档、同步与 Monitor 不混入、常驻空档不误判；事前警告只发 claude 且不重复");
}

await main();

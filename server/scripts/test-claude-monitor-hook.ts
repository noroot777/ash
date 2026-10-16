// Monitor 改道的回归：agent 调 claude 内置 `Monitor` 时，ash 到底替它做了什么。
//
// 钉住的立论（装配与理由见 src/claude-monitor-hook.ts 文件头）：
//
//  ① 一个都不放行。内置 Monitor 在 `-p` 回合里活不过这一轮，放行等于让它等一件不会来
//     的事 —— 所以连「代办失败」也必须是 deny，只是 reason 不同。
//  ② 能代办的就真代办：同一条命令变成一条真的 ash 哨兵，monitorId 回给 agent。
//  ③ 代办不了的要说清为什么、以及它自己该怎么挂（ws；没有回合身份；闸拒了）。
//  ④ 每一条 deny 都要把「这一轮该用 pause_task 收尾」说出口——这是整件事的落点：
//     哨兵挂上了而回合就这么结束的话，任务照样不会停在那儿等。
//  ⑤ 常驻会话不挂这个 hook（那种模式下 CLI 进程一直活着，内置 Monitor 真能唤醒自己）。
//  ⑥ **自用模式下也得认出是哪条任务的哪一轮**。这一条是实测抓出来的：那一档的 authGate
//     一行不拦、直接 set 成 SINGLE_ACTOR，`agentActor` 根本不走，只看 actor 的话 taskId
//     永远是 null —— 代办会在绝大多数实例上静默退化成「拦住了但没替你挂」。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { MONITOR_MAX_TIMEOUT_MS } from "@ash/shared/monitor";
import { db, inTurnCaller, monitors, tasks, stopMonitor, makeTask, teardown } from "./monitors-fixture.js";

const { Hono } = await import("hono");
const { claudeMonitorHookDecision, monitorRedirectHook } = await import("../src/claude-monitor-hook.js");
const { mountMonitorRoutes } = await import("../src/monitor-routes.js");

/** hook 发过来的那一份 PreToolUse 事件。只写我们读的那几个字段。 */
const event = (toolInput: Record<string, unknown>, toolName = "Monitor") => ({
  hook_event_name: "PreToolUse",
  tool_name: toolName,
  cwd: process.cwd(),
  tool_input: toolInput,
});

/**
 * hook 那一侧交上来的那一份:**回连凭据核验出来的那一轮**(路由里是 `agentActor` + 请求头
 * 里的令牌,见 monitor-routes.ts)。内置 Monitor 的 hook 一定发生在那条会话自己的回合里。
 */
const turnOf = async (taskId: string) => {
  const caller = await inTurnCaller(taskId);
  return caller.kind === "turn" ? caller : null;
};

const reasonOf = (decision: Awaited<ReturnType<typeof claudeMonitorHookDecision>>): string => {
  assert.ok(decision, "这一条应该给出决定，实际是「不表态」——不表态会放行");
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  return decision.hookSpecificOutput.permissionDecisionReason;
};

// ── ① 别的工具不碰 ───────────────────────────────────────────────────────────
// matcher 已经筛过一道，但配置被改宽时这里必须兜住:把 Bash 拦下来会把整个 agent 废掉。
{
  const taskId = await makeTask();
  const decision = await claudeMonitorHookDecision(event({ command: "npm test" }, "Bash"), await turnOf(taskId), null);
  assert.equal(decision, null, "不是 Monitor 调用就该不表态");
}

// ── ② 正常那条：真起一条哨兵，把 monitorId 和 pause_task 一起回给它 ──────────
{
  const taskId = await makeTask();
  const reason = reasonOf(await claudeMonitorHookDecision(
    event({ command: "sleep 30", description: "等全量 unittest 跑完" }),
    await turnOf(taskId),
    null,
  ));

  const rows = await db.select().from(monitors).where(eq(monitors.taskId, taskId));
  assert.equal(rows.length, 1, "应该替它起了一条真哨兵");
  const row = rows[0]!;
  assert.equal(row.kind, "ash", "代办出来的必须是 ash 自己起的那种——那才是能唤醒任务的");
  assert.equal(row.command, "sleep 30", "命令要原样转过去");
  assert.equal(row.description, "等全量 unittest 跑完");
  assert.equal(row.status, "running");

  assert.match(reason, new RegExp(`monitorId=${row.id}\\b`), `reason 里要带上 monitorId，实际：${reason}`);
  // 这一句是整件事的落点:哨兵挂上了而回合就这么结束的话,任务不会停在那儿等。
  assert.match(reason, /pause_task/, `reason 必须说「这一轮用 pause_task 收尾」，实际：${reason}`);
  await stopMonitor(row.id, "测试收尾");
}

// ── ③ description 空着时拿命令顶上 ───────────────────────────────────────────
// 起得来比「名字好看」要紧:描述是必填的(startMonitor 会校验),拿不到就用命令当描述,
// 而不是让这次代办整个失败、把 agent 推回那条落空的路。
{
  const taskId = await makeTask();
  reasonOf(await claudeMonitorHookDecision(event({ command: "sleep 31" }), await turnOf(taskId), null));
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0);
  assert.equal(row?.description, "sleep 31");
  if (row) await stopMonitor(row.id, "测试收尾");
}

// ── ④ ws 那种代办不了：拦住，并说清该怎么自己包 ──────────────────────────────
{
  const taskId = await makeTask();
  const reason = reasonOf(await claudeMonitorHookDecision(
    event({ ws: { url: "wss://example.com/stream" }, description: "等部署事件" }),
    await turnOf(taskId),
    null,
  ));
  assert.equal(
    (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length,
    0,
    "ws 那种不该凭空起一条哨兵",
  );
  assert.match(reason, /WebSocket/, `要说清 ash 哨兵接不了 ws，实际：${reason}`);
  assert.match(reason, /start_monitor/, `要告诉它自己该怎么挂，实际：${reason}`);
}

// ── ⑤ 没有回合身份：仍然拦，但只能让它自己挂 ─────────────────────────────────
// CLI 老到不支持 header 插值时就是这一条。**不放行**:放过去的监听照样活不过这一轮。
{
  const reason = reasonOf(await claudeMonitorHookDecision(event({ command: "sleep 32" }), null, null));
  assert.match(reason, /没有回合身份/, `要说清为什么没能代办，实际：${reason}`);
  assert.match(reason, /start_monitor/, `要告诉它自己该怎么挂，实际：${reason}`);
}

// ── ⑥ 闸拒了也要如实转达，而不是静默放行 ─────────────────────────────────────
// 终态任务上挂哨兵是没有意义的(它的输出不会唤醒任何人),创建闸因此一律拒。那条原因得
// 原样传给 agent:它读到「任务已经结束了」才会停下来,读到一句空话只会再试一次。
{
  const taskId = await makeTask({ status: "done" });
  const reason = reasonOf(await claudeMonitorHookDecision(event({ command: "sleep 33" }), await turnOf(taskId), null));
  assert.equal(
    (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).length,
    0,
    "闸拒了就不该有哨兵留下来",
  );
  assert.match(reason, /替你改挂成 ash 哨兵也没成/, `要说清代办失败，实际：${reason}`);
  assert.match(reason, /start_monitor/, `要告诉它自己该怎么挂，实际：${reason}`);
}

// ── ⑦ timeout 超界：钳住，而且要说出来 ───────────────────────────────────────
// 不说的话 agent 会按自己写的那个数去安排后面的事(「两小时后它会叫我」),而实际上一小时
// 就到期了 —— 那是同一类「承诺在说出口时就不成立」的错。
{
  const taskId = await makeTask();
  const reason = reasonOf(await claudeMonitorHookDecision(
    event({ command: "sleep 34", description: "盯很久", timeout_ms: MONITOR_MAX_TIMEOUT_MS * 3 }),
    await turnOf(taskId),
    null,
  ));
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0);
  assert.equal(row?.timeoutMs, MONITOR_MAX_TIMEOUT_MS, "超界要钳到上限");
  assert.match(reason, /钳到边界/, `钳过就要说出来，实际：${reason}`);
  if (row) await stopMonitor(row.id, "测试收尾");
}

// ── ⑧ 装配：一次性回合挂、常驻不挂 ───────────────────────────────────────────
{
  assert.deepEqual(monitorRedirectHook(true), {}, "常驻会话不挂这个 hook——那种模式下内置 Monitor 真能唤醒自己");

  const payload = monitorRedirectHook(false) as {
    hooks: { PreToolUse: { matcher: string; hooks: Record<string, unknown>[] }[] };
  };
  const group = payload.hooks.PreToolUse[0]!;
  assert.equal(group.matcher, "Monitor", "matcher 要精确匹配内置 Monitor 这一个工具");
  const handler = group.hooks[0]!;
  assert.equal(handler.type, "http");
  assert.match(String(handler.url), /^http:\/\/127\.0\.0\.1:\d+\/api\/hooks\/claude-monitor$/);
  // 回合身份靠 CLI 的 header 插值,token 因此不进 argv。`allowedEnvVars` 漏一个,那个
  // header 会被替换成空串 —— 代办会静默退化成「没有回合身份」那一档(⑤)。
  assert.deepEqual(handler.headers, {
    "x-ash-source-task-id": "$ASH_TASK_ID",
    "x-ash-turn-token": "$ASH_TURN_TOKEN",
  });
  assert.deepEqual(handler.allowedEnvVars, ["ASH_TASK_ID", "ASH_TURN_TOKEN"]);
}

// ── ⑨ 端点层：自用模式下也要认出回合身份 ─────────────────────────────────────
//
// 上面那些是拿着 taskId 直接调判断函数，钉不住「taskId 从哪儿来」。而真实故障恰恰发生
// 在那一步：自用模式的 authGate 直接给 SINGLE_ACTOR，端点要是只看 actor.kind==="agent"
// 就永远取不到任务。这一段打的是真端点，中间件照自用模式那一档装。
{
  const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");

  const api = new Hono();
  // 自用模式那一档逐字复刻：一行不拦，set 一个 SINGLE_ACTOR 就放行。
  api.use("*", async (c, next) => { setActor(c, SINGLE_ACTOR); await next(); });
  mountMonitorRoutes(api);
  const app = new Hono();
  app.route("/api", api);

  const post = (taskId: string, token: string, command: string) => app.request("/api/hooks/claude-monitor", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ash-source-task-id": taskId,
      "x-ash-turn-token": token,
    },
    body: JSON.stringify(event({ command, description: "自用模式也要认出身份" })),
  });

  const taskId = await makeTask();
  await db.update(tasks).set({ activeTurnToken: "TURN-OK" }).where(eq(tasks.id, taskId));

  const ok = await post(taskId, "TURN-OK", "sleep 36");
  // 非 2xx 会被 claude 当成 non-blocking error —— 那等于**放行**，正是这个 hook 要堵的。
  assert.equal(ok.status, 200, "这个端点任何情况下都必须回 200，否则 claude 会放行这次调用");
  const okReason = (await ok.json() as { hookSpecificOutput: { permissionDecisionReason: string } })
    .hookSpecificOutput.permissionDecisionReason;
  const row = (await db.select().from(monitors).where(eq(monitors.taskId, taskId))).at(0);
  assert.ok(row, "自用模式下也要真替它挂上哨兵");
  assert.match(okReason, new RegExp(`monitorId=${row.id}\\b`), `实际：${okReason}`);
  await stopMonitor(row.id, "测试收尾");

  // 反过来：token 对不上就不许代办。不然这个端点等于「谁报一个 taskId 就替谁挂」。
  const other = await makeTask();
  await db.update(tasks).set({ activeTurnToken: "TURN-OK" }).where(eq(tasks.id, other));
  const bad = await post(other, "TURN-WRONG", "sleep 37");
  assert.equal(bad.status, 200);
  const badReason = (await bad.json() as { hookSpecificOutput: { permissionDecisionReason: string } })
    .hookSpecificOutput.permissionDecisionReason;
  assert.equal(
    (await db.select().from(monitors).where(eq(monitors.taskId, other))).length,
    0,
    "token 对不上就不该替它挂",
  );
  assert.match(badReason, /没有回合身份/, `实际：${badReason}`);

  // ── ⑩ 内部出错时也**不许变成放行** ────────────────────────────────────────
  //
  // 这是第 1 轮审查 F3：异常曾被转成「没有决定」，而空对象在这个接口上的意思是不表态 ——
  // claude 于是走它自己的流程，把那个注定活不过这一轮的监听挂上去。两处异常面都要测：
  // 代办本体（startMonitor 查库）和**身份解析**（`agentActor` 也查库，它曾漏在 catch 外，
  // 一次故障就能让整个端点抛出去 → 非 2xx → 同样是放行）。
  const injected = await makeTask();
  await db.update(tasks).set({ activeTurnToken: "TURN-OK" }).where(eq(tasks.id, injected));
  const originalSelect = db.select;
  for (const stage of ["身份解析", "代办本体"] as const) {
    // 身份解析是这个端点的第一次查库，代办本体是之后那几次；用「第几次」把两处分开。
    let calls = 0;
    db.select = ((...args: unknown[]) => {
      calls += 1;
      if (stage === "身份解析" ? calls === 1 : calls > 1) throw new Error(`INJECTED_${stage}`);
      return (originalSelect as (...a: unknown[]) => unknown).apply(db, args);
    }) as typeof db.select;
    let response;
    try {
      response = await post(injected, "TURN-OK", "sleep 38");
    } finally {
      db.select = originalSelect;
    }
    assert.equal(response.status, 200, `${stage}出错时也必须回 200，非 2xx 等于放行`);
    const body = await response.json() as
      { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    assert.notDeepEqual(body, {}, `${stage}出错时回空对象 = 不表态 = 放行原生 Monitor（F3）`);
    assert.equal(body.hookSpecificOutput?.permissionDecision, "deny",
      `${stage}出错时也要明确拒掉原工具`);
    assert.match(body.hookSpecificOutput?.permissionDecisionReason ?? "", /start_monitor/,
      `${stage}出错时要告诉它怎么自己补上，否则它只知道「被拒了」`);
    assert.equal(
      (await db.select().from(monitors).where(eq(monitors.taskId, injected))).length, 0,
      `${stage}出错时不该留下半条哨兵`,
    );
  }

  // ── ⑪ 多人模式：**鉴权链**上的异常同样不许变成放行 ────────────────────────
  //
  // 第 2 轮审查 F3：路由回调里的 try 包不住 `authGate()` —— 它排在路由之前，多人模式下
  // 先去查 `agentActor` 的回合凭据，那一步也查库。抛异常时 Hono 默认回 HTTP 500，而非
  // 2xx 在 http hook 的契约里等于放行（实测证据：`{"status":500,"body":"Internal Server
  // Error"}`）。所以兜底得是一道**排在身份闸之前**的中间件。
  {
    const { authGate } = await import("../src/auth/middleware.js");
    const { guardMonitorHook } = await import("../src/monitor-hook-failsafe.js");
    const { MONITOR_HOOK_PATH } = await import("../src/claude-monitor-hook.js");
    const { writeSystemSetting } = await import("../src/app-settings.js");
    const { readFileSync } = await import("node:fs");

    // **生产装配点本身也要钉住**：这一段测的是「包起来之后对不对」，而包没包是另一件事
    // —— 漏了那一层，下面全绿而线上照旧 500→放行。顺序不必另测：包成装饰器之后只有一个
    // 注册点，「排错位置」那种形状根本写不出来（monitor-hook-failsafe.ts）。
    const indexSrc = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(indexSrc, /app\.use\("\*",\s*guardMonitorHook\(authGate\(\)\)\)/,
      "index.ts 必须用 guardMonitorHook 把身份闸包起来（F3）");

    const guarded = new Hono();
    guarded.use("*", guardMonitorHook(authGate()));
    const guardedApi = new Hono();
    mountMonitorRoutes(guardedApi);
    guarded.route("/api", guardedApi);

    const multiTask = await makeTask();
    await db.update(tasks).set({ activeTurnToken: "TURN-OK" }).where(eq(tasks.id, multiTask));
    await writeSystemSetting("instanceMode", "multi");
    try {
      const hit = (body: unknown) => guarded.request(MONITOR_HOOK_PATH, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ash-source-task-id": multiTask,
          "x-ash-turn-token": "TURN-OK",
        },
        body: JSON.stringify(body),
      });
      // 先预热模式缓存：authGate 第一个请求会查 app_settings，那一问不该被下面的注入打中。
      const warm = await hit(event({ command: "sleep 39", description: "预热" }));
      assert.equal(warm.status, 200, "多人模式下带着回合凭据的正常请求本来就该成功");
      for (const row of await db.select().from(monitors).where(eq(monitors.taskId, multiTask))) {
        await stopMonitor(row.id, "测试收尾");
      }
      // 停掉不等于删行（停了的行照旧留着给面板看），所以后面数的是**增量**。
      const baseline = (await db.select().from(monitors).where(eq(monitors.taskId, multiTask))).length;
      assert.equal(baseline, 1, "预热那一条真的挂上了，才说明这条链路本来是通的");

      // 精确注入：只让 `agentActor` 那一问（投影形状 {owner, turn}）失败。
      let armed = true;
      const before = db.select;
      db.select = ((fields?: Record<string, unknown>) => {
        if (armed && fields && "owner" in fields && "turn" in fields) {
          armed = false;
          throw new Error("INJECTED_AGENT_ACTOR_READ_FAIL");
        }
        return (before as (f?: unknown) => unknown).call(db, fields);
      }) as typeof db.select;
      let response;
      try {
        response = await hit(event({ command: "sleep 40", description: "鉴权链出错" }));
      } finally {
        db.select = before;
      }
      assert.equal(armed, false, "注入没命中就说明这条出路没被走到，断言会变成空测");
      assert.equal(response.status, 200,
        "鉴权链出错时也必须回 200：非 2xx 会被 CLI 当成 non-blocking error = 放行（F3）");
      const body = await response.json() as
        { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      assert.equal(body.hookSpecificOutput?.permissionDecision, "deny",
        "鉴权链出错时也要明确拒掉原生 Monitor（F3）");
      assert.match(body.hookSpecificOutput?.permissionDecisionReason ?? "", /start_monitor/,
        "并且告诉它怎么自己补上");
      assert.equal(
        (await db.select().from(monitors).where(eq(monitors.taskId, multiTask))).length, baseline,
        "兜底收口不代表替它挂上了：一条哨兵都不该多出来",
      );

      // 未登录（没有任何可用身份）→ 401 也要收口成 deny：**不放行、也不代办**。
      const anon = await guarded.request(MONITOR_HOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event({ command: "sleep 41", description: "没身份" })),
      });
      assert.equal(anon.status, 200, "401 在这条路径上同样等于放行，必须收口成决定");
      const anonBody = await anon.json() as
        { hookSpecificOutput?: { permissionDecision?: string } };
      assert.equal(anonBody.hookSpecificOutput?.permissionDecision, "deny",
        "没有身份时拒掉原工具是安全的那一边");
      assert.equal(
        (await db.select().from(monitors).where(eq(monitors.taskId, multiTask))).length, baseline,
        "更不许借兜底绕过鉴权替它挂哨兵（F3）",
      );

      // 不是 Monitor 的调用，兜底一个字都不说（它可能是别的工具，拦下来会把 agent 废掉）。
      const otherTool = await guarded.request(MONITOR_HOOK_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event({ command: "ls" }, "Bash")),
      });
      assert.equal(otherTool.status, 401, "非 Monitor 的请求照旧由鉴权链自己回答，兜底不插手");
    } finally {
      await writeSystemSetting("instanceMode", "single");
    }
  }

  // 不是 Monitor 的调用照旧不表态 —— 上面那条「出错也要 deny」不能把这一条带歪。
  const notMonitor = await app.request("/api/hooks/claude-monitor", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event({ command: "ls" }, "Bash")),
  });
  assert.deepEqual(await notMonitor.json(), {}, "别的工具一律不表态");
}

await teardown();
console.log("Monitor 改道：别的工具不碰 / 正常那条真起哨兵并要求 pause_task 收尾 / 描述空了拿命令顶上 / ws 拦住并指路 / 没身份也不放行 / 闸拒如实转达 / 超界钳住且说出来 / 一次性回合挂常驻不挂 / 自用模式也认得出回合身份且 token 不对不代办 / 身份解析与代办出错都明确拒绝而不是放行 / 多人模式鉴权链出错与未登录也收口成拒绝且不代办 均受回归保护");

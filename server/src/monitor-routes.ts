// 哨兵的 HTTP 面。真正的编排在 monitors.ts，这里只做入参校验和权限归属。
import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { MONITOR_MAX_TIMEOUT_MS, MONITOR_MIN_TIMEOUT_MS, MONITOR_WAKE_TARGETS } from "@ash/shared/monitor";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { agentActor } from "./auth/middleware.js";
import { startMonitor } from "./monitor-create.js";
import { getMonitor, listMonitors, readMonitorTail, stopMonitorChecked } from "./monitors.js";
import type { MonitorCaller } from "./monitor-session.js";
import {
  claudeMonitorHookDecision,
  isMonitorHookCall,
  monitorHookInternalError,
  type ClaudeMonitorHookInput,
} from "./claude-monitor-hook.js";
import { backfillClaudeMonitors } from "./claude-monitor-backfill.js";
import { monitorRecoveryOf } from "./claude-monitor-recovery.js";

/**
 * **这次创建请求是谁发起的** —— 核验在这里做,判归属在 `monitorSourceGate`(见那边的文件头)。
 *
 * 三种结论:
 *  · `turn` —— 回连凭据对上了**这个任务**当前这一轮(`agentActor` 同时校验 taskId 和 token),
 *    于是角色可以取运行时事实 `turnRole`,不必猜「哪个 agent 进程还活着」;
 *  · `unverified` —— 自报了回合身份却核验不过(令牌过期/对不上)。它既不是人、也不是任何
 *    一条会话,**不许退回默认**;
 *  · `external` —— 人在界面上点的,或另一个任务的 agent(团队调度台往执行者任务上挂)。它不是
 *    这个任务的会话,所以归属要么由 `wake` 说清,要么由那边的 ④⑤ 两条无歧义规则定。
 *
 * **自用模式下 actor 恒是 `SINGLE_ACTOR`**(authGate 一行不拦,`agentActor` 那条路根本不走),
 * 所以这里要自己再问一次 —— 跟 hook 端点同一个理由,判据仍只有 `agentActor` 那一份。
 */
async function callerOf(c: Context, taskId: string, wake?: string | null): Promise<MonitorCaller> {
  const actor = actorOf(c);
  const agent = actor.kind === "agent" ? actor : await agentActor(c);
  if (agent?.taskId === taskId) return { kind: "turn" };
  const claimed = !!(c.req.header("x-ash-source-task-id")?.trim() || c.req.header("x-ash-turn-token")?.trim());
  if (!agent && claimed) return { kind: "unverified" };
  return { kind: "external", wake };
}

export function mountMonitorRoutes(api: Hono): void {
  api.get("/tasks/:id/monitors", async (c) => {
    const taskId = c.req.param("id");
    // 先补历史再列：升级之前跑过的内置 Monitor 只存在于会话的 stdout 文件里，不补的话
    // 用户打开老任务仍是「这个任务上还没有哨兵」——而这正是整个功能的起点那一幕。
    // 按需、每进程每任务一次、幂等（见 claude-monitor-backfill.ts）。
    await backfillClaudeMonitors(taskId);
    return c.json(await listMonitors(taskId));
  });

  /**
   * 「这个任务还有没读完/没落地的监听事实吗」。
   *
   * **故意是单独一条**而不是并进上面那个列表：列表的响应形状是一个数组，改成对象会让**旧
   * 的 web/dist 配新 server** 那一刻整格面板崩掉（live 读的是主仓 dist，和 server 的重启
   * 节奏本来就不同步）。单独一条的话旧前端根本不会去问。
   *
   * **但两条必须反映同一轮扫描**，所以这里也要先 `await` 同一个回填。上一版这条是纯内存
   * 读：前端并行发两个请求，这一条可以在扫描记账**之前**就返回 `pending:false`，而列表
   * 随后因为读失败返回 `[]`——两份不同时刻的快照被当成一份完成结果，页面于是写着「这个
   * 任务上还没有哨兵」，而后台那一刻已经是 `pending:true / scan-failed`（第 7 轮审查用
   * 真实页面复现）。回填本身有 inflight 合流，两个请求共享同一次扫描，不会多读一遍盘。
   */
  api.get("/tasks/:id/monitors/recovery", async (c) => {
    const taskId = c.req.param("id");
    await backfillClaudeMonitors(taskId);
    return c.json(
      monitorRecoveryOf(taskId) ?? { pending: false, reasons: [], attempts: 0, exhausted: false },
    );
  });

  api.post("/tasks/:id/monitors", async (c) => {
    const taskId = c.req.param("id");
    type StartBody = { command?: string; description?: string; cwd?: string; timeoutMs?: number; wake?: string };
    const body = await c.req.json<StartBody>().catch((): StartBody => ({}));
    if (typeof body.command !== "string" || !body.command.trim())
      return c.json({ error: "command 不能为空" }, 400);
    // description/cwd 也要在这儿挡住：少了这一道，一个 description: 7 会一路走到 trim 那里
    // 才炸，而那时候进程已经起来了（startMonitor 里还有一道同样的校验兜底）。
    if (body.description !== undefined && typeof body.description !== "string")
      return c.json({ error: "description 必须是字符串" }, 400);
    if (body.cwd !== undefined && typeof body.cwd !== "string")
      return c.json({ error: "cwd 必须是字符串" }, 400);
    if (body.timeoutMs !== undefined && (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs)))
      return c.json({ error: "timeoutMs 必须是毫秒数" }, 400);
    // 唤醒目标认不出来时**当场 400**，不能静默当「没指定」：那会退回「说不清叫谁」那句
    // 409，用户看到的是一个点了没反应的选项，而真正的原因是值拼错了。
    if (body.wake !== undefined && !MONITOR_WAKE_TARGETS.includes(body.wake as never))
      return c.json({ error: `wake 只能是 ${MONITOR_WAKE_TARGETS.join(" / ")}` }, 400);
    // 越界不报错只钳住（normalizeMonitorTimeout），但得让调用方知道自己写的没生效。
    const clamped =
      body.timeoutMs !== undefined && (body.timeoutMs < MONITOR_MIN_TIMEOUT_MS || body.timeoutMs > MONITOR_MAX_TIMEOUT_MS);
    const result = await startMonitor({
      taskId,
      command: body.command,
      description: body.description,
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
      ownerUserId: ownerIdOf(actorOf(c)),
      caller: await callerOf(c, taskId, body.wake),
    });
    // 「说不清醒来叫谁」这一档要**原样带出去**：前端据它在表单上让人指定一个再提交。只回
    // 一句错误文案的话，手动挂哨兵在这种任务上就成了一条没有出路的死胡同。
    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.needsWakeTarget ? { needsWakeTarget: true } : {}) },
        result.status,
      );
    }
    return c.json({ monitor: result.monitor, ...(clamped ? { notice: "timeoutMs 超出允许区间，已钳到边界" } : {}) });
  });

  // 日志尾巴。面板按需拉取（点开那一张卡才问），所以不塞进列表响应里——几十个哨兵
  // 的尾巴一起走会让任务页每次刷新都背上几百 KB。
  api.get("/monitors/:monitorId/log", async (c) => {
    const lines = Number(c.req.query("lines"));
    const tail = await readMonitorTail(
      c.req.param("monitorId"),
      Number.isFinite(lines) && lines > 0 ? lines : undefined,
    );
    if (!tail) return c.json({ error: "哨兵不存在" }, 404);
    return c.json(tail);
  });

  /**
   * claude 的 PreToolUse hook 回调：agent 调内置 `Monitor` 时打到这儿（装配见
   * `claude-monitor-hook.ts`，那儿也写着为什么要拦）。
   *
   * **一律回 200**。http hook 的契约是「2xx + JSON 才算一个决定」：非 2xx 会被当成
   * non-blocking error，而那意味着**放行** —— 放过去的监听照样活不过这一轮，到点没人
   * 叫醒，正是这个 hook 要堵的那一幕。所以出了什么事都用 reason 说出来，别用状态码。
   *
   * 身份走 agent 那条既有的通道（`x-ash-source-task-id` + `x-ash-turn-token`，见
   * auth/middleware.ts）。认不出来时 actor 不是 agent，taskId 传 null：仍然拦，但只能
   * 让它自己去挂。
   */
  api.post("/hooks/claude-monitor", async (c) => {
    const input = await c.req.json<ClaudeMonitorHookInput>().catch((): ClaudeMonitorHookInput => ({}));
    // 不是 Monitor 就什么都不说（空对象 = 没有决定，claude 走它自己的流程）。这一问排在
    // 最前面，是为了让下面那个 catch 只负责「Monitor 代办失败」这一种事：两件事共用一个
    // `null` 的话，内部异常会借「不表态」那条路变成放行（第 1 轮审查 F3）。
    if (!isMonitorHookCall(input)) return c.json({});
    try {
      // **自用模式下 actor 恒是 SINGLE_ACTOR**：那一档的 authGate 一行不拦，`agentActor`
      // 这条路根本不走（auth/middleware.ts）。只看 actor 的话，「这次回调是哪条任务的哪
      // 一轮」在自用模式下永远答不出来——而自用模式正是绝大多数实例的样子，代办会整个
      // 失效、静默退化成「拦住了但没替你挂」。所以这里自己再问一次，判据复用那一份。
      //
      // **身份解析必须跟代办在同一个 try 里**：它也查库。漏在外面的话，一次身份查库故障
      // 会让整个端点抛出去 → 非 2xx → 被 CLI 当成 non-blocking error → 放行（同上）。
      const actor = actorOf(c);
      const agent = actor.kind === "agent" ? actor : await agentActor(c);
      const decision = await claudeMonitorHookDecision(input, agent?.taskId ?? null, ownerIdOf(agent ?? actor));
      // 上面那一问已经确认是 Monitor 了，所以这里一定有决定；真拿到 null 也当内部异常
      // 处理，绝不空手放行。
      return c.json(decision ?? monitorHookInternalError("没能得出处置结论"));
    } catch (error: unknown) {
      console.error("[ash] Monitor 改道 hook 出错", error);
      return c.json(monitorHookInternalError(error instanceof Error ? error.message : String(error)));
    }
  });

  api.post("/monitors/:monitorId/stop", async (c) => {
    const monitorId = c.req.param("monitorId");
    const body = await c.req.json<{ reason?: string }>().catch((): { reason?: string } => ({}));
    const existing = await getMonitor(monitorId);
    if (!existing) return c.json({ error: "哨兵不存在" }, 404);
    const task = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, existing.taskId))).at(0);
    if (!task) return c.json({ error: "哨兵所属任务已不存在" }, 404);
    // claude 内置 Monitor 的投影停不掉，原因要原样传出去——前端不给那种卡渲染停止按钮，
    // 这一道是给 API 直调和旧前端的（静默成功比报错坏得多：进程还在跑，界面却写着已停止）。
    const result = await stopMonitorChecked(monitorId, body.reason?.trim() || "被停掉了");
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ monitor: result.monitor });
  });
}

// `POST /tasks/:id/gate` —— duet 收敛闸口的人工裁决(放行 / 打回 / 注入意见 / 提问)。
//
// 从 task-run-routes.ts 整段搬出来:那个文件已经逼近 700 行,而闸口这一段有自己的一套
// 判断(版本号、重启补救、验收打回),和那边的运行/停止/重试不共用状态。
//
// 三条路,按顺序:
//   ① 内存里有门(讨论正在 runGate 里等):核版本后交给它;
//   ② 内存里没门、任务停在 duet 的 awaiting_review(server 重启丢了门):占回合锁后
//      `resumeAtGate` 从 transcript 重建状态再执行这次动作;
//   ③ 讨论已经收口(done/failed/canceled)而动作是注入/提问:验收打回,同一对讨论者回炉。
//
// `expectedVersion`(可选)= 点按钮的那一侧看到的门版本,理由见 gate-version.ts。不带就是
// 老客户端,三条路的行为与加版本之前一致。带了它:①对不上回 409 stale、门继续等;②在占锁
// **之前**比对 transcript 里最近一次开门,对不上回 409 stale(先占锁再比的话,stale 那条出路
// 就得自己还锁,漏一处就是一把永远不放的锁);③门已经关了,带版本的点击必然来自一张旧卡,
// 一律 409 stale —— 否则旧卡上的「注入」会把一场已经结束的讨论重新拉起来。
import type { GateAction } from "@ash/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { isAcceptingTask } from "../acceptance-lock.js";
import { actorOf, ownerIdOf } from "../auth/context.js";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { handoffBlockReason } from "../handoff-guard.js";
import { claimOwnTurn, releaseTurn } from "../runs.js";
import { lastOpenedGateVersion } from "./gate-version.js";
import { resolveGate } from "./gates.js";
import { resumeAtGate } from "./index.js";

/**
 * 请求体里的动作 → 一个形状确定的 GateAction;不合法返回错误文案。
 *
 * 为什么要校验:原来直接把 body 当 GateAction 用,`kind` 拼错会一路掉进 reDiscuss 按提问
 * 处理,空的注入会让两位讨论者对着一句空话再跑一轮。注入/提问的「说了什么」与
 * `gateUserMessage` 同一个口径:文字和附件至少有一样(只贴截图不打字也算数)。
 * 只往下传认得的字段,approve 上兼容老客户端的 text/side 服务端本来就不读。
 */
export function gateActionOf(raw: unknown): GateAction | string {
  if (!raw || typeof raw !== "object") return "请求体必须是一个闸口动作";
  const body = raw as { kind?: unknown; text?: unknown; target?: unknown; attachments?: unknown };
  if (body.kind === "approve") return { kind: "approve" };
  if (body.kind === "reject") return { kind: "reject" };
  if (body.kind !== "inject" && body.kind !== "ask") {
    return "闸口动作只能是 approve(放行)、reject(打回)、inject(注入意见)或 ask(提问)";
  }
  if (body.text !== undefined && typeof body.text !== "string") return "text 必须是字符串";
  const text = typeof body.text === "string" ? body.text : "";
  if (body.attachments !== undefined
    && (!Array.isArray(body.attachments) || body.attachments.some((path) => typeof path !== "string" || !path))) {
    return "attachments 必须是文件路径的数组";
  }
  const attachments = (body.attachments as string[] | undefined) ?? [];
  if (!text.trim() && !attachments.length) return "注入意见或提问不能是空的:写一句话,或者附上文件";
  const files = attachments.length ? { attachments } : {};
  if (body.kind === "inject") return { kind: "inject", text, ...files };
  if (body.target !== undefined && body.target !== "A" && body.target !== "B") {
    return "提问对象只能是 A、B,或者不填(问双方)";
  }
  return { kind: "ask", text, ...(body.target ? { target: body.target } : {}), ...files };
}

/** 缺省 = 不核版本;带了就必须是正整数(版本号从 1 开始)。 */
function expectedVersionOf(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

const STALE = "这扇闸口已经不是你看到的那一扇了（讨论已经往下走了，或已在别处处理），刷新后再看";

export function mountDuetGateRoutes(api: Hono): void {
  api.post("/tasks/:id/gate", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<unknown>().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "请求体不是合法的 JSON 对象" }, 400);
    const expectedVersion = expectedVersionOf((body as { expectedVersion?: unknown }).expectedVersion);
    if (expectedVersion === null) return c.json({ error: "expectedVersion 必须是正整数" }, 400);
    const action = gateActionOf(body);
    if (typeof action === "string") return c.json({ error: action }, 400);

    // ① 讨论正在等这扇门。
    const resolved = resolveGate(taskId, action, expectedVersion);
    if (resolved.ok) return c.json({ ok: true, gateVersion: resolved.version });
    if (resolved.reason === "stale") return c.json({ error: STALE, stale: true, gateVersion: resolved.current }, 409);

    // ② No in-memory gate (e.g. the server restarted). If the task is still awaiting
    // a decision, resume the duet from the gate and apply the action.
    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (t?.status === "awaiting_review" && t.mode === "duet") {
      // 重启后闸口重放会真的续跑讨论——接力出去的任务不给续(与 /run 同一条硬拦口径)。
      const blocked = handoffBlockReason(t.handoff);
      if (blocked) return c.json({ error: blocked, handoff: true }, 409);
      // 版本比对放在占锁之前:对不上就直接回,手里没有锁要还。
      if (expectedVersion !== undefined) {
        let current: number;
        try {
          current = lastOpenedGateVersion(taskId);
        } catch {
          return c.json({ error: "这一下没读到讨论记录，确认不了你点的是哪一扇门：请稍后再点" }, 503);
        }
        if (current !== expectedVersion) return c.json({ error: STALE, stale: true, gateVersion: current || null }, 409);
      }
      // 同 /run:先原子占位再启动,占不到说明确有回合在跑(闸口重放会真的续跑讨论)。
      const turn = claimOwnTurn(taskId, "duet");
      if (!turn) {
        return c.json({ error: "任务回合正在进行，稍后再处理裁决", status: t.status }, 409);
      }
      if (isAcceptingTask(taskId)) {
        releaseTurn(taskId, turn);
        return c.json({ error: "任务正在验收（含发布尾段），结束后再处理裁决", status: t.status }, 409);
      }
      void resumeAtGate(taskId, action, { turnHeld: turn, actingUserId: ownerIdOf(actorOf(c)) });
      return c.json({ ok: true, resumed: true, ...(expectedVersion !== undefined ? { gateVersion: expectedVersion } : {}) });
    }

    // 走到这里门已经关了:带版本的点击来自一张旧卡,不能让它掉进下面的验收打回(理由见文件头)。
    if (expectedVersion !== undefined) return c.json({ error: STALE, stale: true, gateVersion: null }, 409);

    // ③ 讨论已经收口后，验收打回仍沿用同一对讨论者和同一份 transcript 回炉；这不是
    // 新开一场讨论，所以复用 gate 的 inject 语义，但只接受会产生新一轮的动作。
    if (t?.mode === "duet" && ["done", "failed", "canceled"].includes(t.status)
      && (action.kind === "inject" || action.kind === "ask")) {
      if (t.stage === "accepted" || t.stage === "merged") {
        return c.json({ error: "讨论已经验收完成；如需继续，请先新开一轮讨论", stage: t.stage }, 409);
      }
      if (t.archived) return c.json({ error: "讨论已归档，先取消归档再继续", archived: true }, 409);
      const blocked = handoffBlockReason(t.handoff);
      if (blocked) return c.json({ error: blocked, handoff: true }, 409);
      const turn = claimOwnTurn(taskId, "duet");
      if (!turn) {
        return c.json({ error: "讨论回合正在进行，稍后再提交验收意见", status: t.status }, 409);
      }
      if (isAcceptingTask(taskId)) {
        releaseTurn(taskId, turn);
        return c.json({ error: "讨论正在验收，结束后再提交意见", status: t.status }, 409);
      }
      void resumeAtGate(taskId, action, { turnHeld: turn, actingUserId: ownerIdOf(actorOf(c)) });
      return c.json({ ok: true, resumed: true, revision: true }, 202);
    }
    return c.json({ error: "no open gate for this task" }, 409);
  });
}

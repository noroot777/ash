// 验收确认层「上次怎么勾的」那两勾的写入（为什么进库、谁不读它见 db/schema-accept-memory.ts）。
//
// 只有一条写：确认层里点了确认就送一次，送的就是那一刻层里看见的样子。读不单开端点 —— 「运行」那一勾
// 的记忆随门禁状态带出去（accept-gate-routes.ts），前提列那一行和确认层的默认读的是同一份。
//
//  · skipGate：记在「我」名下，只在这一按真的在「跑 / 跳过」之间做了选择时才送（有一次还作数的通过时
//    默认是沿用、勾上是一次性重跑，都不改记住的值 —— 由前端判断，送不送是它的事）。
//  · commit：「提交」那一勾**就是项目设置**（projects.accept_commit），不另存一份默认，不然确认层和
//    设置页会各说各的。所以它要项目管理权限：没有就不写、回执里说 commitSaved:false，这一次的
//    提交与否照样按层里看见的值发给 /accept（那条不读这里）。
//  · 两项都按到达顺序写：后到的确认算数，晚做完的旧确认盖不掉它（accept-order.ts）。
import type { Hono } from "hono";
import type { AcceptMemoryWriteResult } from "@ash/shared/accept-gate";
import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { arrivalSeq, writeAcceptCommit } from "./accept-order.js";
import { actorOf, authErrorResponse, ownerIdOf, type Actor } from "./auth/context.js";
import { projectRoleOf, requireProjectAccess } from "./auth/visibility.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { acceptMemory, projects, tasks } from "./db/schema.js";
import { now } from "./util.js";

/** 自用模式没有 userId，记在空串名下(主键里不能放 NULL)。 */
const ownerKeyOf = (actor: Actor): string => ownerIdOf(actor) ?? "";

/** 这个人在这个项目里上一次确认验收时取消了「运行」吗。没记过 = 没有（照常跑）。 */
export async function rememberedSkipGate(actor: Actor, projectId: string): Promise<boolean> {
  const row = (await db.select({ skipGate: acceptMemory.skipGate }).from(acceptMemory)
    .where(and(eq(acceptMemory.owner, ownerKeyOf(actor)), eq(acceptMemory.projectId, projectId)))).at(0);
  return row?.skipGate === true;
}

export function mountAcceptMemoryRoutes(api: Hono): void {
  api.put("/accept-memory/:projectId", async (c) => {
    // 一到就取号，后到的确认算数（accept-order.ts）。
    const seq = arrivalSeq();
    const pid = c.req.param("projectId");
    const actor = actorOf(c);
    const project = (await db.select().from(projects).where(eq(projects.id, pid))).at(0);
    if (!project) return c.json({ error: "not found" }, 404);
    try {
      await requireProjectAccess(actor, pid);
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { skipGate?: unknown; commit?: unknown }) : null;
    // 只认真正的布尔：含糊的真值在这儿就是替人改下一次的默认（commit 那一半还是项目设置）。
    if (!body || (body.skipGate !== undefined && typeof body.skipGate !== "boolean")
      || (body.commit !== undefined && typeof body.commit !== "boolean")) {
      return c.json({ error: "skipGate、commit 只能是布尔值" }, 400);
    }
    const owner = ownerKeyOf(actor);
    const commitSaved = typeof body.commit === "boolean" && (await projectRoleOf(actor, pid)) === "admin";
    // 两勾在同一笔事务里按号写：一次确认的两项要么都比库里新、各自落下，要么被更新的那次确认挡住，
    // 不会出现旧确认的一半插在新确认中间。回执报写完之后库里的样子（被挡住时就是那次更新的选择）。
    const { skipWritten, commitChanged, result } = await db.transaction(async (tx) => {
      let skipWritten = false;
      if (typeof body.skipGate === "boolean") {
        const skipGate = body.skipGate;
        const row = (await tx.select({ seq: acceptMemory.seq }).from(acceptMemory)
          .where(and(eq(acceptMemory.owner, owner), eq(acceptMemory.projectId, pid)))).at(0);
        if (!row || row.seq < seq) {
          await tx.insert(acceptMemory).values({ owner, projectId: pid, skipGate, seq, updatedAt: now() })
            .onConflictDoUpdate({ target: [acceptMemory.owner, acceptMemory.projectId], set: { skipGate, seq, updatedAt: now() } });
          skipWritten = true;
        }
      }
      const commitChanged = commitSaved ? (await writeAcceptCommit(tx, pid, body.commit === true, seq))?.changed === true : false;
      const skip = (await tx.select({ skipGate: acceptMemory.skipGate }).from(acceptMemory)
        .where(and(eq(acceptMemory.owner, owner), eq(acceptMemory.projectId, pid)))).at(0);
      const current = (await tx.select({ acceptCommit: projects.acceptCommit }).from(projects).where(eq(projects.id, pid))).at(0);
      const result: AcceptMemoryWriteResult = { skipGate: skip?.skipGate === true, commit: current?.acceptCommit !== false, commitSaved };
      return { skipWritten, commitChanged, result };
    });
    if (skipWritten) {
      // 门禁状态里带着这一份：这个项目下还没验收的任务各自重读（别的标签页、下一个任务立刻跟上）。
      const open = await db.select({ id: tasks.id }).from(tasks)
        .where(and(eq(tasks.projectId, pid), or(isNull(tasks.stage), notInArray(tasks.stage, ["accepted", "merged"]))));
      for (const task of open) bus.publish({ type: "task.acceptGate", taskId: task.id });
    }
    if (commitChanged) bus.publish({ type: "project.updated", projectId: pid });
    return c.json(result);
  });
}

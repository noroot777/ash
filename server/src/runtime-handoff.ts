import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import type { AgentType } from "@navi/shared";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { secretsEqual } from "./openai-converter/common.js";
import { liveLockToken } from "./singleton.js";
import { CODE_DIR, DATA_DIR } from "./paths.js";
import { INSTANCE_ID } from "./instance-binding.js";
import { db } from "./db/index.js";
import { agents, sessions, tasks } from "./db/schema.js";
import { heldTurns } from "./turn-lock.js";
import { restartImpact } from "./reattach.js";
import { resolveExecutorFor } from "./executors/index.js";
import { beginRuntimeDrain, endRuntimeDrain, onRuntimeDrainEnd, runtimeDraining, waitRuntimeRequests } from "./runtime-drain.js";
import { checkpointRuntimeConsumer } from "./runtime-consumers.js";

export function mountRuntimeHandoff(api: Hono): void {
  api.on(["POST", "DELETE"], "/runtime-handoff", async (context) => {
    const expected = liveLockToken();
    if (!expected || !secretsEqual(requestHeader(context, NAVI_HEADERS.hostToken) ?? "", expected)
      || requestHeader(context, NAVI_HEADERS.instance) !== INSTANCE_ID) {
      return context.json({ error: "运行时切换需要本机凭证及实例身份" }, 403);
    }
    if (context.req.method === "DELETE") {
      endRuntimeDrain();
      return context.json({ ok: true });
    }
    if (process.platform !== "darwin" || !existsSync(join(CODE_DIR, "runtime-manifest.json")) || !existsSync(join(DATA_DIR, ".runtimes"))
      || realpathSync(dirname(CODE_DIR.replace(/\/$/, ""))) !== realpathSync(join(DATA_DIR, ".runtimes"))) {
      return context.json({ error: "旧布局只能在空闲时首次迁移" }, 409);
    }
    if (runtimeDraining()) return context.json({ error: "已有运行时切换在进行" }, 409);
    beginRuntimeDrain();
    let prepared = false;
    try {
      const next = await context.req.json<{ protocol: number; schema: string }>();
      const envelope = JSON.parse(readFileSync(join(CODE_DIR, "runtime-manifest.json"), "utf8"));
      if (envelope.id !== basename(CODE_DIR.replace(/\/$/, ""))) throw new Error("运行时版本身份不符");
      const current = JSON.parse(envelope.payload);
      if (next.protocol !== 1 || current.protocol !== next.protocol) throw new Error("接管协议不兼容");
      if (!await waitRuntimeRequests()) throw new Error("仍有请求在执行，未停止服务");
      const impact = await restartImpact();
      if (impact.interrupted.length || impact.resumes.length) throw new Error("存在不可无损接管的任务，等待其结束后重试");
      if (impact.survives.length && current.schema !== next.schema) throw new Error("迁移兼容性不明，等待任务结束后再迁移");
      const surviving = new Set(impact.survives.map((task) => task.id));
      if (heldTurns().some((turn) => !surviving.has(turn.taskId))) throw new Error("仍有起跑或维护操作在途");
      for (const task of impact.survives) {
        const running = await db.select().from(sessions).where(and(eq(sessions.taskId, task.id),
          inArray(sessions.role, ["single", "reviewer"])));
        const live = running.filter((session) => !session.endedAt);
        if (live.length !== 1 || live[0].agentPid !== task.pid || !live[0].agentOutPath || !live[0].agentErrPath || !live[0].agentRcPath) {
          throw new Error("会话身份或输出接管信息不完整");
        }
        const session = live[0];
        const profile = (await db.select().from(agents).where(eq(agents.name, session.executor))).at(0);
        const record = (await db.select().from(tasks).where(eq(tasks.id, task.id))).at(0)!;
        const executor = await resolveExecutorFor({ executorId: profile?.id ?? record.executorId,
          type: session.agentType as AgentType, model: null, reasoningEffort: null });
        if (!executor.attach) throw new Error("执行器不支持接管");
        const checkpoint = checkpointRuntimeConsumer(session.id);
        onRuntimeDrainEnd(checkpoint.resume);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([checkpoint.ready, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("输出消费屏障未就绪，未切换服务")), 5_000);
          })]);
        } finally { clearTimeout(timer); }
      }
      const final = await restartImpact();
      if (!runtimeDraining() || final.interrupted.length || final.resumes.length
        || final.survives.some((task) => !surviving.has(task.id))
        || heldTurns().some((turn) => !final.survives.some((task) => task.id === turn.taskId))) {
        throw new Error("准备期间任务状态变化，未停止服务");
      }
      beginRuntimeDrain();
      prepared = true;
      return context.json({ ok: true, pid: process.pid, instance: INSTANCE_ID });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    } finally { if (!prepared) endRuntimeDrain(); }
  });
}

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Hono } from "hono";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { secretsEqual } from "./openai-converter/common.js";
import { liveLockToken } from "./singleton.js";
import { CODE_DIR, DATA_DIR } from "./paths.js";
import { INSTANCE_ID } from "./instance-binding.js";
import { heldTurns } from "./turn-lock.js";
import { restartImpact } from "./reattach.js";
import { beginRuntimeDrain, endRuntimeDrain, holdRuntimeDrain, onRuntimeDrainEnd, runtimeDraining, sealRuntimeChannels, waitRuntimeRequests } from "./runtime-drain.js";
import { pauseRuntimeGateway, resumeRuntimeGateway } from "./runtime-channel-gateway.js";
import { checkpointRuntimeConsumer } from "./runtime-consumers.js";

export function mountRuntimeHandoff(api: Hono): void {
  api.on(["POST", "DELETE"], "/runtime-handoff", async (context) => {
    const expected = liveLockToken();
    if (!expected || !secretsEqual(requestHeader(context, NAVI_HEADERS.hostToken) ?? "", expected)
      || requestHeader(context, NAVI_HEADERS.instance) !== INSTANCE_ID) {
      return context.json({ error: "运行时切换需要本机凭证及实例身份" }, 403);
    }
    if (context.req.method === "DELETE") {
      await resumeRuntimeGateway();
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
      await pauseRuntimeGateway();
      if (!await waitRuntimeRequests()) throw new Error("仍有请求在执行，未停止服务");
      const impact = await restartImpact();
      if (!impact.runtimeHandoff || impact.runtimeHandoff.blocked.length) {
        throw new Error(impact.runtimeHandoff?.blocked.map((item) => `${item.title}：${item.reason}`).join("；") || "服务未提供接管能力");
      }
      if (impact.survives.length && current.schema !== next.schema) throw new Error("迁移兼容性不明，等待任务结束后再迁移");
      sealRuntimeChannels();
      if (!await waitRuntimeRequests()) throw new Error("仍有通道请求在执行，未停止服务");
      const surviving = new Set(impact.survives.map((task) => task.id));
      if (heldTurns().some((turn) => !surviving.has(turn.taskId))) throw new Error("仍有起跑或维护操作在途");
      for (const session of impact.runtimeHandoff.sessions) {
        const checkpoint = checkpointRuntimeConsumer(session);
        onRuntimeDrainEnd(checkpoint.resume);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([checkpoint.ready, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("输出消费屏障未就绪，未切换服务")), 5_000);
          })]);
        } finally { clearTimeout(timer); }
      }
      const final = await restartImpact();
      if (!runtimeDraining() || !final.runtimeHandoff || final.runtimeHandoff.blocked.length
        || final.survives.some((task) => !surviving.has(task.id))
        || heldTurns().some((turn) => !final.survives.some((task) => task.id === turn.taskId))) {
        throw new Error("准备期间任务状态变化，未停止服务");
      }
      holdRuntimeDrain();
      prepared = true;
      return context.json({ ok: true, pid: process.pid, instance: INSTANCE_ID });
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    } finally { if (!prepared) endRuntimeDrain(); }
  });
}

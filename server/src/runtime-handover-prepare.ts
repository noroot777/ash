import type { RestartImpact } from "./reattach.js";
import { checkpointRuntimeConsumer } from "./runtime-consumers.js";
import { pauseRuntimeGateway, resumeRuntimeGateway } from "./runtime-channel-gateway.js";
import { afterRuntimeHandover, runtimeHandoverMatches } from "./runtime-handover-state.js";
import { waitRuntimeRequests } from "./runtime-handover-gate.js";

export async function sealRuntimeHandover(lease: string): Promise<void> {
  afterRuntimeHandover(() => { void resumeRuntimeGateway().catch((error) => console.error("[navi] channel resume failed", error)); });
  await pauseRuntimeGateway();
  if (!await waitRuntimeRequests() || !runtimeHandoverMatches(lease)) throw new Error("仍有请求或响应流在执行，旧服务未停止");
}

export async function checkpointRuntimeHandover(impact: RestartImpact, lease: string): Promise<void> {
  if (!impact.runtimeHandover || impact.runtimeHandover.blocked.length) {
    throw new Error(impact.runtimeHandover?.blocked.map((task) => `${task.title}：${task.reason}`).join("；") || "无法确认接管能力");
  }
  for (const session of impact.runtimeHandover.sessions) {
    const checkpoint = checkpointRuntimeConsumer(session);
    afterRuntimeHandover(checkpoint.resume);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([checkpoint.ready, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("输出消费屏障未就绪")), 5_000);
      })]);
    } finally { clearTimeout(timer); }
    if (!runtimeHandoverMatches(lease)) throw new Error("接管许可已撤销，旧服务未停止");
  }
}

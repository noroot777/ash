import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { supportsChat, type ChatMember } from "@ash/shared/chat";
import { resolveExecutorFor } from "../executors/index.js";
import { dispatchRejection, executorOwnerScope } from "../auth/dispatch-gate.js";
import { runEnvForOwner } from "../auth/run-env.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { db } from "../db/index.js";
import { agents } from "../db/schema.js";

export async function invokeChat(member: ChatMember, owner: string | null, prompt: string, signal: AbortSignal): Promise<string> {
  if (!supportsChat(member.agentType)) throw new Error("该智能体尚无可靠的无工具聊天通道，请选择 Claude 执行器。");
  const scope = await executorOwnerScope(owner);
  if (member.executorId) {
    const profile = (await db.select().from(agents).where(eq(agents.id, member.executorId))).at(0);
    if (!profile || profile.type !== member.agentType || (scope.owner !== undefined && profile.ownerUserId !== scope.owner)) {
      throw new Error("所选执行器已被删除或不再可用，请在群成员配置中重新选择。");
    }
  }
  const rejection = await dispatchRejection({ agentType: member.agentType, executorId: member.executorId, ...scope });
  if (rejection) throw new Error(rejection);
  const executor = await resolveExecutorFor({ type: member.agentType, executorId: member.executorId, model: member.model, reasoningEffort: member.reasoningEffort, ...scope });
  if (!executor.runChat) throw new Error("执行器不支持无工具聊天，未启动进程。");
  const env = await runEnvForOwner(owner, executor.type);
  signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), "ash-chat-"));
  let handle: ReturnType<typeof executor.run> | undefined;
  const abort = () => handle?.kill();
  try {
    signal.throwIfAborted();
    handle = executor.runChat({
      cwd,
      prompt: withGlobalBrowserPolicy(prompt, "full"),
      env: { ...env, ASH_TASK_ID: undefined, ASH_TURN_TOKEN: undefined, ASH_DIRECTION_TOKEN: undefined },
    });
    signal.addEventListener("abort", abort, { once: true });
    process.once("exit", abort);
    let text = "";
    let exitStatus: number | undefined;
    for await (const event of handle.events) {
      signal.throwIfAborted();
      if (event.kind === "text") text += event.text;
      if (text.length > 32000) throw new Error("聊天回复过长，已中止。请把复杂工作交给任务。");
      if (event.kind === "error" && event.level !== "notice") throw new Error(event.message);
      if (event.kind === "tool") throw new Error("聊天回合尝试调用工具，已中止；执行工作应通过任务卡进行。");
      if (event.kind === "done") exitStatus = event.exitStatus;
    }
    if (exitStatus !== 0) throw new Error(`智能体未正常结束（${exitStatus ?? "无退出状态"}），请重新 @ 重试。`);
    return text;
  } finally {
    signal.removeEventListener("abort", abort);
    process.removeListener("exit", abort);
    handle?.kill();
    await handle?.cleanup?.();
    await rm(cwd, { recursive: true, force: true });
  }
}

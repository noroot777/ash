import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ChatMember } from "@ash/shared/chat";
import { resolveExecutorFor } from "../executors/index.js";
import { dispatchRejection, executorOwnerScope } from "../auth/dispatch-gate.js";
import { runEnvForOwner } from "../auth/run-env.js";
import { canSeeProject } from "../auth/visibility.js";
import { ANONYMOUS_ACTOR, SINGLE_ACTOR, type Actor } from "../auth/context.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { db } from "../db/index.js";
import { agents, projects, users } from "../db/schema.js";

export async function invokeChat(member: ChatMember, owner: string | null, prompt: string, signal: AbortSignal, projectId: string): Promise<string> {
  signal.throwIfAborted();
  const scope = await executorOwnerScope(owner);
  const project = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  const user = owner ? (await db.select().from(users).where(eq(users.id, owner))).at(0) : undefined;
  const actor: Actor = scope.owner === undefined ? SINGLE_ACTOR : user
    ? { kind: "user", userId: user.id, role: user.role as Actor["role"], name: user.name }
    : ANONYMOUS_ACTOR;
  if (!project || !await canSeeProject(actor, projectId)) throw new Error("群聊项目不存在或你已失去访问权限。");
  if (member.executorId) {
    const profile = (await db.select().from(agents).where(eq(agents.id, member.executorId))).at(0);
    if (!profile || profile.type !== member.agentType || (scope.owner !== undefined && profile.ownerUserId !== scope.owner)) {
      throw new Error("所选执行器已被删除或不再可用，请在群成员配置中重新选择。");
    }
  }
  const rejection = await dispatchRejection({ agentType: member.agentType, executorId: member.executorId, ...scope });
  if (rejection) throw new Error(rejection);
  const executor = await resolveExecutorFor({ type: member.agentType, executorId: member.executorId, model: member.model, reasoningEffort: member.reasoningEffort, ...scope });
  const env = await runEnvForOwner(owner, executor.type);
  signal.throwIfAborted();
  const temporary = !project.repoPath.trim();
  const cwd = temporary ? await mkdtemp(join(tmpdir(), "ash-chat-")) : project.repoPath;
  let handle: ReturnType<typeof executor.run> | undefined;
  const abort = () => handle?.kill();
  try {
    signal.throwIfAborted();
    handle = executor.run({
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
      if (event.kind === "done") exitStatus = event.exitStatus;
    }
    if (exitStatus !== 0) throw new Error(`智能体未正常结束（${exitStatus ?? "无退出状态"}），请重新 @ 重试。`);
    return text;
  } finally {
    signal.removeEventListener("abort", abort);
    process.removeListener("exit", abort);
    handle?.kill();
    await handle?.cleanup?.();
    if (temporary) await rm(cwd, { recursive: true, force: true });
  }
}

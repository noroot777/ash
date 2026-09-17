import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ChatMember, ChatTraceEvent } from "@ash/shared/chat";
import { isVisibleExecutionEvent } from "@ash/shared/native-work";
import { expandHome } from "../git.js";
import { resolveExecutorFor } from "../executors/index.js";
import { dispatchRejection, executorOwnerScope } from "../auth/dispatch-gate.js";
import { runEnvForOwner } from "../auth/run-env.js";
import { canSeeProject } from "../auth/visibility.js";
import { ANONYMOUS_ACTOR, SINGLE_ACTOR, type Actor } from "../auth/context.js";
import { withGlobalBrowserPolicy } from "../browser-verification-policy.js";
import { db } from "../db/index.js";
import { agents, projects, users, tasks } from "../db/schema.js";
import { taskFileRoot } from "../file-browser.js";
import { ChatBoundaryError, readOnlyChatTool, watchChatWorkspace, type ChatWorkspaceObserver } from "./boundary.js";

export interface ChatInvocation {
  text: string;
  /** 咨询期间观察到项目目录并发变更时的附注；无法归因，只随回复展示，不进模型上下文。 */
  notice?: string;
  /** 侧聊在「已有正文、但这一轮没能干净收尾」时的说明（超长截断、中途报错、非零退出）。 */
  degraded?: string;
}

/** 执行过程的去处：调用方给一个接收器，invoke 按事件发生顺序逐步回调。 */
type ChatTraceSink = { onTrace?: (event: ChatTraceEvent) => void };

/**
 * 这次调用是**给谁跑的**。缺省（不带 purpose）就是群聊里被 @ 的那次回复。
 * purpose 与它的附属字段是一组的（side 必须带 taskId），所以写成可判别联合而不是
 * 一堆可选字段——写错组合直接编译不过。
 */
export type ChatInvokeOptions =
  | (ChatTraceSink & { purpose?: undefined })
  | (ChatTraceSink & { purpose: "summary" | "assistant" | "side-authorization" })
  | (ChatTraceSink & { purpose: "side"; taskId: string });

export class AssistantToolError extends Error {
  constructor(tool: string) {
    super(`助手调用了未开放的工具（${JSON.stringify(tool.slice(0, 80))}）。查询和配置由 ash 内置能力处理；请重新发送消息重试。`);
    this.name = "AssistantToolError";
  }
}

function changeNotice({ paths, more, degraded }: { paths: string[]; more: boolean; degraded?: string }): string | undefined {
  if (!paths.length && !degraded) return undefined;
  // 观察器自身失效时，「没有路径」不等于「没有变化」——必须把失效本身如实附注。
  if (!paths.length) return `⚠️ 本轮${degraded}，无法确认咨询期间项目目录是否有并发变更；写入类工具调用仍会被检查并中止。如有疑虑请检查项目。`;
  const shown = paths.slice(0, 3).join("、");
  const suffix = more ? " 等多处" : paths.length > 3 ? ` 等 ${paths.length} 处` : "";
  const tail = degraded ? `另外，${degraded}，其间的变更可能未被完整记录。` : "";
  return `⚠️ 咨询期间项目目录出现并发变更（${shown}${suffix}）。变更无法归因：可能来自其他任务、验收合并、你自己的操作，也可能是本次咨询越过了只读约定。群聊未代为撤销；如非预期请检查项目。${tail}`;
}

export async function invokeChat(member: ChatMember, owner: string | null, prompt: string, signal: AbortSignal, projectId: string, options?: ChatInvokeOptions): Promise<ChatInvocation> {
  signal.throwIfAborted();
  const purpose = options?.purpose;
  const onTrace = options?.onTrace;
  const scope = await executorOwnerScope(owner);
  const project = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  const user = owner ? (await db.select().from(users).where(eq(users.id, owner))).at(0) : undefined;
  const actor: Actor = scope.owner === undefined ? SINGLE_ACTOR : user
    ? { kind: "user", userId: user.id, role: user.role as Actor["role"], name: user.name }
    : ANONYMOUS_ACTOR;
  if ((!project || !await canSeeProject(actor, projectId)) && !(purpose !== undefined && !projectId && actor.kind !== "anonymous")) throw new Error("聊天项目不存在或你已失去访问权限。");
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
  let sideCwd: string | undefined;
  if (options?.purpose === "side") {
    const parent = (await db.select().from(tasks).where(eq(tasks.id, options.taskId))).at(0);
    if (!parent || parent.projectId !== projectId) throw new Error("侧聊的主任务已不可访问。");
    sideCwd = (await taskFileRoot(parent.id))?.path;
  }
  const temporary = (purpose !== undefined && purpose !== "side") || (!sideCwd && !project?.repoPath.trim());
  // repoPath 按用户写的原样存（`~/code/x` 保持可读、可搬机器），所以每个消费点都得自己
  // 展开——少这一步，watchChatWorkspace 的 realpath 会直接 ENOENT，被 @ 的成员一个不剩
  // 全报同一条错，而且错在 CLI 起来之前，看着像「智能体坏了」。
  const cwd = temporary ? await mkdtemp(join(tmpdir(), "ash-chat-")) : sideCwd ?? expandHome(project!.repoPath);
  if (!temporary && !await stat(cwd).then((entry) => entry.isDirectory()).catch(() => false)) {
    throw new Error(`群聊项目的工作目录不存在：${project!.repoPath}。请在项目设置里改成这台机器上真实存在的目录，再重新 @。`);
  }
  let handle: ReturnType<typeof executor.run> | undefined;
  let guard: ChatWorkspaceObserver | undefined;
  const abort = () => handle?.kill();
  try {
    // 观察者只记录变更、不中止（原因见 boundary.ts 顶部）；可归因的只读约束由下面
    // consume 里的工具事件闸门执行。临时目录一次一清，没有可观察的项目。
    if (!temporary && purpose !== "side") guard = await watchChatWorkspace(cwd);
    signal.throwIfAborted();
    handle = executor.run({
      cwd,
      prompt: withGlobalBrowserPolicy(prompt, "full"),
      extraArgs: (purpose === "assistant" || purpose === "side-authorization") && executor.type === "claude"
        ? ["--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome"] : undefined,
      env: { ...env, ASH_TASK_ID: undefined, ASH_TURN_TOKEN: undefined, ASH_DIRECTION_TOKEN: undefined },
    });
    signal.addEventListener("abort", abort, { once: true });
    process.once("exit", abort);
    const consume = async () => {
      let text = "";
      let exitStatus: number | undefined;
      let degraded: string | undefined;
      // 侧聊按主会话的标准收尾：**已经拿到的正文一律不丢**。它跑在主任务的工作目录里，一轮
      // 往往是十几次工具调用换来的调研结论，而下面这三种情况（输出超长、中途报错、非零退出）
      // 都发生在正文已经产出之后——抛错等于把结论连同十几次工具调用一起扔掉，用户只剩一句
      // 「请重试」。所以有正文就返回正文，把发生了什么写进 degraded 随正文展示；确实一个字
      // 都没拿到时才照旧抛错（那时没有任何可展示的东西，报错反而是唯一有信息量的结果）。
      // 群聊/助手/摘要/核验不走这条：群聊回复限 300 字、摘要要么整份可用要么作废、核验是
      // 安全判定，半截结果对它们没有意义。
      const lenient = purpose === "side";
      const limit = lenient ? 200000 : 32000;
      for await (const event of handle!.events) {
        // 执行过程按发生顺序记一行，位置在各道闸**之前**：被闸拦下的那一步也要留在记录里，
        // 否则用户只看到「回复被中止」，看不出是撞在哪一步上。子智能体的内部事件不记
        // （isVisibleExecutionEvent），跟主会话同一把尺子。
        if (event.kind === "tool" && isVisibleExecutionEvent(event)) onTrace?.({ kind: "tool", label: event.name, detail: event.detail });
        else if (event.kind === "thinking") onTrace?.({ kind: "thinking", label: "思考过程", detail: event.text });
        else if (event.kind === "error" && event.level !== "notice") onTrace?.({ kind: "error", label: event.message });
        if (event.kind === "tool" && purpose === "side-authorization") throw new ChatBoundaryError("回传授权核验调用使用了工具，核验未采用");
        if (event.kind === "tool" && purpose === "summary") throw new ChatBoundaryError("后台摘要调用使用了工具，摘要未采用");
        if (event.kind === "tool" && purpose === "assistant") throw new AssistantToolError(event.name);
        // 侧聊不走只读闸门（用户 2026-09-15 指定）：它跑在主任务自己的工作目录里，用户在侧栏
        // 让它「去核查一下」时就是要它跑命令、必要时动手改。闸门的分类器只认白名单里的裸命令，
        // 一个 `git log --oneline | head` 就被判成「无法确认只读」，把整次咨询连回复一起中止。
        // 群聊/助手/摘要仍受闸门约束——那些跑在项目主仓或临时目录里，和任务无绑定关系。
        // 任务结算类写入不靠这条闸门挡：侧聊的 env 不带 ASH_TURN_TOKEN，complete_task 一类
        // MCP 写入在服务端就会被拒。
        if (event.kind === "tool" && purpose !== "side" && !readOnlyChatTool(event)) throw new ChatBoundaryError(`检测到写入或无法确认只读的工具（${JSON.stringify(event.name.slice(0, 80))}）`);
        signal.throwIfAborted();
        if (event.kind === "text") text += event.text;
        if (text.length > limit) {
          if (!lenient) throw new Error("聊天回复过长，已中止。请把复杂工作交给任务。");
          // 到顶就地收工：截断后跳出，finally 里的 kill 停掉进程。继续接收只会让它一直写下去，
          // 而超出上限的部分本来也不会展示。
          text = text.slice(0, limit);
          degraded = `⚠️ 输出超过 ${limit} 字，已截断，后面的内容没有保留。`;
          break;
        }
        if (event.kind === "error" && event.level !== "notice") {
          if (!lenient || !text.trim()) throw new Error(event.message);
          degraded = `⚠️ 智能体中途报错：${event.message.slice(0, 200)}。上面是报错前已经产出的内容。`;
          break;
        }
        if (event.kind === "done") exitStatus = event.exitStatus;
      }
      if (exitStatus !== 0 && !degraded) {
        const reason = `智能体未正常结束（${exitStatus ?? "无退出状态"}），请重新 @ 重试。`;
        if (!lenient || !text.trim()) throw new Error(reason);
        degraded = `⚠️ 智能体未正常结束（${exitStatus ?? "无退出状态"}）。上面是它退出前已经产出的内容。`;
      }
      return { text, degraded };
    };
    const { text, degraded } = await consume();
    return { text, degraded, notice: guard ? changeNotice(await guard.settle()) : undefined };
  } finally {
    signal.removeEventListener("abort", abort);
    process.removeListener("exit", abort);
    try {
      handle?.kill();
      await handle?.cleanup?.();
    } finally {
      guard?.close();
      if (temporary) await rm(cwd, { recursive: true, force: true });
    }
  }
}

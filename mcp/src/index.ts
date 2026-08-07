#!/usr/bin/env node
// Harness MCP server — a THIN adapter that exposes the harness HTTP API as MCP
// tools so an LLM agent (Claude Code / Desktop / Cursor / a spawned `claude`)
// can orchestrate tasks natively. It holds no logic of its own: every tool just
// calls an existing endpoint on the harness server (default http://localhost:4317,
// override with HARNESS_URL). The Hono server stays the single source of truth.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AGENT_TYPES, MAX_QUESTION_ITEMS, MAX_QUESTION_OPTIONS, MAX_QUESTION_OPTION_LEN, STAGE_ORDER } from "@harness/shared";
import { UNDELIVERED_NET_CODES } from "@harness/shared/mcp-delivery";

const BASE = (process.env.HARNESS_URL ?? "http://localhost:4317").replace(/\/+$/, "");

// 本机流量一律不走代理。Node 24+ 在 NODE_USE_ENV_PROXY=1(或显式 HTTP_PROXY)下
// **连 localhost 也走代理** —— 实测本机 http_proxy=127.0.0.1:7897 时,打给
// harness 的每一次工具调用都先绕到代理再回来。两个后果:①白白多一跳、还把
// harness 的存活绑在代理上;②server 重启时拿到的是代理给的 UND_ERR_SOCKET
// (「对端关闭」)而不是 ECONNREFUSED,下面那个「确定没送达才重试」的判断就永远
// 命中不了。合并而不是覆盖已有的 NO_PROXY,别把用户自己的配置吃掉。
// 必须在第一次 fetch 之前执行 —— 放模块顶层即可(工具调用都在之后)。
{
  const loopback = ["localhost", "127.0.0.1", "::1"];
  const existing = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...existing, ...loopback])].join(",");
  process.env.NO_PROXY = merged;
  process.env.no_proxy = merged;
}

// 重启窗口的等待上限。scripts/restart.sh 是「杀掉 → 等端口释放 → 起新进程 →
// 轮询 /api/health」,正常几秒内回来;给到 60s 是留足构建慢、机器忙的余量。
const RECONNECT_WINDOW_MS = Number(process.env.HARNESS_RECONNECT_MS ?? 60_000);

// 只对「明确没送达」的连接错误重试。ECONNREFUSED = 根本没人在监听那个端口
// (server 重启期间的确切表现),请求一个字节都没发出去,重试绝不会重复执行。
// 刻意**不**含 UND_ERR_SOCKET / ECONNRESET:那些是「连上了又断」,可能已经送达,
// 重试就会把 dispatch 这类非幂等操作做两遍。
//
// 码表来自 shared,跟 server 那边「回合结算时补捞漏掉的交卷」是同一份口径
// (`shared/src/mcp-delivery.ts`)。注意那边另有一份**更宽**的判据
// (`isUndeliveredMcpFailure`,连 ECONNRESET 都算没送达)——那份只在幂等白名单
// 的保护下才成立,**不能搬到这里**:这里对所有工具一视同仁。
//
// 形状实测(Node 26):`http://localhost:<关闭端口>` 抛 AggregateError,code 挂在
// AggregateError 自己身上、errors 里是 IPv4/IPv6 各一条;`http://127.0.0.1:…`
// 抛普通 Error。两种都要认。
function retryableCode(e: unknown): string | null {
  const cause = (e as { cause?: unknown })?.cause;
  const code = (cause as { code?: string })?.code;
  if (code && UNDELIVERED_NET_CODES.has(code)) return code;
  const inner = (cause as { errors?: Array<{ code?: string }> })?.errors;
  const first = inner?.find((x) => x?.code && UNDELIVERED_NET_CODES.has(x.code));
  return first?.code ?? null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One place to talk to the API. Network failures get a human hint; HTTP errors
// surface the server's JSON error body verbatim so the agent can react.
//
// 连不上时会**退避重试**到 RECONNECT_WINDOW_MS 为止,而不是当场抛错。理由:
// agent 进程现在能活过 server 重启(输出走文件不走管道),但它汇报成果的
// `complete_task` 走 HTTP —— 正好撞上重启那几秒就会硬失败,于是「进程活下来了、
// 成果却丢了」。重试把这个窗口抹平。只重试确定没送达的错误,所以 dispatch 这种
// 非幂等调用也不会被做两遍。
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const deadline = Date.now() + RECONNECT_WINDOW_MS;
  let delay = 400;
  let lastCode = "";
  let res: Response;
  for (;;) {
    try {
      res = await fetch(`${BASE}/api${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      break;
    } catch (e) {
      const code = retryableCode(e);
      if (!code || Date.now() >= deadline) {
        const waited = lastCode ? `（已重试 ${Math.round(RECONNECT_WINDOW_MS / 1000)}s，${lastCode}）` : "";
        throw new Error(
          `连不上 harness server (${BASE})${waited}，确认它在运行（npm start）。原始错误：${e instanceof Error ? e.message : String(e)}`,
        );
      }
      lastCode = code;
      // stderr 才是 MCP 的日志通道(stdout 是协议帧,写脏了会直接搞崩会话)。
      console.error(`[harness-mcp] ${code} — server 可能在重启，${delay}ms 后重试 ${method} ${path}`);
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 5_000);
    }
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path} — ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

// 从 shared 派生,别在这里另抄一张名单:AGENT_TYPES 加一个 CLI,MCP 工具的
// 取值范围就跟着变(以前写死三个,新增执行器后 MCP 侧会莫名 400)。
const AGENT_TYPE = z.enum(AGENT_TYPES);
const PRIORITY = z.enum(["none", "low", "medium", "high", "urgent"]);
const MODE = z.enum(["parallel", "serial"]);
const TASK_STATUS = z.enum(["backlog", "done", "failed", "canceled"]);
const TASK_STAGE = z.enum(STAGE_ORDER);

// One task spec, reused by batch_create_tasks and create_task_chain.
// 注意:不再接受 dependsOn / resumeDependsOn —— 顺序依赖统一走 queue,
// chain:true 是创建队列的语法糖。要细调队列请用 queue_* 工具。
const taskShape = z.object({
  key: z.string().optional().describe("此任务的本地标识(目前没有内部用途,保留供日志/调试)"),
  title: z.string().optional().describe("省略则首次运行时由 agent 自动起名"),
  body: z.string().optional().describe("交给 agent 执行的 prompt / 目标"),
  agentType: AGENT_TYPE.optional().describe("覆盖批次默认 agent"),
  executorId: z.string().nullable().optional().describe("覆盖批次默认执行器 profile(agents.id)。指定则优先用该 profile；为空/悬空时按 agentType 默认执行器降级"),
  model: z.string().nullable().optional().describe("覆盖执行器 profile 的模型；缺省/null=跟随执行器"),
  reasoningEffort: z.string().nullable().optional().describe("覆盖执行器 profile 的思考强度；缺省/null=跟随执行器"),
  useWorktree: z.boolean().optional().describe("是否在独立 worktree 中运行；缺省跟随全局默认，非 git 项目始终为 false"),
  worktreeBase: z.string().nullable().optional().describe("worktree 的 base ref；缺省使用项目当前 HEAD"),
  priority: PRIORITY.optional(),
  labels: z.array(z.string()).optional().describe("任务标签"),
});

const server = new McpServer({ name: "harness", version: "0.1.0" });

server.registerTool(
  "resolve_project",
  {
    title: "找到或创建项目",
    description: "按 repo 路径找到或创建一个项目（幂等，可反复调）。返回含 id 的项目。把 repo 路径变成稳定 projectId 的第一步。",
    inputSchema: { repoPath: z.string().describe("git 仓库的绝对路径"), name: z.string().optional().describe("缺省取路径末段") },
  },
  async ({ repoPath, name }) => {
    try { return ok(await call("POST", "/projects/resolve", { repoPath, name })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "create_group",
  {
    title: "创建分组",
    description: "在项目里【新建】一个分组(批次容器)。用 projectId 或 repoPath 定位项目。mode=parallel 时任务相互独立并发跑;mode=serial 时配合 chain:true 自动建队列按顺序跑。注意:每次都新建——要复用同名分组(避免重复建组)请改用 resolve_group。",
    inputSchema: {
      name: z.string(),
      projectId: z.string().optional(),
      repoPath: z.string().optional().describe("projectId 的替代：按仓库路径定位项目"),
      mode: MODE.optional(),
    },
  },
  async (args) => {
    try { return ok(await call("POST", "/groups", args)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "resolve_group",
  {
    title: "找到或复用分组",
    description:
      "按 项目+名 找到或创建分组（幂等，分组版的 resolve_project）。已存在同名分组就复用它（其 mode 保持不变，不会被你传的 mode 覆盖）；同名出现多次会报错让你用 groupId 指定。要往一个固定名字的分组反复追加任务、又不想每次建重复组时，用这个而不是 create_group。",
    inputSchema: {
      name: z.string(),
      projectId: z.string().optional(),
      repoPath: z.string().optional().describe("projectId 的替代：按仓库路径定位项目"),
      mode: MODE.optional().describe("仅在【新建】分组时作为默认；复用已有分组时忽略"),
    },
  },
  async (args) => {
    try { return ok(await call("POST", "/groups/resolve", args)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "batch_create_tasks",
  {
    title: "批量建任务到已有分组",
    description: "往一个已存在的分组里批量创建 single 任务。chain:true → 创建一个 queue 把这批任务按数组顺序串成 A→B→C→D(前一个 done 后下一个自动启动)。**chain:true 只能用于 serial group**,parallel group 会返回 400。想真正并行就别开 chain。run:true 建完立即开跑。",
    inputSchema: {
      groupId: z.string(),
      tasks: z.array(taskShape).min(1),
      chain: z.boolean().optional().describe("按数组顺序串依赖 A→B→C→D"),
      run: z.boolean().optional().describe("建完立即运行该分组"),
      defaults: z.object({
        agentType: AGENT_TYPE.optional(),
        executorId: z.string().nullable().optional().describe("默认执行器 profile(agents.id)。任务自身 executorId 可覆盖；为空/悬空时按 agentType 默认执行器降级"),
        model: z.string().nullable().optional().describe("覆盖执行器 profile 的默认模型；缺省/null=跟随执行器，任务自身可覆盖"),
        reasoningEffort: z.string().nullable().optional().describe("覆盖执行器 profile 的默认思考强度；缺省/null=跟随执行器，任务自身可覆盖"),
        useWorktree: z.boolean().optional().describe("默认是否使用 worktree；缺省跟随全局默认，任务自身可覆盖"),
        worktreeBase: z.string().nullable().optional().describe("默认 worktree base ref；任务自身可覆盖"),
        priority: PRIORITY.optional(),
        labels: z.array(z.string()).optional(),
      }).optional().describe("每个任务的兜底值，任务自身可覆盖"),
    },
  },
  async ({ groupId, ...body }) => {
    try { return ok(await call("POST", `/groups/${groupId}/tasks/batch`, body)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "run_group",
  {
    title: "运行分组",
    description: "启动(或恢复)分组里所有可运行的任务。serial group 通过 queue 推进:前一个 done 后下一个自动启动;parallel group 并发拉起所有 backlog/paused。需要 groupId——不知道就先用 list_groups 按项目/repoPath 查出来。",
    inputSchema: { groupId: z.string() },
  },
  async ({ groupId }) => {
    try { return ok(await call("POST", `/groups/${groupId}/run`)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "list_groups",
  {
    title: "列出分组",
    description: "列出某项目的分组（批次容器），用 projectId 或 repoPath 定位项目；都不传则列出全部。每个分组附带任务状态汇总（total + 各状态计数），便于决定运行哪个。配合 run_group 使用。",
    inputSchema: { projectId: z.string().optional(), repoPath: z.string().optional().describe("projectId 的替代：按仓库路径定位（不会新建项目）") },
  },
  async ({ projectId, repoPath }) => {
    try {
      const qs = new URLSearchParams();
      if (projectId) qs.set("projectId", projectId);
      if (repoPath) qs.set("repoPath", repoPath);
      const q = qs.toString();
      const groups = (await call("GET", `/groups${q ? `?${q}` : ""}`)) as Array<Record<string, unknown>>;
      const allTasks = (await call("GET", "/tasks")) as Array<Record<string, unknown>>;
      return ok(groups.map((g) => {
        const mine = allTasks.filter((t) => t.groupId === g.id);
        const byStatus: Record<string, number> = {};
        for (const t of mine) byStatus[t.status as string] = (byStatus[t.status as string] ?? 0) + 1;
        return {
          id: g.id, name: g.name, mode: g.mode,
          projectId: g.projectId,
          tasks: { total: mine.length, byStatus },
        };
      }));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "list_tasks",
  {
    title: "列出任务",
    description: "列出任务,可按 projectId / groupId / parentId 过滤。团队调度者查「我的执行者现在都什么状态」用 parentId=自己的 taskId。默认隐藏已归档任务(includeArchived:true 才带上)。返回精简字段(id/title/status/archived/agentType/executorId/executorLabel/queueId/queuePosition/groupId/parentId/question)。",
    inputSchema: { projectId: z.string().optional(), groupId: z.string().optional(), parentId: z.string().optional().describe("只列这个任务的下属执行者(团队调度者用)"), includeArchived: z.boolean().optional().describe("默认 false:列表不含已归档任务") },
  },
  async ({ projectId, groupId, parentId, includeArchived }) => {
    try {
      const all = (await call("GET", "/tasks")) as Array<Record<string, unknown>>;
      const rows = all.filter(
        (t) =>
          (!projectId || t.projectId === projectId) &&
          (!groupId || t.groupId === groupId) &&
          (!parentId || t.parentId === parentId) &&
          (includeArchived || !t.archived),
      );
      return ok(rows.map((t) => ({
        id: t.id, title: t.title, status: t.status, archived: t.archived, agentType: t.agentType, executorId: t.executorId, executorLabel: t.executorLabel, labels: t.labels, queueId: t.queueId, queuePosition: t.queuePosition, groupId: t.groupId, parentId: t.parentId, question: t.question,
      })));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "get_task",
  {
    title: "查看任务",
    description: "按 id 取单个任务的完整信息(含 status、queueId、queuePosition)。",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    try { return ok(await call("GET", `/tasks/${taskId}`)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "patch_task",
  {
    title: "更新任务",
    description:
      "更新单个任务的可编辑字段:title/body/status/labels/priority/groupId/agentType/executorId/model/reasoningEffort。model/reasoningEffort 覆盖执行器 profile 的模型/思考强度，缺省或 null=跟随执行器；可在运行中修改，下一回合解析执行器时生效。executorId 指具体执行器 profile(agents.id),指定则优先用它；为空/悬空时按 agentType 默认执行器降级。**不能**用此工具改任务的队列归属——请用 queue_insert / queue_remove / queue_reorder;**想让失败/取消的任务回队列等待用 requeue_task**(它会顺带处理位置:被越过就排到队尾)。也不能把任务手动设为 running/queued/awaiting_review。**running/queued 任务的 status 一律不可改(会被 409 拒绝)——要停止/取消用 stop_task**,它才会真正杀掉 agent 进程树;直接 patch canceled 只改数据库,是 2026-07-21「complete_task 409 → failed 错乱」事故的根因。**正在执行的任务要确认完成时,也不要用 status=done——用 complete_task**:回合结束的严格结算只认 complete_task 的确认。",
    inputSchema: {
      taskId: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: TASK_STATUS.optional(),
      priority: PRIORITY.optional(),
      labels: z.array(z.string()).optional(),
      groupId: z.string().nullable().optional(),
      agentType: AGENT_TYPE.nullable().optional(),
      executorId: z.string().nullable().optional().describe("具体执行器 profile 的 agents.id；传 null 清空并按 agentType 默认执行器降级"),
      model: z.string().nullable().optional().describe("覆盖执行器 profile 的模型；缺省/null=跟随执行器"),
      reasoningEffort: z.string().nullable().optional().describe("覆盖执行器 profile 的思考强度；缺省/null=跟随执行器"),
    },
  },
  async ({ taskId, ...patch }) => {
    try { return ok(await call("PATCH", `/tasks/${taskId}`, patch)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "create_task_chain",
  {
    title: "一步建任务批次",
    description:
      "便利工具:按 repoPath 找到/创建项目 → 找到或复用分组 → 把一批任务建进去,一次调用搞定。返回 {project, group, tasks}。chain 默认 true=创建一个 queue 串成 A→B→C(前一个 done 后下一个自动启动);想真正并行就传 chain:false 并把 mode 设 parallel。run:true 立即开跑。多步编排首选这个。",
    inputSchema: {
      repoPath: z.string().describe("git 仓库绝对路径；项目按它找到或创建"),
      tasks: z.array(taskShape).min(1).describe("按顺序排列；chain 时即依赖链顺序"),
      groupName: z.string().optional().describe("分组名,缺省 task-chain。已存在同名分组会复用(不会重复建组)"),
      mode: MODE.optional(),
      chain: z.boolean().optional().describe("默认 true=创建 queue 串成依赖链(serial 才允许);false=互不依赖(配 mode=parallel 才真正并行)"),
      agentType: AGENT_TYPE.optional().describe("所有任务的默认 agent（任务可逐个覆盖）"),
      executorId: z.string().nullable().optional().describe("所有任务的默认执行器 profile(agents.id)，任务可逐个覆盖；为空/悬空时按 agentType 默认执行器降级"),
      model: z.string().nullable().optional().describe("所有任务的默认模型覆盖；缺省/null=跟随执行器，任务可逐个覆盖"),
      reasoningEffort: z.string().nullable().optional().describe("所有任务的默认思考强度覆盖；缺省/null=跟随执行器，任务可逐个覆盖"),
      useWorktree: z.boolean().optional().describe("所有任务是否使用 worktree；缺省跟随全局默认，任务可逐个覆盖"),
      worktreeBase: z.string().nullable().optional().describe("所有任务的默认 worktree base ref；任务可逐个覆盖"),
      run: z.boolean().optional(),
    },
  },
  async ({ repoPath, tasks, groupName, mode, chain, agentType, executorId, model, reasoningEffort, useWorktree, worktreeBase, run }) => {
    try {
      const project = (await call("POST", "/projects/resolve", { repoPath })) as { id: string; name: string };
      // resolve（找到或复用）而非每次新建，避免同名分组被反复建出重复副本。
      const group = (await call("POST", "/groups/resolve", { projectId: project.id, name: groupName ?? "task-chain", mode })) as {
        id: string; name: string; mode: string;
      };
      const batch = (await call("POST", `/groups/${group.id}/tasks/batch`, {
        chain: chain ?? true,
        run: !!run,
        defaults: [agentType, executorId, model, reasoningEffort, useWorktree, worktreeBase].some((v) => v !== undefined)
          ? { agentType, executorId, model, reasoningEffort, useWorktree, worktreeBase }
          : undefined,
        tasks,
      })) as { tasks: unknown[]; warning?: string };
      return ok({
        project: { id: project.id, name: project.name },
        group: { id: group.id, name: group.name, mode: group.mode },
        tasks: batch.tasks,
        ...(batch.warning ? { warning: batch.warning } : {}),
      });
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "report_stage",
  {
    title: "上报验证结论",
    description:
      "在验证回合里上报与 TaskStatus 正交的验证结论，不会改变队列或任务结算。验证轮开始时后端自动置 verifying；真实运行验证后报 verified 或 verify_failed。web 改动必须启动服务、用浏览器确认行为，只读代码或只过编译不算验证；截图按需——改动看得见时必须截，看不见的改动（服务端逻辑、CLI、脚本）不需要截图，报告里贴命令与输出即可。验证现在就跑在被验任务自己身上（旁路回合），所以 taskId 填被验任务的 id——那多半就是你当前这个任务；历史的独立审查任务仍填被审任务 id，不是审查任务自己的 id。implemented/awaiting_acceptance/merged/accepted 保留给兼容与验收链路；团队调度台(mode=team)仍不适用。普通执行回合不自我上报验证阶段。",
    inputSchema: {
      taskId: z.string().describe("被验任务 id（就地验证时即当前任务；历史独立审查任务填被审任务 id）"),
      stage: TASK_STAGE.describe(`阶段：${STAGE_ORDER.join(" | ")}`),
    },
  },
  async ({ taskId, stage }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/stage`, { stage })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "accept_task",
  {
    title: "确认验收通过并合并清理",
    description:
      "仅在用户明确表示「验收通过」「可以合并」等最终验收意图时调用。服务端会确定性执行：把任务分支合并到 worktreeBase（空则项目当前分支），确认已合并后删除任务 worktree，并用 git branch -d 安全删除任务分支，最后把 stage 标为 accepted；status 不会改变。冲突、目标工作区脏或清理失败时会返回结构化原因，绝不强制合并。不要自行运行 git merge / worktree remove / branch -d，统一调用本工具。parentId 指向团队且 useWorktree=false 的共享执行者不适用本工具，单独调用会被 409 拒绝；请验收团队整体，团队级成功会联动把全部共享执行者标为 accepted。",
    inputSchema: {
      taskId: z.string().describe("用户明确验收通过的任务 id"),
    },
  },
  async ({ taskId }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/accept`, {})); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "complete_task",
  {
    title: "确认任务完成(严格 done 协议)",
    description:
      "在执行中调用,告诉 harness:「本任务的目标我确定已经达成了」。回合结束结算时读到这个确认才会把任务落成 done;**没有确认的正常退出(exit 0)会按未完成记为 failed**——因为正常退出不代表目标达成(报错后退出也是 exit 0),假 done 会误推进队列、错误唤醒下游任务。\n\n用法:当且仅当你核实任务目标已达成(产物在、校验过),在结束回合前调一次本工具,然后正常结束输出。**只能在任务正在跑时调用**。没完成就不要调:需要等外部条件用 pause_task;做不下去直接说明原因退出(会记 failed,用户可重试续跑)。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id(任务 prompt 前言里有)"),
    },
  },
  async ({ taskId }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/complete`, {})); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "pause_task",
  {
    title: "在检查点暂停(等续跑)",
    description:
      "在执行中调用,告诉 harness:「我跑到一个检查点了,下次该继续时给我喂这段 prompt」。harness 会把 resumePrompt 写到 task 上;你这一回合自然结束后,状态落到 paused(而不是 done),队列推进规则会在前一个任务 done 时用 resumePrompt 把你叫醒、resume 同一个 CLI 会话。\n\n用法:先正常做完检查点前的所有工作;要暂停时调一次本工具,然后正常退出当前回合(return / 结束输出即可)。**只能在任务正在跑时调用**,且 resumePrompt 不能为空(否则 resume 时没东西喂你)。\n\n典型场景:dr-dig-ytb 一类「pre-tts 并行 + tts 串行」流水线 —— 把任务跑到 pre-tts 末尾时调本工具,resumePrompt 写下「现在做 tts 这一段」;后续每个任务都在自己 queue 位置上等前一个 done 后自动续跑。\n\n注意:被具体问题卡住、要等人拍板才能继续时,用 ask_question 而不是本工具——pause 是「到检查点等续跑」,ask 是「等答案」且会自动通知团队调度者。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id"),
      resumePrompt: z.string().min(1).describe("下次被 resume 时喂给你的 user 消息 —— 就当成一条「继续：…」replied 写"),
    },
  },
  async ({ taskId, resumePrompt }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/pause`, { resumePrompt })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "stop_task",
  {
    title: "停止/取消任务(杀进程树)",
    description:
      "停止一个 running/queued 的任务:终止它的整棵 agent 进程树(claude/codex 及其子进程一起),由 run loop 结算为 canceled(可重试,重试会从中断处续跑);queued 还没拉起进程的直接落 canceled。**取消运行中的任务必须用这个,严禁 patch_task(status=canceled)**——那样只改数据库不停进程,会导致:队列被提前推进(串行变并行)、活着的 agent 调 complete_task 吃 409、结算再把 canceled 覆盖成 failed。",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/stop`, {})); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "ask_question",
  {
    title: "提问并暂停(等调度者/用户答复)",
    description:
      `在执行中调用,告诉 harness:「我被不拍板就没法继续的决策卡住了」。调完后正常结束回合,任务落 paused 且**队列不会自动续跑**;问题会即时送达团队调度者(你是执行者时),没有调度者就停在那等用户答复。你自己是团队调度者时调它 = 问用户,界面上显示成「调度者在等你答复」。答复通过 answer_question 送达,会作为一段文本唤醒你的同一个 CLI 会话续跑。\n\n用法:只能在任务正在跑时调用;先把当下能做的都做完再提问。一个决策用 question + options;有几个**相关且都需要同一个人拍板**的决策时,用 question 写共同背景,再用 questionItems 一次问完(最多 ${MAX_QUESTION_ITEMS} 个),避免挤牙膏式来回。不要把无关问题硬凑在一起。\n\noptions / questionItems[i].options 都是**建议答案,不是单选题**:每条只写一句能直接当答复读的话,理由和取舍留在对应 question 里。网页点击候选只会填入该问题的输入框,已有内容会换行追加;答复者仍可修改、组合多条或完全自由作答。最终所有问题的答案会编号合并成一段文本,仍走原来的 answer_question 协议。跟 pause_task 的区别:pause 是「到检查点等续跑指令」,ask 是「等具体问题的答案」。`,
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id(任务 prompt 前言里有)"),
      question: z.string().min(1).describe("单问题时就是问题本体；传 questionItems 时写共同引言/背景"),
      options: z
        .array(z.string().min(1).max(MAX_QUESTION_OPTION_LEN))
        .max(MAX_QUESTION_OPTIONS)
        .optional()
        .describe(
          `单问题的建议答案(可选,最多 ${MAX_QUESTION_OPTIONS} 个、每个不超过 ${MAX_QUESTION_OPTION_LEN} 字)。多问题时不要传这里,改放各 questionItems[i].options。`,
        ),
      questionItems: z
        .array(
          z.object({
            question: z.string().min(1).describe("这个独立问题的背景、取舍和需要拍板的点"),
            options: z
              .array(z.string().min(1).max(MAX_QUESTION_OPTION_LEN))
              .max(MAX_QUESTION_OPTIONS)
              .optional()
              .describe(
                `这个问题的建议答案(可选,最多 ${MAX_QUESTION_OPTIONS} 个、每个不超过 ${MAX_QUESTION_OPTION_LEN} 字):每条都应能直接当答复读,不是单选题。`,
              ),
          }),
        )
        .max(MAX_QUESTION_ITEMS)
        .optional()
        .describe(`一次并列询问的相关问题(可选,最多 ${MAX_QUESTION_ITEMS} 个)；每题会独立显示候选和输入框。`),
    },
  },
  async ({ taskId, question, options, questionItems }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/ask`, { question, options, questionItems })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "answer_question",
  {
    title: "答复提问中的任务并唤醒它",
    description:
      "给一个「提问暂停」中的任务(get_task 里 question 非空、status=paused)送答复:清空问题、把答复作为消息 resume 它的 CLI 会话继续跑。团队调度者收到【执行者提问】通知后用这个答;用户/其他 agent 也可以直接调。提问任务还在 running/queued(回合没结算完)时会被拒,稍等它落 paused 再调 —— 例外是团队调度台(mode=team),它是常驻会话,忙着也接得住。",
    inputSchema: {
      taskId: z.string().describe("提问任务的 id(通知里有)"),
      answer: z.string().min(1).describe("答复内容:直接给结论和理由,它会原样喂给对方续跑"),
    },
  },
  async ({ taskId, answer }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/answer`, { answer })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "dispatch",
  {
    title: "派活给执行者(团队调度者专用)",
    description:
      "团队调度者(mode=team 的任务)用这个派活:一次建 N 个执行者任务,绑到自己名下,默认立刻起跑。每个执行者是一个完整的 CLI agent(自己还能开子代理),默认与调度台在同一个工作目录里干活;团队开启 worktree 时也共享它。\n\n• mode=\"serial\"(多个任务时的默认)会把这批串成 A→B→C,前一个 done 后下一个自动起跑;mode=\"parallel\" 才是真并行(限流 4 个),确认互不干扰再用。\n• **body 写目标、背景、约束、验收标准,不写实现步骤**——执行者是和你同级智能的完整 agent,how 留给它;用户明确指定了做法才原样传达。body 要自带完整上下文(执行者彼此不知情,也看不到你和用户的对话)。只有 parallel 时才需要在各自 body 里划清文件/模块边界,否则并行的执行者会互相踩;serial 不必划界。\n• review 缺省跟随团队配置（默认开启）；单项传 false 可跳过该执行者的自动审查。\n• reportBack:true = 它做完要叫醒你(你打算接着安排下一步时用);false(默认)= 静默完成,你随时能用 list_tasks 查。\n• 你会被唤醒的时机只有三种:执行者提问、执行者失败、reportBack 的执行者完成。\n\n返回执行者的 id + 标题,后续用 get_task / run_task / answer_question 引用它们。",
    inputSchema: {
      leadTaskId: z.string().describe("你自己的 taskId(团队任务,prompt 前言里有)"),
      tasks: z
        .array(
          z.object({
            body: z.string().min(1).describe("给执行者的完整指令:目标、背景、约束、验收标准(不写实现步骤;parallel 时另加文件边界)"),
            title: z.string().optional().describe("简短标题(界面上显示);省略则取 body 第一行"),
            agentType: AGENT_TYPE.optional().describe("覆盖团队默认的执行者类型"),
            executorId: z.string().nullable().optional().describe("覆盖团队执行者任务的默认执行器 profile(agents.id)。指定则优先用该 profile；为空/悬空时按 agentType 默认执行器降级"),
            model: z.string().nullable().optional().describe("覆盖执行器 profile 的模型；缺省=跟随团队默认，null=跟随执行器"),
            reasoningEffort: z.string().nullable().optional().describe("覆盖执行器 profile 的思考强度；缺省=跟随团队默认，null=跟随执行器"),
            reportBack: z.boolean().optional().describe("true=它完成时叫醒你;默认 false 静默完成"),
            useWorktree: z.boolean().optional().describe("true=这个执行者在团队共享目录之上再单独开 worktree 隔离(默认 false,继承调度台目录)"),
            review: z.boolean().optional().describe("是否在执行者确认完成后自动派审；缺省跟随团队配置（默认开启）"),
          }),
        )
        .min(1)
        .describe("这一批执行者,按顺序排列(serial 时即执行顺序)"),
      mode: MODE.optional().describe("serial=串成队列依次跑(多个任务时的默认);parallel=同时开工"),
      run: z.boolean().optional().describe("默认 true 立即起跑;false 只建不跑(之后用 run_task 手动起)"),
      batchName: z.string().optional().describe("这批活的名字(界面上的分组名),缺省自动生成"),
    },
  },
  async ({ leadTaskId, tasks, mode, run, batchName }) => {
    try { return ok(await call("POST", `/tasks/${leadTaskId}/dispatch`, { tasks, mode, run, batchName })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "run_task",
  {
    title: "起跑/续跑一个任务",
    description:
      "启动一个任务,或让一个停下来的任务从**它自己的 CLI 会话**续跑(比新建任务便宜:上下文都还在)。失败的执行者查明原因后用这个重试;backlog 的任务用这个开工。已经在跑的任务调用无副作用。",
    inputSchema: { taskId: z.string().describe("要起跑/续跑的任务 id") },
  },
  async ({ taskId }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/run`, {})); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "requeue_task",
  {
    title: "重新排队",
    description:
      "把一个 failed/canceled 的任务放回它所在队列等待,轮到它时自动启动(有会话就从中断处续跑)。跟 run_task 的区别:run 是现在就跑,requeue 是回队列排着。**位置**:失败任务是被队列透明跳过的,如果后面已经有任务开跑过(它的原位置名存实亡),服务端会自动把它移到**队尾**;后面没人跑过则原位不动。别再用 patch_task(status=backlog) + queue_reorder 手拼——留在原位会让它抢在正在跑的那个前面,同一条串行队列上两个任务并跑。",
    inputSchema: { taskId: z.string().describe("要重新排队的任务 id(必须是 failed/canceled 且在某个 queue 里)") },
  },
  async ({ taskId }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/requeue`, {})); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "get_queue",
  {
    title: "查看队列",
    description: "按 queueId 列出队列内容(taskId/position/status)。任务详情里的 queueId 字段就是入口。",
    inputSchema: { queueId: z.string() },
  },
  async ({ queueId }) => {
    try { return ok(await call("GET", `/queues/${queueId}`)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "queue_reorder",
  {
    title: "重排队列",
    description: "整批改 queue 的 task 顺序。taskIds 必须是该 queue 的完整成员(漏一个或多一个都报错)。running/queued 的 task 不能被移动位置(报 409)。",
    inputSchema: {
      queueId: z.string(),
      taskIds: z.array(z.string()).min(1).describe("新顺序,必须等于 queue 当前成员集合"),
    },
  },
  async ({ queueId, taskIds }) => {
    try { return ok(await call("POST", `/queues/${queueId}/reorder`, { taskIds })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "queue_remove",
  {
    title: "从队列移除任务",
    description: "把 task 移出 queue(task 本身不删,只是脱离队列变成独立任务)。下游会自动顶上。running/queued 的不能拔。",
    inputSchema: { queueId: z.string(), taskId: z.string() },
  },
  async ({ queueId, taskId }) => {
    try { return ok(await call("POST", `/queues/${queueId}/remove`, { taskId })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "queue_insert",
  {
    title: "插入任务到队列",
    description: "在指定 position 插入(0 = 队首)。校验:候选 task 必须存在、不在其它 queue、跟 queue 同 group。",
    inputSchema: {
      queueId: z.string(),
      taskId: z.string(),
      position: z.number().int().optional().describe("0..length;省略或越界 = 追加到尾部"),
    },
  },
  async ({ queueId, taskId, position }) => {
    try { return ok(await call("POST", `/queues/${queueId}/insert`, { taskId, position })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "create_queue",
  {
    title: "新建队列",
    description: "用一批已存在的 task id 新建一个 queue,按数组顺序占位置。要求:这批 task 都在同一个 group(或都无 group),且都不在其它 queue 里。",
    inputSchema: { taskIds: z.array(z.string()).min(1) },
  },
  async ({ taskIds }) => {
    try { return ok(await call("POST", "/queues", { taskIds })); }
    catch (e) { return fail(e); }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[harness-mcp] connected — tools ready (HARNESS_URL=${BASE})`);

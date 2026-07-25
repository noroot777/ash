#!/usr/bin/env node
// Harness MCP server — a THIN adapter that exposes the harness HTTP API as MCP
// tools so an LLM agent (Claude Code / Desktop / Cursor / a spawned `claude`)
// can orchestrate tasks natively. It holds no logic of its own: every tool just
// calls an existing endpoint on the harness server (default http://localhost:4317,
// override with HARNESS_URL). The Hono server stays the single source of truth.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.HARNESS_URL ?? "http://localhost:4317").replace(/\/+$/, "");

// One place to talk to the API. Network failures get a human hint; HTTP errors
// surface the server's JSON error body verbatim so the agent can react.
async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`连不上 harness server (${BASE})，确认它在运行（npm start）。原始错误：${e instanceof Error ? e.message : String(e)}`);
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

const AGENT_TYPE = z.enum(["claude", "codex", "antigravity"]);
const PRIORITY = z.enum(["none", "low", "medium", "high", "urgent"]);
const MODE = z.enum(["parallel", "serial"]);
const TASK_STATUS = z.enum(["backlog", "done", "failed", "canceled"]);

// One task spec, reused by batch_create_tasks and create_task_chain.
// 注意:不再接受 dependsOn / resumeDependsOn —— 顺序依赖统一走 queue,
// chain:true 是创建队列的语法糖。要细调队列请用 queue_* 工具。
const taskShape = z.object({
  key: z.string().optional().describe("此任务的本地标识(目前没有内部用途,保留供日志/调试)"),
  title: z.string().optional().describe("省略则首次运行时由 agent 自动起名"),
  body: z.string().optional().describe("交给 agent 执行的 prompt / 目标"),
  agentType: AGENT_TYPE.optional().describe("覆盖批次默认 agent"),
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
    description: "列出任务,可按 projectId / groupId / parentId 过滤。团队指挥者查「我的工人现在都什么状态」用 parentId=自己的 taskId。默认隐藏已归档任务(includeArchived:true 才带上)。返回精简字段(id/title/status/archived/agentType/queueId/queuePosition/groupId/parentId/question)。",
    inputSchema: { projectId: z.string().optional(), groupId: z.string().optional(), parentId: z.string().optional().describe("只列这个任务的下属工人(团队指挥者用)"), includeArchived: z.boolean().optional().describe("默认 false:列表不含已归档任务") },
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
        id: t.id, title: t.title, status: t.status, archived: t.archived, agentType: t.agentType, labels: t.labels, queueId: t.queueId, queuePosition: t.queuePosition, groupId: t.groupId, parentId: t.parentId, question: t.question,
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
      "更新单个任务的可编辑字段:title/body/status/labels/priority/groupId/agentType。**不能**用此工具改任务的队列归属——请用 queue_insert / queue_remove / queue_reorder。也不能把任务手动设为 running/queued/awaiting_review。**running/queued 任务的 status 一律不可改(会被 409 拒绝)——要停止/取消用 stop_task**,它才会真正杀掉 agent 进程树;直接 patch canceled 只改数据库,是 2026-07-21「complete_task 409 → failed 错乱」事故的根因。**正在执行的任务要确认完成时,也不要用 status=done——用 complete_task**:回合结束的严格结算只认 complete_task 的确认。",
    inputSchema: {
      taskId: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: TASK_STATUS.optional(),
      priority: PRIORITY.optional(),
      labels: z.array(z.string()).optional(),
      groupId: z.string().nullable().optional(),
      agentType: AGENT_TYPE.nullable().optional(),
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
      run: z.boolean().optional(),
    },
  },
  async ({ repoPath, tasks, groupName, mode, chain, agentType, run }) => {
    try {
      const project = (await call("POST", "/projects/resolve", { repoPath })) as { id: string; name: string };
      // resolve（找到或复用）而非每次新建，避免同名分组被反复建出重复副本。
      const group = (await call("POST", "/groups/resolve", { projectId: project.id, name: groupName ?? "task-chain", mode })) as {
        id: string; name: string; mode: string;
      };
      const batch = (await call("POST", `/groups/${group.id}/tasks/batch`, {
        chain: chain ?? true,
        run: !!run,
        defaults: agentType ? { agentType } : undefined,
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
      "在执行中调用,告诉 harness:「我跑到一个检查点了,下次该继续时给我喂这段 prompt」。harness 会把 resumePrompt 写到 task 上;你这一回合自然结束后,状态落到 paused(而不是 done),队列推进规则会在前一个任务 done 时用 resumePrompt 把你叫醒、resume 同一个 CLI 会话。\n\n用法:先正常做完检查点前的所有工作;要暂停时调一次本工具,然后正常退出当前回合(return / 结束输出即可)。**只能在任务正在跑时调用**,且 resumePrompt 不能为空(否则 resume 时没东西喂你)。\n\n典型场景:dr-dig-ytb 一类「pre-tts 并行 + tts 串行」流水线 —— 把任务跑到 pre-tts 末尾时调本工具,resumePrompt 写下「现在做 tts 这一段」;后续每个任务都在自己 queue 位置上等前一个 done 后自动续跑。\n\n注意:被具体问题卡住、要等人拍板才能继续时,用 ask_question 而不是本工具——pause 是「到检查点等续跑」,ask 是「等答案」且会自动通知团队指挥者。",
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
    title: "提问并暂停(等指挥者/用户答复)",
    description:
      "在执行中调用,告诉 harness:「我被一个不拍板就没法继续的问题卡住了」。调完后正常结束回合,任务落 paused 且**队列不会自动续跑**;问题会即时送达团队指挥者(你是工人时),没有指挥者就停在那等用户答复。你自己是团队指挥者时调它 = 问用户,界面上显示成「指挥者在等你答复」。答复通过 answer_question 送达,会作为新消息唤醒你的同一个 CLI 会话续跑。\n\n用法:只能在任务正在跑时调用;先把当下能做的都做完再提问,一次把问题问全(背景+选项+你的倾向),别挤牙膏式来回。跟 pause_task 的区别:pause 是「到检查点等续跑指令」,ask 是「等一个具体问题的答案」。",
    inputSchema: {
      taskId: z.string().describe("当前正在执行的任务 id(任务 prompt 前言里有)"),
      question: z.string().min(1).describe("要问的问题:写清背景、可选方案和你的倾向,让答复者能直接拍板"),
    },
  },
  async ({ taskId, question }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/ask`, { question })); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "answer_question",
  {
    title: "答复提问中的任务并唤醒它",
    description:
      "给一个「提问暂停」中的任务(get_task 里 question 非空、status=paused)送答复:清空问题、把答复作为消息 resume 它的 CLI 会话继续跑。团队指挥者收到【工人提问】通知后用这个答;用户/其他 agent 也可以直接调。提问任务还在 running/queued(回合没结算完)时会被拒,稍等它落 paused 再调。",
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
    title: "派活给工人(团队指挥者专用)",
    description:
      "团队指挥者(mode=team 的任务)用这个派活:一次建 N 个工人任务,绑到自己名下,默认立刻起跑。每个工人是一个完整的 CLI agent(自己还能开子代理),在同一个仓库目录里干活。\n\n• mode=\"serial\"(多个任务时的默认)会把这批串成 A→B→C,前一个 done 后下一个自动起跑;mode=\"parallel\" 才是真并行(限流 4 个),确认互不干扰再用。\n• 每个 body 要自带完整上下文 —— 工人之间彼此不知情,也看不到你和用户的对话。**要划清文件/模块边界就自己写进每个工人的 body**,否则并行的工人会互相踩。\n• reportBack:true = 它做完要叫醒你(你打算接着安排下一步时用);false(默认)= 静默完成,你随时能用 list_tasks 查。\n• 你会被唤醒的时机只有三种:工人提问、工人失败、reportBack 的工人完成。\n\n返回工人的 id + 标题,后续用 get_task / run_task / answer_question 引用它们。",
    inputSchema: {
      leadTaskId: z.string().describe("你自己的 taskId(团队任务,prompt 前言里有)"),
      tasks: z
        .array(
          z.object({
            body: z.string().min(1).describe("给工人的完整指令:目标、上下文、文件边界、验收标准"),
            title: z.string().optional().describe("简短标题(界面上显示);省略则取 body 第一行"),
            agentType: AGENT_TYPE.optional().describe("覆盖团队默认的工人类型"),
            reportBack: z.boolean().optional().describe("true=它完成时叫醒你;默认 false 静默完成"),
            useWorktree: z.boolean().optional().describe("true=这个工人单独开 worktree 隔离(默认 false,同目录干活)"),
          }),
        )
        .min(1)
        .describe("这一批工人,按顺序排列(serial 时即执行顺序)"),
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
      "启动一个任务,或让一个停下来的任务从**它自己的 CLI 会话**续跑(比新建任务便宜:上下文都还在)。失败的工人查明原因后用这个重试;backlog 的任务用这个开工。已经在跑的任务调用无副作用。",
    inputSchema: { taskId: z.string().describe("要起跑/续跑的任务 id") },
  },
  async ({ taskId }) => {
    try { return ok(await call("POST", `/tasks/${taskId}/run`, {})); }
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

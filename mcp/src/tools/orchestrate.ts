// 「安排谁去做什么、按什么顺序」那一组工具：项目、分组、任务清单与批量创建、团队派活、
// 起跑/重新排队、队列增删改。
//
// 与 task-turn.ts 的分界是**作用对象**：这里的工具摆布的是「一批活怎么组织」，那边的
// 是「某一条任务在自己回合里对 ash 说什么」。按这条线拆，加一个队列工具不会挤到回合
// 协议那份措辞旁边——而回合协议的措辞是最经不起误改的东西。
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { call, fail, ok } from "../runtime.js";
import { AGENT_TYPE, MODE, TASK_STATUS, WORKFLOW_MODE, taskShape } from "../schemas.js";

export function registerOrchestrationTools(server: McpServer): void {
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
    description: "往一个已存在的分组里批量创建 single 任务。chain:true → 创建一个 queue 把这批任务按数组顺序串成 A→B→C→D(前一个 done 后下一个自动启动)。**chain:true 只能用于 serial group**,parallel group 会返回 400。想真正并行就别开 chain。run:true 建完立即开跑。建出来的任务默认走**自由工作流**(workflowMode=free);要那条固定的站点线才传 preset。",
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
        mergeTargetBranch: z.string().nullable().optional().describe("默认最终合入分支，独立于开工起点"),
        workflowMode: WORKFLOW_MODE.optional(),
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
      "更新单个任务的可编辑字段:title/body/status/labels/groupId/agentType/executorId/model/reasoningEffort。model/reasoningEffort 覆盖执行器 profile 的模型/思考强度，缺省或 null=跟随执行器；ash 拉起的当前 agent 可在运行中修改，下一回合解析执行器时生效；Claude Desktop/Cursor 等没有 ash 回合身份的外部 MCP 客户端只能在任务空闲后修改。executorId 指具体执行器 profile(agents.id),指定则优先用它；为空/悬空时按 agentType 默认执行器降级。**不能**用此工具改任务的队列归属——请用 queue_insert / queue_remove / queue_reorder;**想让失败/取消的任务回队列等待用 requeue_task**(它会顺带处理位置:被越过就排到队尾)。也不能把任务手动设为 running/queued/awaiting_review。**running/queued 任务的 status 一律不可改(会被 409 拒绝)——要停止/取消用 stop_task**,它才会真正杀掉 agent 进程树;直接 patch canceled 只改数据库,是 2026-07-21「complete_task 409 → failed 错乱」事故的根因。**正在执行的任务要确认完成时,也不要用 status=done——用 complete_task**:回合结束的严格结算只认 complete_task 的确认。",
    inputSchema: {
      taskId: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: TASK_STATUS.optional(),
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
      "便利工具:按 repoPath 找到/创建项目 → 找到或复用分组 → 把一批任务建进去,一次调用搞定。返回 {project, group, tasks}。chain 默认 true=创建一个 queue 串成 A→B→C(前一个 done 后下一个自动启动);想真正并行就传 chain:false 并把 mode 设 parallel。run:true 立即开跑。多步编排首选这个。建出来的任务默认走**自由工作流**(workflowMode=free);要那条固定的站点线才传 preset。",
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
      mergeTargetBranch: z.string().nullable().optional().describe("所有任务的默认最终合入分支"),
      workflowMode: WORKFLOW_MODE.optional(),
      run: z.boolean().optional(),
    },
  },
  async ({ repoPath, tasks, groupName, mode, chain, agentType, executorId, model, reasoningEffort, useWorktree, worktreeBase, mergeTargetBranch, workflowMode, run }) => {
    try {
      const project = (await call("POST", "/projects/resolve", { repoPath })) as { id: string; name: string };
      // resolve（找到或复用）而非每次新建，避免同名分组被反复建出重复副本。
      const group = (await call("POST", "/groups/resolve", { projectId: project.id, name: groupName ?? "task-chain", mode })) as {
        id: string; name: string; mode: string;
      };
      const batch = (await call("POST", `/groups/${group.id}/tasks/batch`, {
        chain: chain ?? true,
        run: !!run,
        defaults: [agentType, executorId, model, reasoningEffort, useWorktree, worktreeBase, mergeTargetBranch, workflowMode].some((v) => v !== undefined)
          ? { agentType, executorId, model, reasoningEffort, useWorktree, worktreeBase, mergeTargetBranch, workflowMode }
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
  "dispatch",
  {
    title: "派活给执行者(团队调度者专用)",
    description:
      "团队调度者(mode=team 的任务)用这个派活:一次建 N 个执行者任务,绑到自己名下,默认立刻起跑。每个执行者是一个完整的 CLI agent(自己还能开子代理),默认与调度台在同一个工作目录里干活;团队开启 worktree 时也共享它。\n\n• mode=\"serial\"(多个任务时的默认)会把这批串成 A→B→C,前一个 done 后下一个自动起跑;mode=\"parallel\" 才是真并行(限流 4 个),确认互不干扰再用。\n• **body 写目标、背景、约束、验收标准,不写实现步骤**——执行者是和你同级智能的完整 agent,how 留给它;用户指定的做法、已确认的硬约束、已证伪的路线属于约束要传达,开放的实现选择才留给它。body 要自带完整上下文(执行者彼此不知情,也看不到你和用户的对话)。只有 parallel 时才需要在各自 body 里划清文件/模块边界,否则并行的执行者会互相踩;serial 不必划界。\n• review 缺省跟随团队配置（默认开启）；单项传 false 可跳过该执行者的自动审查。\n• reportBack:true = 它做完要叫醒你(你打算接着安排下一步时用);false(默认)= 静默完成,你随时能用 list_tasks 查。\n• 你会被唤醒的时机只有三种:执行者提问、执行者失败、reportBack 的执行者完成。\n\n返回执行者的 id + 标题,后续用 get_task / run_task / answer_question 引用它们。",
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
}

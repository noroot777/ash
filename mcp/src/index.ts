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

// One task spec, reused by batch_create_tasks and create_task_chain.
const taskShape = z.object({
  key: z.string().optional().describe("此任务的本地标识，供同批其它任务在 dependsOn 里引用（id 此刻还不存在）"),
  title: z.string().optional().describe("省略则首次运行时由 agent 自动起名"),
  body: z.string().optional().describe("交给 agent 执行的 prompt / 目标"),
  agentType: AGENT_TYPE.optional().describe("覆盖批次默认 agent"),
  priority: PRIORITY.optional(),
  labels: z.array(z.string()).optional().describe("任务标签"),
  dependsOn: z.array(z.string()).optional().describe("同批任务的 key（解析成 id）或已存在的任务 id"),
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
    description: "在项目里【新建】一个分组（批次容器）。用 projectId 或 repoPath 定位项目。mode=parallel 时按 dependsOn 调度，serial 时按创建顺序串跑。注意：每次都新建——要复用同名分组（避免重复建组）请改用 resolve_group。",
    inputSchema: {
      name: z.string(),
      projectId: z.string().optional(),
      repoPath: z.string().optional().describe("projectId 的替代：按仓库路径定位项目"),
      mode: MODE.optional(),
      useWorktree: z.boolean().optional().describe("默认 true，每个任务独立 worktree 隔离"),
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
      "按 项目+名 找到或创建分组（幂等，分组版的 resolve_project）。已存在同名分组就复用它（其 mode/worktree 保持不变，不会被你传的 mode 覆盖）；同名出现多次会报错让你用 groupId 指定。要往一个固定名字的分组反复追加任务、又不想每次建重复组时，用这个而不是 create_group。",
    inputSchema: {
      name: z.string(),
      projectId: z.string().optional(),
      repoPath: z.string().optional().describe("projectId 的替代：按仓库路径定位项目"),
      mode: MODE.optional().describe("仅在【新建】分组时作为默认；复用已有分组时忽略"),
      useWorktree: z.boolean().optional().describe("仅在【新建】分组时生效；复用时忽略"),
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
    description: "往一个已存在的分组里批量创建 single 任务。chain:true 自动串成 A→B→C→D 依赖链（=严格串行，即使分组是 parallel）；想要任务真正并行就别开 chain。run:true 建完立即开跑。",
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
    description: "启动（或恢复）分组里所有可运行的任务，遵循 parallel/serial 与 dependsOn。需要 groupId——不知道就先用 list_groups 按项目/repoPath 查出来。",
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
          id: g.id, name: g.name, mode: g.mode, useWorktree: g.useWorktree,
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
    description: "列出任务，可按 projectId / groupId 过滤。返回精简字段（id/title/status/agentType/dependsOn/groupId）。",
    inputSchema: { projectId: z.string().optional(), groupId: z.string().optional() },
  },
  async ({ projectId, groupId }) => {
    try {
      const all = (await call("GET", "/tasks")) as Array<Record<string, unknown>>;
      const rows = all.filter(
        (t) => (!projectId || t.projectId === projectId) && (!groupId || t.groupId === groupId),
      );
      return ok(rows.map((t) => ({
        id: t.id, title: t.title, status: t.status, agentType: t.agentType, labels: t.labels, dependsOn: t.dependsOn, groupId: t.groupId,
      })));
    } catch (e) { return fail(e); }
  },
);

server.registerTool(
  "get_task",
  {
    title: "查看任务",
    description: "按 id 取单个任务的完整信息（含 status 与 dependsOn）。",
    inputSchema: { taskId: z.string() },
  },
  async ({ taskId }) => {
    try { return ok(await call("GET", `/tasks/${taskId}`)); }
    catch (e) { return fail(e); }
  },
);

server.registerTool(
  "create_task_chain",
  {
    title: "一步建任务批次",
    description:
      "便利工具：按 repoPath 找到/创建项目 → 找到或复用分组 → 把一批任务建进去，一次调用搞定。返回 {project, group, tasks}。chain 默认 true=串成依赖链 A→B→C（严格串行）；想真正并行就传 chain:false 并把 mode 设 parallel。run:true 立即开跑。多步编排首选这个。",
    inputSchema: {
      repoPath: z.string().describe("git 仓库绝对路径；项目按它找到或创建"),
      tasks: z.array(taskShape).min(1).describe("按顺序排列；chain 时即依赖链顺序"),
      groupName: z.string().optional().describe("分组名，缺省 task-chain。已存在同名分组会复用（不会重复建组）"),
      mode: MODE.optional(),
      chain: z.boolean().optional().describe("默认 true=串成依赖链（串行）；false=互不依赖（配 mode=parallel 才真正并行）"),
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[harness-mcp] connected — tools ready (HARNESS_URL=${BASE})`);

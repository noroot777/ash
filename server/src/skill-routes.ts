// `/技能` 相关的三个只读端点。从 `routes.ts` 拆出来只有一个理由:那个文件到 700 行了。
//
// 这里的共同前提是「谁去扫、扫哪儿」这两件事分属不同层级:
//   扫哪儿 —— 项目仓库根(worktree 里的 `.claude/skills` 是同一份仓库内容的副本)
//   谁去扫 —— 执行器 profile(同类型下常常一个本机一个 ssh,后者的技能在远端盘上)
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AgentType } from "@harness/shared";
import { db } from "./db/index.js";
import { agents, projects } from "./db/schema.js";
import { listSkills, scanOverview } from "./skills.js";

const repoPathOf = async (projectId: string): Promise<string> => {
  if (!projectId) return "";
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  return p?.repoPath ?? "";
};

const targetKindOf = (target: string): string => {
  try {
    return JSON.parse(target || "{}")?.kind ?? "local";
  } catch {
    return "local"; // 目标字段脏了就当本机
  }
};

// 没点名 executorId 时按类型找:**优先默认 profile**。同一类型下常常一个本机一个 ssh,
// 随手取第一行会让菜单时有时无 —— 那种飘忽比直接说「远端扫不到」更难查。
const isRemoteExecutor = async (agentType: string, executorId: string): Promise<boolean> => {
  const rows = executorId
    ? await db.select().from(agents).where(eq(agents.id, executorId))
    : await db.select().from(agents).where(eq(agents.type, agentType as AgentType));
  const row = rows.find((candidate) => candidate.isDefault) ?? rows[0];
  return !!row && targetKindOf(row.target) === "ssh";
};

// 设置页的「谁扫到了什么」。这里只负责把已注册的 profile 摊平交给 scanOverview,
// 「哪些 profile 算同一行」的规则在那边(CLI 类型 × 本机/远端)。
// force 时绕过 mtime 指纹,连 frontmatter 一起重读。
const skillsOverview = async (projectId: string, force: boolean) => {
  const cwd = await repoPathOf(projectId);
  const rows = await db.select().from(agents);
  const executors = rows.map((row) => ({
    label: row.name,
    agentType: row.type,
    remote: targetKindOf(row.target) === "ssh",
  }));
  // 一个 profile 都没注册时不给空白页:按 CLI 类型各列一行,至少让人看见扫得到什么。
  const fallback = ["claude", "codex", "gemini"].map((agentType) => ({
    label: "",
    agentType,
    remote: false,
  }));
  return scanOverview({ cwd, executors: executors.length ? executors : fallback, force });
};

export function mountSkillRoutes(api: Hono): void {
  // 这个 CLI 现在能用哪些 `/技能`(给输入框的斜杠补全用)。
  // executorId 只用来看这个执行器是不是跑在 ssh 上 —— 远端的技能装在远端盘上,
  // 本机扫不出来,这种情况如实返回空表 + remote:true,不假装。
  api.get("/skills", async (c) => {
    const agentType = c.req.query("agentType") || "claude";
    const projectId = c.req.query("projectId") || "";
    const executorId = c.req.query("executorId") || "";
    const force = c.req.query("refresh") === "1";
    const cwd = await repoPathOf(projectId);
    const remote = await isRemoteExecutor(agentType, executorId);
    return c.json(listSkills({ agentType, cwd, force, remote }));
  });

  api.get("/skills/overview", async (c) =>
    c.json(await skillsOverview(c.req.query("projectId") || "", false)),
  );
  api.post("/skills/rescan", async (c) =>
    c.json(await skillsOverview(c.req.query("projectId") || "", true)),
  );
}

// `/技能` 相关的三个只读端点。从 `routes.ts` 拆出来只有一个理由:那个文件到 700 行了。
//
// 扫哪儿 —— 项目仓库根(worktree 里的 `.claude/skills` 是同一份仓库内容的副本)。
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { agents, projects } from "./db/schema.js";
import { listSkills, scanOverview } from "./skills.js";

const repoPathOf = async (projectId: string): Promise<string> => {
  if (!projectId) return "";
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  return p?.repoPath ?? "";
};

// 设置页的「谁扫到了什么」。这里只负责把已注册的 profile 摊平交给 scanOverview,
// 「哪些 profile 算同一行」的规则在那边(按 CLI 类型归并)。
// force 时绕过 mtime 指纹,连 frontmatter 一起重读。
const skillsOverview = async (projectId: string, force: boolean) => {
  const cwd = await repoPathOf(projectId);
  const rows = await db.select().from(agents);
  const executors = rows.map((row) => ({ label: row.name, agentType: row.type }));
  // 一个 profile 都没注册时不给空白页:按 CLI 类型各列一行,至少让人看见扫得到什么。
  const fallback = ["claude", "codex", "gemini"].map((agentType) => ({ label: "", agentType }));
  return scanOverview({ cwd, executors: executors.length ? executors : fallback, force });
};

export function mountSkillRoutes(api: Hono): void {
  // 这个 CLI 现在能用哪些 `/技能`(给输入框的斜杠补全用)。
  api.get("/skills", async (c) => {
    const agentType = c.req.query("agentType") || "claude";
    const projectId = c.req.query("projectId") || "";
    const force = c.req.query("refresh") === "1";
    const cwd = await repoPathOf(projectId);
    return c.json(listSkills({ agentType, cwd, force }));
  });

  api.get("/skills/overview", async (c) =>
    c.json(await skillsOverview(c.req.query("projectId") || "", false)),
  );
  api.post("/skills/rescan", async (c) =>
    c.json(await skillsOverview(c.req.query("projectId") || "", true)),
  );
}

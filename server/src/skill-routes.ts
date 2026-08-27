// `/技能` 相关的三个只读端点。从 `routes.ts` 拆出来只有一个理由:那个文件到 700 行了。
//
// 扫哪儿 —— 项目仓库根(worktree 里的 `.claude/skills` 是同一份仓库内容的副本),
// 外加**当前这个人**的 CLI 配置目录(多人模式:`data/user-cli/<userId>/<agentType>/`;
// 自用模式:宿主机的 `~/.claude` 等,与本功能上线前一致)。
//
// 两处都不能少 userId:少了它,多人模式下 A 的斜杠补全会列出宿主机默认配置里的技能,
// 而那正是 §八 要抹掉的东西(第 1 轮审查 P1)。
import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { agents, projects } from "./db/schema.js";
import { listSkills, scanOverview } from "./skills.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { filterOwned } from "./auth/owned.js";
import { canSeeProject } from "./auth/visibility.js";

/**
 * 项目仓库根。**看不见的项目一律当不存在**:cwd 会原样出现在应答里(`realPath`),
 * 不过滤的话,拿 projectId 挨个试就能把别人项目的真实磁盘路径和项目级技能读出来。
 * 空 projectId 是正常用法(不限定项目,只扫个人/全局技能),返回空 cwd。
 */
const repoPathOf = async (c: Context, projectId: string): Promise<string | null> => {
  if (!projectId) return "";
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p || !(await canSeeProject(actorOf(c), p.id))) return null;
  return p.repoPath ?? "";
};

// 设置页的「谁扫到了什么」。这里只负责把已注册的 profile 摊平交给 scanOverview,
// 「哪些 profile 算同一行」的规则在那边(按 CLI 类型归并)。
// force 时绕过 mtime 指纹,连 frontmatter 一起重读。
const skillsOverview = async (c: Context, cwd: string, force: boolean) => {
  // 执行器是个人面资源:全量读会让设置页列出别人注册的 profile 名字。
  const rows = await filterOwned(await db.select().from(agents), actorOf(c));
  const executors = rows.map((row) => ({ label: row.name, agentType: row.type }));
  // 一个 profile 都没注册时不给空白页:按 CLI 类型各列一行,至少让人看见扫得到什么。
  const fallback = ["claude", "codex", "gemini"].map((agentType) => ({ label: "", agentType }));
  return scanOverview({
    cwd,
    executors: executors.length ? executors : fallback,
    force,
    userId: ownerIdOf(actorOf(c)),
  });
};

const noProject = { error: "project not found" } as const;

export function mountSkillRoutes(api: Hono): void {
  // 这个 CLI 现在能用哪些 `/技能`(给输入框的斜杠补全用)。
  api.get("/skills", async (c) => {
    const agentType = c.req.query("agentType") || "claude";
    const force = c.req.query("refresh") === "1";
    const cwd = await repoPathOf(c, c.req.query("projectId") || "");
    if (cwd === null) return c.json(noProject, 404);
    return c.json(listSkills({ agentType, cwd, force, userId: ownerIdOf(actorOf(c)) }));
  });

  api.get("/skills/overview", async (c) => {
    const cwd = await repoPathOf(c, c.req.query("projectId") || "");
    if (cwd === null) return c.json(noProject, 404);
    return c.json(await skillsOverview(c, cwd, false));
  });

  api.post("/skills/rescan", async (c) => {
    const cwd = await repoPathOf(c, c.req.query("projectId") || "");
    if (cwd === null) return c.json(noProject, 404);
    return c.json(await skillsOverview(c, cwd, true));
  });
}

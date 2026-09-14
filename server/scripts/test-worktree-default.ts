// 「设置 → 项目设置 → 工作目录」那颗开关必须真的**按项目**生效：某个项目关掉之后，
// 这个项目里任何一条没有显式说过 useWorktree 的普通创建路径都不许再偷偷开 worktree
// （界面上没有任何地方能解释那种任务为什么多出一个分支和一个目录），同时**不许波及
// 别的项目** —— 这正是它从系统级搬到项目级的全部意义。
//
// 这里逐条走真实创建路径（HTTP 单建 / 批量 / 群聊委派），而不是只测 createTasks 的默认
// 兜底：绕过兜底的写法是「在调用处写死 useWorktree: true」，只测兜底恰好看不见它。
// 两处刻意不跟随的显式语义（团队执行者继承调度台目录、非 git 项目开不出 worktree）
// 一并钉住，免得以后被当成漏网之鱼"顺手修掉"。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createClient } from "../src/db/node-sqlite-client.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-worktree-default-"));
const dbFile = join(root, "ash.db");
process.env.ASH_DB = dbFile;
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// 先摆一个**搬迁之前**的库：projects 还没有 use_worktree_default 这一列，全局开关关着，
// 多人模式下还有两份个人值。ensureSchema() 补列 + 跑数据迁移，存量项目必须原样接住
// 用户当初那个「关」，而不是被新列的 DEFAULT 1 顶成开 —— 否则升级当天所有项目的任务
// 会突然都开始拉 worktree。
const legacy = createClient({ url: dbFile });
await legacy.executeMultiple(`
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE user_settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL);
  INSERT INTO projects VALUES ('repo', 'Git 项目', '${join(root, "repo")}', '2026-09-01T00:00:00.000Z');
  INSERT INTO projects VALUES ('repo2', '另一个 Git 项目', '${join(root, "repo2")}', '2026-09-01T00:00:00.000Z');
  INSERT INTO projects VALUES ('plain', '非 Git 项目', '${join(root, "plain")}', '2026-09-01T00:00:00.000Z');
  INSERT INTO app_settings VALUES ('worktreeDefault', 'false');
  INSERT INTO user_settings VALUES ('alice', 'worktreeDefault', 'false');
  INSERT INTO user_settings VALUES ('bob', 'worktreeDefault', 'true');
`);
legacy.close();

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, groups, chatRooms, chatMessages } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
const { dispatchWorkers } = await import("../src/team/dispatch.js");
const { ChatService } = await import("../src/chat/service.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
mountGroupRoutes(api);
mountProjectRoutes(api);
const at = new Date().toISOString();

const repo = join(root, "repo");
const repo2 = join(root, "repo2");
for (const dir of [repo, repo2]) {
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "ignore" });
  git(dir, "config", "user.name", "Worktree Default Test");
  git(dir, "config", "user.email", "worktree@example.test");
  writeFileSync(join(dir, "seed.txt"), "seed");
  git(dir, "add", "--", "seed.txt");
  git(dir, "commit", "-m", "seed");
}
const plain = join(root, "plain");
execFileSync("mkdir", ["-p", plain]);

// 走真实的 PATCH /projects/:id —— 这一位是从界面上那颗开关落库的，只改 db 行会漏掉路由层。
const setDefault = async (projectId: string, on: boolean) => {
  const updated = await (await api.request(`/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ useWorktreeDefault: on }),
  })).json();
  assert.equal(updated.useWorktreeDefault, on, "PATCH /projects/:id 必须真的把这一位写进去并回读出来");
};
const createOne = async (projectId: string, body: Record<string, unknown> = {}) =>
  await (await api.request("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, title: "新任务", ...body }),
  })).json();

try {
  // ⓪ 搬迁：存量项目全部接住旧的全局值（关），全局那行随即删掉；多人模式下一人一份的
  //    个人值合并不出一个项目值（两个人可以设得相反），只能作废并在启动日志里说清楚。
  const migrated = await db.select().from(projects);
  assert.ok(migrated.length === 3 && migrated.every((project) => project.useWorktreeDefault === false),
    "存量项目必须接住旧的全局「关」，不能被新列的 DEFAULT 1 顶成开");
  const client = createClient({ url: dbFile });
  assert.equal((await client.execute("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'worktreeDefault'")).rows[0].n, 0,
    "旧的全局键必须删掉，否则下次启动又搬一遍、把用户后来的项目级设置冲掉");
  assert.equal((await client.execute("SELECT COUNT(*) AS n FROM user_settings WHERE key = 'worktreeDefault'")).rows[0].n, 0,
    "个人面那份也得作废");
  client.close();

  // ① HTTP 单建：没说就跟着**本项目**的开关走，两个方向都要跟。
  await setDefault("repo", false);
  assert.equal((await createOne("repo")).useWorktree, false, "项目里关掉后，新任务不该再开 worktree");
  await setDefault("repo", true);
  assert.equal((await createOne("repo")).useWorktree, true, "项目里开着时，新任务默认开 worktree");

  // ② 按项目各算各的 —— 这就是它不该住在系统级的理由：一个项目吃不住 worktree（构建脚本
  //    写死绝对路径之类）不代表别的项目也吃不住。
  await setDefault("repo", false);
  await setDefault("repo2", true);
  assert.equal((await createOne("repo")).useWorktree, false, "关掉的项目继续关着");
  assert.equal((await createOne("repo2")).useWorktree, true, "另一个项目不受影响，仍按它自己的默认开着");

  // ③ 显式选择永远赢过项目默认 —— 项目这一位是「默认」不是「强制」。
  assert.equal((await createOne("repo", { useWorktree: true })).useWorktree, true, "显式打开赢过项目关");
  await setDefault("repo", true);
  assert.equal((await createOne("repo", { useWorktree: false })).useWorktree, false, "显式关掉赢过项目开");

  // ④ 非 Git 项目无论如何开不出 worktree —— 开关管不着物理事实。
  await setDefault("plain", true);
  assert.equal((await createOne("plain")).useWorktree, false, "非 git 项目跟随默认也开不出 worktree");
  assert.equal((await createOne("plain", { useWorktree: true })).useWorktree, false, "非 git 项目显式要也开不出");

  // ⑤ 批量创建：defaults 没写 useWorktree 时同样跟随所在项目的开关。
  await db.insert(groups).values({ id: "batch", projectId: "repo", name: "批次", mode: "parallel", createdAt: at });
  await setDefault("repo", false);
  const batchOff = await (await api.request("/groups/batch/tasks/batch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: [{ title: "批一" }, { title: "批二" }] }),
  })).json();
  assert.ok(batchOff.tasks.length === 2 && batchOff.tasks.every((t: { useWorktree: boolean }) => !t.useWorktree),
    "批量创建也得跟着项目开关关掉");

  // ⑥ 群聊委派：走真实的 ChatService 结算路径。这条路曾经写死 useWorktree: true，
  //    表现是「项目里关了，唯独群聊派的任务还在开 worktree」。
  const member = { id: "chat-claude", name: "聊天 Claude", agentType: "claude" as const, executorId: null, model: null, reasoningEffort: null };
  const [room] = await db.insert(chatRooms).values({
    id: "room", projectId: "repo", name: "群聊", members: JSON.stringify([member]), createdAt: at,
  }).returning();
  const service = new ChatService(
    async () => ({ text: JSON.stringify({ reply: "已委派", task: { title: "群聊委派的任务", body: "去做" } }) }),
    async () => {},
  );
  await service.send(room, "@聊天 Claude 请实现功能", "chat-request", "用户");
  let chatTaskId: string | null = null;
  for (let attempt = 0; attempt < 200 && !chatTaskId; attempt++) {
    const reply = (await db.select().from(chatMessages).where(eq(chatMessages.roomId, room.id)))
      .find((message) => message.role === "agent");
    assert.notEqual(reply?.status, "failed", reply?.body);
    if (reply?.status === "done") chatTaskId = reply.taskId;
    else await delay(20);
  }
  assert.ok(chatTaskId, "群聊委派必须真的结算出一张任务");
  assert.equal((await (await api.request(`/tasks/${chatTaskId}`)).json()).useWorktree, false,
    "群聊委派出来的普通任务必须跟着项目开关，不能写死开 worktree");

  // ⑦ 团队执行者刻意不跟随：false 在它身上的意思是「继承调度台的共享目录」，
  //    不是「用户关掉了 worktree」。项目开着也不许把它顶成 true。
  await setDefault("repo", true);
  const lead = await createOne("repo", { title: "调度台", mode: "team" });
  await db.update(tasks).set({ mode: "team", status: "idle" }).where(eq(tasks.id, lead.id));
  await db.insert(sessions).values({ id: "lead-session", taskId: lead.id, role: "lead", agentType: "claude", executor: "claude", startedAt: at });
  const workers = await dispatchWorkers(lead.id, [{ title: "执行者", body: "干活" }], { run: false });
  assert.equal(workers.tasks[0].useWorktree, false, "团队执行者默认继承调度台目录，与项目开关无关");

  // ⑧ 全局那颗开关必须已经不存在：留着它就会有两个都像"默认"的地方，用户改了不生效的那个
  //    也没有任何反馈。（2026-09-14 从系统级搬到项目级。）
  const { getAppSettings } = await import("../src/app-settings.js");
  assert.ok(!("worktreeDefault" in (await getAppSettings() as Record<string, unknown>)),
    "worktreeDefault 已搬进项目行，AppSettings 里不该再有它");

  console.log("✓ 项目级 worktree 开关贯穿 HTTP 单建 / 批量 / 群聊委派，项目之间互不影响；显式选择、非 git 项目、团队执行者语义不受影响");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

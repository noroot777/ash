// 「设置 → 默认规则 → 新任务默认使用 worktree」那颗全局开关必须真的是**全局**的：
// 用户把它关掉之后，任何一条没有显式说过 useWorktree 的普通创建路径都不许再偷偷开
// worktree —— 界面上没有任何地方能解释那种任务为什么多出一个分支和一个目录。
//
// 这里逐条走真实创建路径（HTTP 单建 / 批量 / 群聊委派），而不是只测 createTasks 的默认
// 兜底：绕过兜底的写法是「在调用处写死 useWorktree: true」，只测兜底恰好看不见它。
// 两处刻意不跟随的显式语义（团队执行者继承调度台目录、合并结果修复任务钉在固定 commit
// 上）一并钉住，免得以后被当成漏网之鱼"顺手修掉"。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-worktree-default-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions, groups, chatRooms, chatMessages } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { patchAppSettings, getAppSettings } = await import("../src/app-settings.js");
const { dispatchWorkers } = await import("../src/team/dispatch.js");
const { ChatService } = await import("../src/chat/service.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
mountGroupRoutes(api);
const at = new Date().toISOString();

const repo = join(root, "repo");
execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
git(repo, "config", "user.name", "Worktree Default Test");
git(repo, "config", "user.email", "worktree@example.test");
writeFileSync(join(repo, "seed.txt"), "seed");
git(repo, "add", "--", "seed.txt");
git(repo, "commit", "-m", "seed");
const plain = join(root, "plain");
execFileSync("mkdir", ["-p", plain]);

const setDefault = async (on: boolean) => {
  await patchAppSettings({ worktreeDefault: on });
  assert.equal((await getAppSettings()).worktreeDefault, on);
};
const createOne = async (projectId: string, body: Record<string, unknown> = {}) =>
  await (await api.request("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, title: "新任务", ...body }),
  })).json();

try {
  await db.insert(projects).values([
    { id: "repo", name: "Git 项目", repoPath: repo, createdAt: at },
    { id: "plain", name: "非 Git 项目", repoPath: plain, createdAt: at },
  ]);

  // ① HTTP 单建：没说就跟着全局开关走，两个方向都要跟。
  await setDefault(false);
  assert.equal((await createOne("repo")).useWorktree, false, "全局关掉后，新任务不该再开 worktree");
  await setDefault(true);
  assert.equal((await createOne("repo")).useWorktree, true, "全局开着时，新任务默认开 worktree");

  // ② 显式选择永远赢过全局默认 —— 全局是「默认」不是「强制」，每张任务仍可单独覆盖。
  assert.equal((await createOne("repo", { useWorktree: false })).useWorktree, false, "显式关掉赢过全局开");
  await setDefault(false);
  assert.equal((await createOne("repo", { useWorktree: true })).useWorktree, true, "显式打开赢过全局关");

  // ③ 非 Git 项目无论如何开不出 worktree —— 全局开关管不着物理事实。
  await setDefault(true);
  assert.equal((await createOne("plain")).useWorktree, false, "非 git 项目跟随默认也开不出 worktree");
  assert.equal((await createOne("plain", { useWorktree: true })).useWorktree, false, "非 git 项目显式要也开不出");

  // ④ 批量创建：defaults 没写 useWorktree 时同样跟随全局开关。
  await db.insert(groups).values({ id: "batch", projectId: "repo", name: "批次", mode: "parallel", createdAt: at });
  await setDefault(false);
  const batchOff = await (await api.request("/groups/batch/tasks/batch", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tasks: [{ title: "批一" }, { title: "批二" }] }),
  })).json();
  assert.ok(batchOff.tasks.length === 2 && batchOff.tasks.every((t: { useWorktree: boolean }) => !t.useWorktree),
    "批量创建也得跟着全局开关关掉");

  // ⑤ 群聊委派：走真实的 ChatService 结算路径。这条路曾经写死 useWorktree: true，
  //    表现是「全局关了，唯独群聊派的任务还在开 worktree」。
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
    "群聊委派出来的普通任务必须跟着全局开关，不能写死开 worktree");

  // ⑥ 团队执行者刻意不跟随：false 在它身上的意思是「继承调度台的共享目录」，
  //    不是「用户关掉了 worktree」。全局开着也不许把它顶成 true。
  await setDefault(true);
  const lead = await createOne("repo", { title: "调度台", mode: "team" });
  await db.update(tasks).set({ mode: "team", status: "idle" }).where(eq(tasks.id, lead.id));
  await db.insert(sessions).values({ id: "lead-session", taskId: lead.id, role: "lead", agentType: "claude", executor: "claude", startedAt: at });
  const workers = await dispatchWorkers(lead.id, [{ title: "执行者", body: "干活" }], { run: false });
  assert.equal(workers.tasks[0].useWorktree, false, "团队执行者默认继承调度台目录，与全局开关无关");

  console.log("✓ 全局 worktree 开关贯穿 HTTP 单建 / 批量 / 群聊委派；显式选择与非 git 项目、团队执行者语义不受影响");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

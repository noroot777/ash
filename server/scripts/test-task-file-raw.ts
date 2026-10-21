// 「正文里那张图去哪儿取」的边界：`GET /tasks/:id/file/raw` 的 workspaceOnly 档。
//
// 为什么要单独钉一条：对话正文里的 `![](output/shot.png)` 是**相对 agent 自己工作目录**
// 写的，读的时候要去那个目录取（web/src/task-detail/turnImages.ts 的退路那一档）。而
// taskFileRoot 的最后一档会退到**项目主仓** —— 工作目录被清掉之后，同一个相对路径会解到
// 主仓里另一个任务留下的同名文件上，于是正文里画出一张完全不相干的图。「画错那张」比
// 「不画」坏得多（审查第 1 轮 F1 同一类错），所以那一档必须由服务端硬拒，不能靠调用点自觉。
//
// 跑：npm -w server run test:task-file-raw
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const stage = mkdtempSync(join(tmpdir(), "ash-file-raw-"));
const repo = join(stage, "repo");
const work = join(stage, "work");
process.env.ASH_DB = join(stage, "ash.db");

const [{ db, ensureSchema }, schema, { mountFileRoutes }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/file-routes.js"),
]);
const { projects, sessions, tasks } = schema;

try {
  // 主仓和工作目录里**各有一个同名文件**：这就是「退到主仓」会画错的那一幕。
  mkdirSync(join(repo, "output"), { recursive: true });
  mkdirSync(join(work, "output"), { recursive: true });
  writeFileSync(join(repo, "output", "shot.txt"), "主仓那一份");
  writeFileSync(join(work, "output", "shot.txt"), "任务自己那一份");
  writeFileSync(join(stage, "outside.txt"), "工作目录外面");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "raw", repoPath: repo, createdAt: at });
  await db.insert(tasks).values([
    { id: "live", projectId: "p", title: "目录还在", createdAt: at, updatedAt: at },
    { id: "gone", projectId: "p", title: "目录没了", createdAt: at, updatedAt: at },
  ]);
  // 只有 live 有一条带 cwd 的会话行；gone 什么都没有，于是只剩「退到主仓」那一档。
  await db.insert(sessions).values({
    id: "s1", taskId: "live", role: "single", agentType: "claude", executor: "claude", cwd: work, startedAt: at,
  });

  const api = new Hono();
  mountFileRoutes(api);
  const raw = (taskId: string, path: string, extra = "") =>
    api.request(`/tasks/${taskId}/file/raw?path=${encodeURIComponent(path)}${extra}`);

  // ① 目录还在：取到的必须是**任务自己那一份**。
  let response = await raw("live", "output/shot.txt", "&workspaceOnly=1");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "任务自己那一份");

  // ② 目录没了：硬拒。退到主仓会拿到同名的另一份内容，那比不画坏得多。
  response = await raw("gone", "output/shot.txt", "&workspaceOnly=1");
  assert.equal(response.status, 404, "工作目录已经不在时必须 404，不许退到项目主仓");
  assert.match((await response.json() as { error: string }).error, /工作目录/);

  // ③ 不带这个参数的照旧退到主仓：文件树、生成物那几处要的就是「退到主仓也让人看」，
  //    它们显示的是「这个任务的工作目录」本身，不会被当成正文里的某一句话。
  response = await raw("gone", "output/shot.txt");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "主仓那一份");

  // ④ 越界照旧拒（这一道本来就有，顺手钉住：加了参数不许反而松）。
  for (const path of ["../outside.txt", join(stage, "outside.txt")]) {
    response = await raw("live", path, "&workspaceOnly=1");
    assert.equal(response.status, 400, `越界路径必须拒：${path}`);
  }

  // ⑤ 绝对路径但落在工作目录**里面**：agent 常写全路径，这一支要服务得了。
  response = await raw("live", join(work, "output", "shot.txt"), "&workspaceOnly=1");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "任务自己那一份");

  console.log("任务工作目录原始字节(workspaceOnly)回归通过");
} finally {
  rmSync(stage, { recursive: true, force: true });
}

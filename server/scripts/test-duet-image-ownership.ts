// 讨论里 agent 说的那张图,**普通成员打不打得开**(审查第 2 轮 F4)。
//
// 症状:多人模式下普通成员看得到讨论任务、看得到结论正文,点结论里的图却是 404 —— 跟
// 「文件不存在」同一句话,前端连「该不该隐」都分不出。成因不在读端:`data/uploads` 是扁
// 平目录,授权靠 uploads 表的归属行(个人面 ownerUserId / 项目轴 taskId),没有登记行的文
// 件按**无主资产**处置,只有实例管理员读得到。单飞那条链在 single-run 的 persistTrace 里
// 登记、团队调度台在 team/lead-voice 的 traceLead 里登记,两处都挂在**写 trace** 上;讨论
// 自己写 transcript.jsonl、不走 appendSessionTrace,于是整条链一个字都没登记。
//
// 所以不变量改落在**公共发布口**(uploads.ts 的 watchAgentUploads):凡是作为 agent.event
// 广播出去的附件,归属已经登记 —— 判据从「有没有写 trace」换成「有没有要让人看见」,下一
// 条不写 trace 的新执行链也被兜住。这条测试钉的就是这个:
//   ① 讨论主发言者的 attachment → 普通成员由 404 变 200;
//   ② 包在**子智能体活动**里的那张(native tool activity)同样登记 —— 不能只管一种路径;
//   ③ 没有 path 的 attachment(「这处引用没存下副本」的交代)不许凭空造出一行归属;
//   ④ **这一道之前落盘的讨论**:读时间线时按回合自己记下的那份清单可重入地回填归属 ——
//      没有新广播就永远不会恢复(审查第 3 轮 R4)。正文里的路径一个都不认。
//
// 跑法(自带临时库):npm -w server run test:duet-image-ownership
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-duet-image-ownership-"));
process.env.ASH_DB ||= join(stage, "duet-image-ownership.db");
process.env.ASH_RUNS_DIR ||= join(stage, "runs");
process.env.ASH_UPLOADS_DIR ||= join(stage, "uploads");
requireTmpDb("test-duet-image-ownership");

// 碰库的模块一律 await import:静态 import 会被提升到设 ASH_DB 之前。
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, uploads } = await import("../src/db/schema.js");
const { RUNS_DIR, UPLOADS_DIR } = await import("../src/paths.js");
const { bus } = await import("../src/bus.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { api } = await import("../src/routes.js");

await ensureSchema();
mkdirSync(UPLOADS_DIR, { recursive: true });

// 挂真路由栈:`mountUploadRoutes` 同时装上归属登记那条网(两件事故意绑在一起)。
const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
app.route("/api", api);

const PIXELS = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const image = (name: string): string => {
  const file = `${name}-shot.png`;
  writeFileSync(join(UPLOADS_DIR, file), PIXELS);
  return join(UPLOADS_DIR, file);
};
const read = async (path: string, headers: Record<string, string>): Promise<number> => {
  const file = path.split(/[/\\]/).pop() ?? path;
  const res = await app.fetch(new Request(`http://127.0.0.1:4317/api/uploads/${encodeURIComponent(file)}`, { headers }));
  return res.status;
};
/** 登记是 fire-and-forget 的(失败只影响看得见看不见,不动摇这一轮产出),所以等一拍。 */
const settle = () => new Promise<void>((done) => setTimeout(done, 60));

const at = new Date().toISOString();
const repo = join(stage, "shared-repo");
mkdirSync(repo, { recursive: true });

try {
  await db.insert(projects).values([
    { id: "p-duet", name: "Duet", repoPath: repo, apiKeys: null, workflowId: null, createdAt: at, ownerUserId: null },
  ] as never);
  await db.insert(tasks).values([{
    id: "t-duet", projectId: "p-duet", title: "两版方案讨论", body: "讨论", mode: "duet",
    status: "running", createdAt: at, updatedAt: at, ownerUserId: null,
  }] as never);

  const root = join(stage, "root");
  for (const dir of ["alice", "bob"]) mkdirSync(join(root, dir), { recursive: true });
  await mode.setInstanceMode("multi", root);
  const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "Alice", gitEmail: "a@x", createdBy: null });
  const boss = await store.createUser({ name: "bob", role: "admin", dirName: "bob", gitName: "Bob", gitEmail: "b@x", createdBy: null });
  // 普通成员**看得见这个项目**(也就看得见里面的讨论任务):这一条先立住,后面那个 404
  // 才只可能是附件归属造成的,而不是「他压根看不到这个任务」。
  await visibility.addProjectMember({ projectId: "p-duet", userId: alice.id, role: "member", addedBy: boss.id });
  const AS_ALICE = { authorization: `Bearer ${await store.resetUserKey(alice.id)}` };

  const main = image("duet-main");
  const sub = image("duet-sub");
  const orphan = image("duet-orphan");

  // ① 登记之前:普通成员读不到(失败关闭)。这正是用户看到的那一幕。
  assert.equal(await read(main, AS_ALICE), 404, "没有归属行的附件对普通成员必须是 404");

  // 讨论那条链真实广播的事件形状(duet/turn.ts:`bus.publish({type:"agent.event",…})`)。
  bus.publish({
    type: "agent.event", taskId: "t-duet", sessionId: "s-duet", role: "duetA",
    event: { kind: "attachment", path: main, source: "output/shot.png", ref: 0 },
  } as never);
  // ② 子智能体那张:包在 native tool activity 里,同一个入口必须也认。
  bus.publish({
    type: "agent.event", taskId: "t-duet", sessionId: "s-duet", role: "duetA",
    event: {
      kind: "tool", name: "Task", detail: "子智能体",
      nativeWork: { type: "activity", event: { kind: "attachment", path: sub, source: "output/sub.png", ref: 1 } },
    },
  } as never);
  // ③ 没有 path 的交代:不许凭空造出一行归属(否则「引用即认领」那条路又开了)。
  bus.publish({
    type: "agent.event", taskId: "t-duet", sessionId: "s-duet", role: "duetA",
    event: { kind: "attachment", source: "output/gone.png", ref: 2 },
  } as never);
  await settle();

  assert.equal(await read(main, AS_ALICE), 200, "讨论主发言者的图:登记之后普通成员就该打得开");
  assert.equal(await read(sub, AS_ALICE), 200, "子智能体活动里那张同样要登记");
  assert.equal(await read(orphan, AS_ALICE), 404, "没广播过的文件不受影响(失败关闭那一档不许被放宽)");

  const rows = await db.select().from(uploads).where(eq(uploads.taskId, "t-duet"));
  assert.deepEqual(
    rows.map((row) => row.file).sort(),
    ["duet-main-shot.png", "duet-sub-shot.png"],
    "恰好两行归属:没有 path 的那条交代不该造出第三行",
  );

  // ── R4:登记那一道是后来才补的,**它之前落盘的讨论**谁来救 ────────────────────
  // 图还在 uploads 目录里、回合记录里也写着它的路径,只有 uploads 那一行没有 taskId ——
  // 没有新广播就永远不会恢复(审查第 3 轮 R4)。所以读讨论时间线这一侧按**回合自己记下
  // 的那份清单**可重入地回填(duet/transcript-reads.ts)。
  await db.insert(tasks).values([{
    id: "t-duet-old", projectId: "p-duet", title: "升级前的讨论", body: "旧讨论", mode: "duet",
    status: "done", createdAt: at, updatedAt: at, ownerUserId: null,
  }] as never);
  const legacy = image("duet-legacy");
  const bodyOnly = image("duet-body-only");
  const privateShot = image("duet-private");
  // 别人名下的私有附件:回填一个字都不许动它(先到先得,见 registerUpload)。
  await db.insert(uploads).values([
    { file: "duet-private-shot.png", ownerUserId: boss.id, taskId: null, createdAt: at },
  ] as never);
  const oldRuns = join(RUNS_DIR, "t-duet-old");
  mkdirSync(oldRuns, { recursive: true });
  writeFileSync(join(oldRuns, "transcript.jsonl"), [
    JSON.stringify({
      type: "debate.turn", round: 1, speaker: "duetA", text: `方案一的样子:\n\n![图](${legacy})`,
      // 正文里还提了另一个 uploads 文件,但**回合清单里没有它** —— 正文路径一个都不认,
      // 不然就是一条「引用即认领」的路(bindUploadsToTask 的注释里有这条推演)。
      images: [
        { path: legacy, source: "output/legacy.png", ref: 0 },
        { path: privateShot, source: "output/private.png", ref: 1 },
        // uploads 目录之外的路径(仓库里的文件)不该被当成附件登记。
        { path: join(repo, "README.md"), source: "README.md", ref: 2 },
      ],
      at,
    }),
    JSON.stringify({ type: "debate.turn", round: 2, speaker: "duetB", text: `另一张:${bodyOnly}`, at }),
  ].join("\n") + "\n");

  assert.equal(await read(legacy, AS_ALICE), 404, "回填之前:存量讨论的图对普通成员就是 404");
  const timeline = await app.fetch(
    new Request("http://127.0.0.1:4317/api/tasks/t-duet-old/duet", { headers: AS_ALICE }),
  );
  assert.equal(timeline.status, 200);
  const turns = await timeline.json() as { type: string }[];
  assert.deepEqual(turns.map((turn) => turn.type), ["duet.turn", "duet.turn"], "老事件名照旧归一成 duet.*");
  assert.equal(await read(legacy, AS_ALICE), 200, "读过那条讨论之后,回合清单里的图普通成员就该打得开");
  assert.equal(await read(bodyOnly, AS_ALICE), 404, "只在正文里出现的路径不认 —— 那是「引用即认领」");
  assert.equal(await read(privateShot, AS_ALICE), 404, "别人名下的私有附件不许被回填挂上任务");
  const legacyRows = await db.select().from(uploads).where(eq(uploads.taskId, "t-duet-old"));
  assert.deepEqual(
    legacyRows.map((row) => row.file).sort(),
    ["duet-legacy-shot.png"],
    "恰好回填那一行:仓库里的路径和别人名下的私有行都不该进来",
  );
  // 可重入:再读一遍不许多出行、也不许改掉已有归属。
  const before = (await db.select().from(uploads)).length;
  await app.fetch(new Request("http://127.0.0.1:4317/api/tasks/t-duet-old/duet", { headers: AS_ALICE }));
  assert.equal(
    (await db.select().from(uploads).where(eq(uploads.file, "duet-private-shot.png"))).at(0)?.taskId,
    null,
    "重入一次也不许把私有行挂上来",
  );
  assert.equal((await db.select().from(uploads)).length, before, "重入不该多出任何一行");

  console.log("讨论图片归属登记回归通过(主发言者 + 子智能体 + 无副本交代 + 存量讨论读时回填)");
} finally {
  releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

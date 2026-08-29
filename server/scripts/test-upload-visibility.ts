// 上传附件的**授权面**回归(§八)。
//
// 第 3 轮审查 P1 实测:`/api/uploads/:file` 只认「登录了没」,不认「这文件是谁的」。
// 于是多人模式下,任何一个登录用户只要拿到文件名(聊天记录、截图、导出包、日志里都
// 可能出现),就能读到别人**私有随手记**的附件正文 —— `/api/notes` 那两条轴白过了。
//
// 判据现在在 `server/src/uploads.ts`:个人面(上传者本人)+ 项目轴(附到的任务看得见)。
// 这条测试钉住八件事:
//   ① 泄露本身没了,而且**实例管理员也读不到**别人的私有附件(个人面没有特权);
//   ② 别收过头:同项目的人照常打得开会话里的图,自用模式整条判据透明;
//   ③ **绑定不能被拿来越权**:把别人的附件路径写进自己任务的 attachments,
//      不会给它敞开一条项目轴的读路;
//   ④ 存量文件:转多人时按任务正文回填归属,没登记的一律只有管理员读得到(失败关闭);
//   ⑤ **引用一次不算认领**:没登记的文件被任务 attachments 引用后仍是失败关闭那一档;
//   ⑥ 派生任务里归属继承父任务、授权仍看动手的人 —— 上传者本人不该被自己的附件挡在外面;
//   ⑦ 接力落地的附件撞上本机同名的私有文件:正文里写着的那份,任务里的人就得打得开,
//      而本机那份私有附件仍旧只有本人能读;
//   ⑧ **出境也要过同一条判据**:把别人的私有附件路径写进自己看得见的任务再接力出去,
//      导出侧不打包它的字节。
//
// 一律走真 Request 打进 `authGate → resourceGate → personalWriteGate → 路由` 的完整栈。
//
// 跑法(自带临时库):
//   npm -w server run test:upload-visibility
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-upload-visibility-"));
process.env.ASH_DB ||= join(stage, "upload-visibility.db");
process.env.ASH_RUNS_DIR ||= join(stage, "runs");
process.env.ASH_UPLOADS_DIR ||= join(stage, "uploads");
requireTmpDb("test-upload-visibility");

// 碰库的模块一律 await import:静态 import 会被提升到设 ASH_DB 之前,那样连的是真库。
const { db, ensureSchema } = await import("../src/db/index.js");
const { notes, projects, tasks } = await import("../src/db/schema.js");
const { UPLOADS_DIR } = await import("../src/paths.js");
const mode = await import("../src/auth/mode.js");
const store = await import("../src/auth/store.js");
const visibility = await import("../src/auth/visibility.js");
const { claimExistingDataFor } = await import("../src/auth/conversion.js");
const { Hono } = await import("hono");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { personalWriteGate } = await import("../src/auth/personal-gate.js");
const { api } = await import("../src/routes.js");

await ensureSchema();
mkdirSync(UPLOADS_DIR, { recursive: true });

const app = new Hono();
app.use("*", authGate());
app.use("/api/*", resourceGate());
app.use("/api/*", personalWriteGate());
app.route("/api", api);

type Reply = { status: number; json: Record<string, unknown>; list: Record<string, unknown>[]; text: string };
const call = async (path: string, method: string, headers: Record<string, string>, body?: unknown): Promise<Reply> => {
  const res = await app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  let parsed: unknown = {};
  try { parsed = JSON.parse(text); } catch { /* 附件本体不是 JSON */ }
  return {
    status: res.status,
    json: Array.isArray(parsed) ? {} : (parsed as Record<string, unknown>),
    list: Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [],
    text,
  };
};

const upload = async (headers: Record<string, string>, name: string, content: string): Promise<{ file: string; path: string }> => {
  const dataUrl = `data:text/plain;base64,${Buffer.from(content, "utf8").toString("base64")}`;
  const res = await call("/api/uploads", "POST", headers, { dataUrl, name });
  assert.equal(res.status, 200, `上传该成功:${res.text}`);
  return { file: String(res.json.id), path: String(res.json.path) };
};

const get = (file: string, headers: Record<string, string>) =>
  call(`/api/uploads/${encodeURIComponent(file)}`, "GET", headers);

const BOB_SECRET = "bob-private-upload-secret-39f2";
const ALICE_TASK_SECRET = "alice-task-upload-3ba7";
const LEGACY_SECRET = "legacy-upload-secret-5c1d";
const LATE_SECRET = "late-unregistered-secret-62fd";
const IMPORTED_BODY = "handoff-landed-body-8ae1";
const CHILD_SECRET = "bob-child-task-upload-7d40";
const HANDOFF_SECRET = "peer-sent-same-name-1c9e";
const EXPORT_SECRET = "bob-never-bound-export-4b81";

const at = new Date().toISOString();
const repo = join(stage, "shared-repo");
const otherRepo = join(stage, "other-repo");
mkdirSync(repo, { recursive: true });
mkdirSync(otherRepo, { recursive: true });

try {
  await db.insert(projects).values([
    { id: "p-shared", name: "Shared", repoPath: repo, apiKeys: null, workflowId: null, createdAt: at, ownerUserId: null },
    { id: "p-other", name: "Other", repoPath: otherRepo, apiKeys: null, workflowId: null, createdAt: at, ownerUserId: null },
  ] as never);

  // ── ⓪ 自用模式:整条判据透明 ──────────────────────────────────────────
  const legacy = await upload({}, "legacy.txt", LEGACY_SECRET);
  assert.equal((await get(legacy.file, {})).text, LEGACY_SECRET, "自用模式下附件照常读得到");
  // 老任务把附件路径写在正文里(attachmentsPrompt 的形态) —— 转换时按它回填归属。
  await db.insert(tasks).values([{
    id: "t-legacy", projectId: "p-shared", title: "legacy task",
    body: `旧任务\n\n[用户附带的文件]\n- ${legacy.path}`,
    status: "backlog", createdAt: at, updatedAt: at, ownerUserId: null,
  }] as never);
  // 谁都没引用过的存量文件:转换后只有管理员读得到。
  writeFileSync(join(UPLOADS_DIR, "orphan-legacy.txt"), "orphan-legacy-body");

  // ── 转多人 + 认领存量 ────────────────────────────────────────────────
  const root = join(stage, "root");
  for (const dir of ["alice", "bob", "carol", "boss"]) mkdirSync(join(root, dir), { recursive: true });
  await mode.setInstanceMode("multi", root);
  const alice = await store.createUser({ name: "alice", role: "member", dirName: "alice", gitName: "Alice", gitEmail: "a@x", createdBy: null });
  const bob = await store.createUser({ name: "bob", role: "member", dirName: "bob", gitName: "Bob", gitEmail: "b@x", createdBy: null });
  const carol = await store.createUser({ name: "carol", role: "member", dirName: "carol", gitName: "Carol", gitEmail: "c@x", createdBy: null });
  const boss = await store.createUser({ name: "boss", role: "admin", dirName: "boss", gitName: "Boss", gitEmail: "s@x", createdBy: null });
  const AS_ALICE = { authorization: `Bearer ${await store.resetUserKey(alice.id)}` };
  const AS_BOB = { authorization: `Bearer ${await store.resetUserKey(bob.id)}` };
  const AS_CAROL = { authorization: `Bearer ${await store.resetUserKey(carol.id)}` };
  const AS_BOSS = { authorization: `Bearer ${await store.resetUserKey(boss.id)}` };
  await claimExistingDataFor(boss.id);
  await visibility.addProjectMember({ projectId: "p-shared", userId: alice.id, role: "member", addedBy: boss.id });
  await visibility.addProjectMember({ projectId: "p-shared", userId: bob.id, role: "member", addedBy: boss.id });
  await visibility.addProjectMember({ projectId: "p-other", userId: carol.id, role: "member", addedBy: boss.id });

  // ── ① 私有随手记的附件:除了本人,谁都读不到 ────────────────────────────
  const bobFile = await upload(AS_BOB, "secret.txt", BOB_SECRET);
  await db.insert(notes).values([{
    id: "note-bob", projectId: "p-shared", body: "bob 的私有随手记",
    attachments: JSON.stringify([bobFile.path]), ownerUserId: bob.id,
    createdAt: Date.parse(at), updatedAt: Date.parse(at),
  }] as never);

  const aliceNotes = await call("/api/notes?projectId=p-shared", "GET", AS_ALICE);
  assert.equal(aliceNotes.list.some((row) => row.id === "note-bob"), false, `Alice 看不到 Bob 的随手记:${aliceNotes.text}`);

  assert.equal((await get(bobFile.file, AS_BOB)).text, BOB_SECRET, "Bob 得读得到自己上传的附件");
  for (const [who, headers] of [["Alice(同项目成员)", AS_ALICE], ["实例管理员", AS_BOSS]] as const) {
    const res = await get(bobFile.file, headers);
    assert.equal(res.status, 404, `${who}不该读到 Bob 的私有附件:${res.status}`);
    assert.equal(res.text.includes(BOB_SECRET), false, `拒了就一个字都不许漏:${res.text}`);
  }

  // ── ② 任务附件走项目轴:同项目的人照常打得开 ────────────────────────────
  const aliceFile = await upload(AS_ALICE, "shot.txt", ALICE_TASK_SECRET);
  const created = await call("/api/tasks", "POST", AS_ALICE, {
    projectId: "p-shared", title: "带附件的任务", body: "看图", attachments: [aliceFile.path], useWorktree: false,
  });
  assert.equal(created.status, 201, `建任务该成功:${created.text}`);
  assert.equal((await get(aliceFile.file, AS_BOB)).text, ALICE_TASK_SECRET, "同项目的人得打得开会话里的图");
  assert.equal((await get(aliceFile.file, AS_CAROL)).status, 404, "不是这个项目的成员就不该读到");

  // ── ③ 绑定不能被拿来越权 ──────────────────────────────────────────────
  // Alice 把 Bob 私有附件的路径写进自己任务的 attachments:请求本身不报错(路径是不是
  // 有效附件不归任务接口判),但那个文件的归属一动不动 —— 否则「引用一次」就等于
  // 把别人的东西挂进一个大家都看得见的项目。
  const hijack = await call("/api/tasks", "POST", AS_ALICE, {
    projectId: "p-shared", title: "借花献佛", body: "看图", attachments: [bobFile.path], useWorktree: false,
  });
  assert.equal(hijack.status, 201, `建任务该成功:${hijack.text}`);
  for (const [who, headers] of [["Alice", AS_ALICE], ["Carol", AS_CAROL], ["管理员", AS_BOSS]] as const) {
    const res = await get(bobFile.file, headers);
    assert.equal(res.status, 404, `${who}不该因为一次引用就读到 Bob 的私有附件:${res.text}`);
  }
  assert.equal((await get(bobFile.file, AS_BOB)).text, BOB_SECRET, "Bob 自己照常读得到");

  // ── ④ 存量文件 ───────────────────────────────────────────────────────
  // 转换时按任务正文回填了 taskId,所以老任务的截图对项目成员照常可见。
  assert.equal((await get(legacy.file, AS_ALICE)).text, LEGACY_SECRET, "老任务里的附件该对项目成员可见");
  // 没人引用过的存量文件归管理员(§十三「存量资源全部归初始管理员」)。
  assert.equal((await get("orphan-legacy.txt", AS_ALICE)).status, 404, "无人引用的存量文件不该对成员敞开");
  assert.equal((await get("orphan-legacy.txt", AS_BOSS)).text, "orphan-legacy-body", "存量文件归初始管理员");
  // 压根没登记的文件(哪条写盘路径漏了登记):失败方向是拒绝,不是放行。
  writeFileSync(join(UPLOADS_DIR, "unregistered.txt"), "unregistered-body");
  assert.equal((await get("unregistered.txt", AS_ALICE)).status, 404, "没登记的文件不许对普通成员放行");
  assert.equal((await get("unregistered.txt", AS_BOSS)).status, 200, "没登记的文件按无主资产归管理员");

  // ── ⑤ 「引用一次」不算认领 ────────────────────────────────────────────
  // 未登记的文件(上传写盘后崩在登记前、或哪条写盘路径漏了登记)一旦能被任务
  // attachments 认领,失败关闭就当场翻成失败打开:随便写一个名字就把它变成自己的、
  // 还顺带敞开给整个项目(第 4 轮审查 P2)。两种形态都试:裸文件名与绝对路径。
  writeFileSync(join(UPLOADS_DIR, "late-unregistered.txt"), LATE_SECRET);
  writeFileSync(join(UPLOADS_DIR, "late-by-path.txt"), LATE_SECRET);
  assert.equal((await get("late-unregistered.txt", AS_ALICE)).status, 404, "认领之前本来就读不到");
  const claim = await call("/api/tasks", "POST", AS_ALICE, {
    projectId: "p-shared", title: "借个名字", body: "看图", useWorktree: false,
    attachments: ["late-unregistered.txt", join(UPLOADS_DIR, "late-by-path.txt")],
  });
  assert.equal(claim.status, 201, `建任务该成功:${claim.text}`);
  for (const file of ["late-unregistered.txt", "late-by-path.txt"]) {
    for (const [who, headers] of [["Alice(引用的人)", AS_ALICE], ["Bob(同项目)", AS_BOB], ["Carol", AS_CAROL]] as const) {
      const res = await get(file, headers);
      assert.equal(res.status, 404, `${who}不该靠一次引用认领 ${file}:${res.text}`);
      assert.equal(res.text.includes(LATE_SECRET), false, `拒了就一个字都不许漏:${res.text}`);
    }
    assert.equal((await get(file, AS_BOSS)).text, LATE_SECRET, `${file} 仍是管理员那一档`);
  }

  // 别把登记能力一起砍掉:接力落地那条路**是它自己写下的字节**,照样得建登记行,
  // 否则接力过来的会话里那些图对项目成员全打不开。
  const { registerUpload, registerUploads } = await import("../src/uploads.js");
  writeFileSync(join(UPLOADS_DIR, "imported.txt"), IMPORTED_BODY);
  await registerUploads(["imported.txt"], { taskId: String(created.json.id) });
  assert.equal((await get("imported.txt", AS_BOB)).text, IMPORTED_BODY, "接力落地的附件该跟着任务对成员可见");
  assert.equal((await get("imported.txt", AS_CAROL)).status, 404, "但仍只限那个任务看得见的人");

  // 登记这道口也得认人:给一条**有主**的行补 taskId,等于把别人的私有附件敞开给那条
  // 任务看得见的所有人 —— 接力导入曾借这一句挂走同名的私有行(第 5 轮审查 P1 第二层)。
  await registerUpload(bobFile.file, { taskId: String(created.json.id) });
  assert.equal((await get(bobFile.file, AS_ALICE)).status, 404, "替别人补 taskId 不算数");
  // 但本人自己把附件挂进任务照常生效,别把这道口一起焊死。
  await registerUpload(bobFile.file, { ownerUserId: bob.id, taskId: String(created.json.id) });
  assert.equal((await get(bobFile.file, AS_ALICE)).text, BOB_SECRET, "本人挂上去之后,任务看得见的人就该打得开");

  // ── ⑥ 派生任务:归属继承父任务,授权仍看动手的人 ────────────────────────
  // Bob 在 Alice 的任务下开一条子任务、附上自己刚传的图:子任务归属按 §八 继承 Alice,
  // 但附件是 Bob 的。按继承后的归属人判绑定,会把上传者本人挡在门外 —— 正文里明明
  // 写着附件路径,任务看得见的人(连 Bob 自己所在的项目)全打不开(第 5 轮审查 P2)。
  const parent = await call("/api/tasks", "POST", AS_ALICE, {
    projectId: "p-shared", title: "父任务", body: "父", useWorktree: false,
  });
  assert.equal(parent.status, 201, `建父任务该成功:${parent.text}`);
  const bobChild = await upload(AS_BOB, "child.txt", CHILD_SECRET);
  const child = await call("/api/tasks", "POST", AS_BOB, {
    projectId: "p-shared", title: "子任务", body: "看图", parentId: parent.json.id,
    attachments: [bobChild.path], useWorktree: false,
  });
  assert.equal(child.status, 201, `建子任务该成功:${child.text}`);
  const childRow = (await db.select().from(tasks).where(eq(tasks.id, String(child.json.id)))).at(0)!;
  assert.equal(childRow.ownerUserId, alice.id, "派生任务的归属仍继承父任务(别把 P2 修成改归属)");
  assert.equal((await get(bobChild.file, AS_BOB)).text, CHILD_SECRET, "上传者本人照常读得到");
  assert.equal((await get(bobChild.file, AS_ALICE)).text, CHILD_SECRET, "正文里写着路径,任务看得见的人就该打得开");
  assert.equal((await get(bobChild.file, AS_CAROL)).status, 404, "但仍只限这个项目");

  // ── ⑦ 接力落地:正文里写着的附件,任务里的人就得打得开 ─────────────────────
  // 撞名时复用本机那一份看着最省事,但本机那份可能是**别人的私有附件**:导入报告说
  // 「附件已迁移」、正文也改写成了本机路径,任务里的人却打不开(第 6 轮审查 P2)。
  // 字节相同也一样 —— 能不能读取决于那条无关的旧登记,不是这条任务。
  const { importHandoff } = await import("../src/handoff-import.js");
  const { scanUploadNames } = await import("../src/handoff-uploads.js");
  const bobPrivate = await upload(AS_BOB, "share.txt", HANDOFF_SECRET);
  const peerPath = `/peer/data/uploads/${bobPrivate.file}`;
  const handoffTaskId = "handoff-upload-vis-01";
  await importHandoff({
    version: 1, sourceHost: "peer", sourceFingerprint: "a".repeat(64), originFingerprint: "a".repeat(64),
    sourceWorkspace: null, targetProjectId: "p-shared", autoResume: false, git: null,
    transferId: "transfer-upload-vis-1",
    task: { id: handoffTaskId, title: "接来的任务", body: `远端附件 ${peerPath}`, status: "paused", createdAt: at },
    sessions: [],
    // 同名**同内容**:第 6 轮的触发条件。
    uploads: [{ name: bobPrivate.file, sourcePath: peerPath, dataBase64: Buffer.from(HANDOFF_SECRET, "utf8").toString("base64") }],
    files: [],
  }, { ownerUserId: alice.id });
  const handoffBody = (await db.select().from(tasks).where(eq(tasks.id, handoffTaskId))).at(0)!.body!;
  const landed = [...scanUploadNames(handoffBody)].filter((name) => name !== bobPrivate.file);
  assert.equal(landed.length, 1, `正文该指向这条接力任务自己的那一份:${handoffBody}`);
  assert.equal((await get(landed[0]!, AS_ALICE)).text, HANDOFF_SECRET, "接力任务里的人得打得开正文写的附件");
  assert.equal((await get(landed[0]!, AS_CAROL)).status, 404, "项目外仍读不到");
  // Bob 那份私有附件半点没变:内容一样不等于可以拿他的登记行顶账。
  assert.equal((await get(bobPrivate.file, AS_BOB)).text, HANDOFF_SECRET, "Bob 自己照常读得到");
  assert.equal((await get(bobPrivate.file, AS_ALICE)).status, 404, "他那份仍是私有的");

  // ── ⑧ 出境的字节:导出侧按「导出的人读不读得到」筛 ─────────────────────────
  // 附件路径会顺着日志、粘贴的 prompt、截图流到任何人手上。把一个别人的文件名写进
  // 自己看得见的任务再接力出去,导出侧照着正文扫名字打包 —— 私有附件的**内容**就这么
  // 出境了(8CEbm0rJQIwK 第 1 轮审查 P1)。判据不新造:能不能带走 == 本机能不能打开。
  const { collectUploads } = await import("../src/handoff-uploads.js");
  const { readableUploads } = await import("../src/uploads.js");
  const bobExport = await upload(AS_BOB, "export-secret.txt", EXPORT_SECRET);
  assert.equal((await get(bobExport.file, AS_ALICE)).status, 404, "前提:这份私有附件 Alice 本来就读不到");
  const exportText = `任务正文引用 ${bobExport.path} 和 ${aliceFile.path}`;
  const aliceNotesOut: string[] = [];
  const alicePack = await collectUploads([exportText], aliceNotesOut, false, await readableUploads(alice.id));
  assert.deepEqual(
    alicePack.map((u) => u.name).sort(),
    [aliceFile.file],
    `Alice 只该带走自己读得到的那份:${JSON.stringify(alicePack.map((u) => u.name))}`,
  );
  assert.equal(
    alicePack.some((u) => Buffer.from(u.dataBase64, "base64").toString("utf8").includes(EXPORT_SECRET)),
    false,
    "别人的私有附件一个字节都不许进载荷",
  );
  assert.ok(
    aliceNotesOut.some((note) => note.includes(bobExport.file)),
    `被拦下的要如实记进 notes:${JSON.stringify(aliceNotesOut)}`,
  );
  // 别收过头:本人导出自己的附件照常带走。
  const bobPack = await collectUploads([exportText], [], false, await readableUploads(bob.id));
  assert.ok(bobPack.some((u) => u.name === bobExport.file), "Bob 自己导出时照常带得走");
  // 认不出人(出站链路没带身份)就一个都不带:失败方向是少带,不是越权。
  const blindPack = await collectUploads([exportText], [], false, await readableUploads(null));
  assert.deepEqual(blindPack.map((u) => u.name), [], "认不出身份就不该带走任何附件");

  console.log("upload visibility ok(个人面 + 项目轴 + 越权绑定 + 引用不算认领 + 派生任务 + 接力落地 + 出境打包 + 存量认领)");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

// 任务接力——单进程回归(进程内直调导入,不 spawn 对端 server):
//   1. 上下文感知的附件路径改写纯函数:POSIX 源机 → Windows 目标机时,原始/JSON 转义
//      两种形态的 from 相同、to 不同(歧义),必须按文本上下文分组替换——纯文本得原始
//      形态,JSONL 改完仍是合法 JSON,.md 混排文本逐行判断(markdown 行用原始形态、
//      哨兵 JSON 行用转义形态);非歧义方向(POSIX→POSIX)行为与全局替换一致
//   2. Windows 源机的附件路径:原始/JSON 转义两种形态都改写成本机路径,JSONL 改完
//      仍是合法 JSON——只改原始形态会漏掉 Windows 源机的全部会话引用
//   3. 幂等收口如实报 in 标记里存的 autoResume 事实(而不是本次请求参数),
//      老标记没这字段按 false 报(不谎报已续跑)
//   4. 队列成员禁止接力:预检/导出双入口 409 且发生在停任务之前——running 队列头
//      不被停,backlog 后继绝不启动。否则导出把队列头结算成 canceled,队列推进
//      对 canceled 透明跳过,源机会提前拉起后继,与目标机上的当前步骤并行
// 双机走真 HTTP 的端到端场景在 test-handoff.ts。HARNESS_RUNS_DIR 指到临时目录顺带
// 打开 guardAgentSpawn,即使哪里失手触发续跑也不会真拉起 CLI 烧额度。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeRepo } from "./handoff-test-utils.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "harness-handoff-local-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.HARNESS_DB = join(root, "local.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs");
process.env.HARNESS_UPLOADS_DIR = join(root, "uploads");
assert.ok(
  process.env.HARNESS_ALLOW_REAL_AGENT !== "1",
  "本测试靠 guardAgentSpawn 兜底拦真 CLI;拦截器一失效就会烧用户的真额度",
);

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, queueItems, sessions, tasks } = await import("../src/db/schema.js");
  const { importHandoff } = await import("../src/handoff-import.js");
  const { applyUploadRewrites, buildUploadRewrites } = await import("../src/handoff-uploads.js");
  await ensureSchema();

  // ── 1. 纯函数:POSIX 源机 → Windows 目标机的上下文感知改写 ────────────────
  // 缺陷形态(第 2 轮审查实测):POSIX 路径没有需转义字符,两种形态的 from 完全相同,
  // 无上下文的全局替换把原始 Windows 路径(单反斜杠)写进 JSONL 字符串 → 非法 JSON。
  const posixSrc = "/private/tmp/source/data/uploads/abc-proof.txt";
  const winDir = "D:\\harness\\data\\uploads";
  const winRaw = `${winDir}\\abc-proof.txt`;
  const rw = buildUploadRewrites([{ name: "abc-proof.txt", sourcePath: posixSrc, dataBase64: "" }], winDir);
  assert.equal(rw.ambiguous, true, "POSIX from 两种形态相同、Windows to 不同,必须标记歧义");
  assert.equal(
    applyUploadRewrites(`看附件:${posixSrc}`, rw, "plain"),
    `看附件:${winRaw}`,
    "纯文本上下文应改写成原始形态(单反斜杠)",
  );
  const jsonl = JSON.stringify({ type: "user", text: `附件在 ${posixSrc}` });
  const jsonlOut = applyUploadRewrites(jsonl, rw, "json");
  assert.ok(
    (JSON.parse(jsonlOut) as { text: string }).text.includes(winRaw),
    "JSONL 改完必须仍是合法 JSON,解析出的值是原始 Windows 路径",
  );
  // transcript .md 是 markdown 正文 + "\x1e{json}" 哨兵行的混排文本,逐行选组。
  const sentinel = `\x1e${JSON.stringify({ t: "system", text: `附件 ${posixSrc}` })}`;
  const mixedOut = applyUploadRewrites(`# 标题\n正文引用 ${posixSrc}\n${sentinel}`, rw, "plain").split("\n");
  assert.ok(mixedOut[1]!.includes(winRaw), "markdown 行应改写成原始形态");
  assert.ok(
    (JSON.parse(mixedOut[2]!.slice(1)) as { text: string }).text.includes(winRaw),
    "哨兵 JSON 行改完必须仍可解析,值是原始 Windows 路径",
  );
  // 非歧义方向(POSIX→POSIX)行为不变:两种形态相同,直接全局替换。
  const rwPosix = buildUploadRewrites([{ name: "abc-proof.txt", sourcePath: posixSrc, dataBase64: "" }], "/data/uploads");
  assert.equal(rwPosix.ambiguous, false);
  assert.equal(
    applyUploadRewrites(`附件:${posixSrc}`, rwPosix, "plain"),
    "附件:/data/uploads/abc-proof.txt",
  );

  // ── 2. Windows 源机的附件路径:原始/转义两种形态都改写 ────────────────────
  // 进程内直调 importHandoff,附件写到本进程 UPLOADS_DIR。正文放原始形态(D:\a\b),
  // run 产物 JSONL 放转义形态(D:\\a\\b),都该改写成本机路径且 JSONL 改完仍合法。
  const repo = makeRepo(join(root, "repo", "acme"));
  const projectId = "handofflocal1";
  await db.insert(projects).values({
    id: projectId, name: "acme", repoPath: repo, apiKeys: null, workflowId: null,
    createdAt: "2026-08-19T08:00:00.000Z",
  });
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const winUpName = "up002xyz-shot.txt";
  const winUpPath = `D:\\ai_workspace\\ash\\data\\uploads\\${winUpName}`;
  const upManifest = (autoResume: boolean) => ({
    version: 1, sourceHost: "win-src", sourceWorkspace: null,
    targetProjectId: projectId, autoResume, git: null, transferId: "transfer-up-1",
    task: {
      id: "handoff-local-task-01", title: "Windows 附件用例",
      body: `看这个附件:${winUpPath}`, status: "paused", createdAt: "2026-08-19T12:00:00.000Z",
    },
    sessions: [] as unknown[],
    uploads: [{ name: winUpName, sourcePath: winUpPath, dataBase64: b64("win-upload\n") }],
    files: [{
      kind: "run-artifact", rel: "history.jsonl",
      dataBase64: b64(JSON.stringify({ type: "user", text: `附件在 ${winUpPath}` }) + "\n"),
    }],
  });
  const upResult = await importHandoff(upManifest(false));
  assert.equal(upResult.ok, true);
  const winUpLocal = join(root, "uploads", winUpName);
  assert.equal(readFileSync(winUpLocal, "utf8"), "win-upload\n", "附件本体应落到本机 uploads 目录");
  const upTask = (await db.select().from(tasks).where(eq(tasks.id, "handoff-local-task-01"))).at(0)!;
  assert.ok(upTask.body!.includes(winUpLocal), "正文里的原始形态路径应改写为本机路径");
  assert.ok(!upTask.body!.includes("D:"), "正文不该残留源机路径");
  const upArtifact = readFileSync(join(root, "runs", "handoff-local-task-01", "history.jsonl"), "utf8");
  const upParsed = JSON.parse(upArtifact.trim()) as { text: string };
  assert.ok(upParsed.text.includes(winUpLocal), "JSONL 里的转义形态路径应改写,且改完仍是合法 JSON");
  assert.ok(!upArtifact.includes("D:"), "JSONL 不该残留源机路径");

  // ── 3. 幂等收口如实报 in 标记里存的 autoResume 事实 ─────────────────────────
  // 缺陷形态(第 3 轮审查):幂等分支写死 autoResume:false,当初真续跑过的重放会
  // 误导源机把「对端已在跑」当成「对端没跑」。收口应答只认 in 标记存的事实,与本次
  // 请求参数无关;老版本标记没有这个字段,按 false 报(不谎报已续跑)。
  const replayFact = await importHandoff(upManifest(true)); // 请求 true,事实是 false
  assert.ok(replayFact.notes.some((n) => n.includes("幂等收口")));
  assert.equal(replayFact.autoResume, false, "收口要报当初导入的事实(false),不能按本次请求报 true");
  const upMarker = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, "handoff-local-task-01"))).at(0)!).handoff!,
  ) as Record<string, unknown>;
  assert.equal(upMarker.autoResume, false, "in 标记要把导入时的 autoResume 事实存下来");
  await db.update(tasks)
    .set({ handoff: JSON.stringify({ ...upMarker, autoResume: true }) })
    .where(eq(tasks.id, "handoff-local-task-01"));
  const replayTrue = await importHandoff(upManifest(false));
  assert.equal(replayTrue.autoResume, true, "标记里的事实是 true 时,收口就要报 true——与请求参数无关");
  const { autoResume: _dropped, ...legacyMarker } = upMarker;
  await db.update(tasks)
    .set({ handoff: JSON.stringify(legacyMarker) })
    .where(eq(tasks.id, "handoff-local-task-01"));
  const replayLegacy = await importHandoff(upManifest(true));
  assert.equal(replayLegacy.autoResume, false, "老标记没有 autoResume 字段,按 false 报,不谎报已续跑");

  // ── 4. 队列成员禁止接力:预检/导出都 409,后继绝不启动 ───────────────────────
  // 缺陷形态(第 3 轮审查双实例实测):接力 running 队列头会把它结算成 canceled,
  // 队列推进对 canceled 透明跳过,源机立刻启动 backlog 后继——与目标机并行。
  // 修法是入口级 409:队列头根本不会被停,后继自然停在 backlog。
  const { exportHandoff, preflightHandoff } = await import("../src/handoff.js");
  const qTs = "2026-08-20T08:00:00.000Z";
  await db.insert(tasks).values([
    { id: "handoffqhead01", projectId, title: "队列头", status: "running", createdAt: qTs, updatedAt: qTs },
    { id: "handoffqnext01", projectId, title: "队列后继", status: "backlog", createdAt: qTs, updatedAt: qTs },
  ]);
  await db.insert(queueItems).values([
    { taskId: "handoffqhead01", queueId: "handoffqueue01", position: 0, createdAt: qTs },
    { taskId: "handoffqnext01", queueId: "handoffqueue01", position: 1, createdAt: qTs },
  ]);
  const isQueue409 = (err: unknown) =>
    err instanceof Error && (err as { status?: number }).status === 409 && /队列/.test(err.message);
  await assert.rejects(
    preflightHandoff("handoffqhead01", "http://127.0.0.1:9"),
    isQueue409,
    "预检要用 409 给出队列原因(而不是通过后由导出翻车)",
  );
  await assert.rejects(
    exportHandoff("handoffqhead01", { targetUrl: "http://127.0.0.1:9", targetProjectId: "whatever" }),
    isQueue409,
    "导出要在停任务之前 409(目标 URL 不通也不该先被探测)",
  );
  const qHead = (await db.select().from(tasks).where(eq(tasks.id, "handoffqhead01"))).at(0)!;
  assert.equal(qHead.status, "running", "队列头不该被停:409 必须发生在 stopAndSettle 之前");
  assert.equal(qHead.handoff, null, "队列头不该留下接力标记");
  const qNext = (await db.select().from(tasks).where(eq(tasks.id, "handoffqnext01"))).at(0)!;
  assert.equal(qNext.status, "backlog", "后继绝不能被启动");
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.taskId, "handoffqnext01"))).length,
    0,
    "后继不该出现任何会话",
  );

  console.log("test-handoff-local ok");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

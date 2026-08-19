// 任务接力(handoff)端到端回归:测试进程自己当**源机**(进程内直调 preflight/export,
// HARNESS_DB 指向临时源库),再真 spawn 一个 harness server 当**对端**(PORT=0 随机端口、
// 独立临时库),两边走真 HTTP 协议。验的是:
//   1. preflight 探测/项目匹配/会话文件盘点
//   2. 应答丢失:pending 标记落库、本机启动被硬拦、重试沿用同一个 transferId
//   3. export 的 WIP 提交、bundle 前置提交协商、会话文件与 runs 产物打包
//      + import 的 bundle 落库、worktree 恢复、行落库、resumePrompt 前言、文件归位
//   4. 幂等收口:pending 重试撞上「对端已导入」按成功收敛、零副作用
//   5. 重复接力的两道闸(本机 out 标记 409、对端同 id 任务 409)+ 拒收后标记回滚
//   6. 导入原子性:会话 id 冲突预检 409 零副作用;落库半路炸掉整体回滚不留半截任务
//   7. 跨平台路径:Windows 源机的反斜杠 rel 按段重组归位;codex rollout 定位不到
//      (findRollout 找不着)时 cliSessionId 必须置空
// HARNESS_RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn,即使哪里失手触发续跑也
// 不会真拉起 CLI 烧额度;接力本身用 autoResume:false。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "harness-handoff-test-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home; // claude 会话文件读写全部落进临时 HOME,不碰真实 ~/.claude
process.env.HARNESS_DB = join(root, "source.db");
process.env.HARNESS_RUNS_DIR = join(root, "runs-src");
assert.ok(
  process.env.HARNESS_ALLOW_REAL_AGENT !== "1",
  "本测试靠 guardAgentSpawn 兜底拦真 CLI;拦截器一失效就会烧用户的真额度",
);

let peer: ChildProcess | null = null;
process.on("exit", () => {
  try { peer?.kill("SIGKILL"); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function makeRepo(path: string): string {
  execFileSync("git", ["init", "-b", "main", path]);
  git(path, "config", "user.name", "Harness Handoff Test");
  git(path, "config", "user.email", "handoff@example.test");
  writeFileSync(join(path, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(path, "seed.txt"), "seed\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "seed");
  return path;
}

/** 起对端 server(PORT=0),等 ready 行,返回 baseUrl。 */
async function startPeer(env: Record<string, string>): Promise<string> {
  const serverDir = join(import.meta.dirname, "..");
  const tsxCli = join(serverDir, "..", "node_modules", "tsx", "dist", "cli.mjs");
  peer = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: serverDir,
    env: { ...process.env, ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  return new Promise<string>((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`对端 server 30s 没 ready,输出:\n${buf}`)), 30_000);
    const onChunk = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/server on http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolvePort(`http://127.0.0.1:${m[1]}`);
      }
    };
    peer!.stdout!.on("data", onChunk);
    peer!.stderr!.on("data", onChunk);
    peer!.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`对端 server 提前退出(code ${code}),输出:\n${buf}`));
    });
  });
}

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}/api${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  assert.ok(res.ok, `${path} 应答 ${res.status}: ${body?.error ?? JSON.stringify(body).slice(0, 200)}`);
  return body;
}

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { prepareWorktree, worktreeBranchName, worktreePathFor } = await import("../src/git.js");
  const { claudeProjectSlug, exportHandoff, HandoffError, preflightHandoff } = await import("../src/handoff.js");
  const { handoffBlockReason } = await import("../src/handoff-guard.js");
  const { resumeOrRunTask } = await import("../src/task-resume.js");
  const { createTasks } = await import("../src/task-store.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { createClient } = await import("../src/db/node-sqlite-client.js");
  await ensureSchema();

  // ── 源机造数据 ────────────────────────────────────────────────────────────
  const srcRepo = makeRepo(join(root, "src-side", "acme"));
  const dstRepo = join(root, "dst-side", "acme"); // 同目录名 → 项目自动匹配
  execFileSync("git", ["clone", "--quiet", srcRepo, dstRepo]);

  const projectId = "handoffproj1";
  await db.insert(projects).values({
    id: projectId, name: "acme", repoPath: srcRepo, apiKeys: null, workflowId: null,
    createdAt: "2026-08-19T08:00:00.000Z",
  });
  const taskId = "handoff-e2e-task-01";
  await createTasks([{
    id: taskId, projectId, title: "接力回归任务", body: "把 feature.txt 写完并验证。",
    mode: "single", status: "paused", agentType: "claude",
    useWorktree: true, worktreeBase: "main", workflowMode: "free",
    resumePrompt: "继续:完成第二步",
    createdAt: "2026-08-19T08:00:00.000Z", updatedAt: "2026-08-19T08:00:00.000Z",
  }]);

  // worktree 上一个已提交改动 + 一个未提交改动(该被 WIP 提交带走)。
  const ws = await prepareWorktree(srcRepo, taskId, "main");
  writeFileSync(join(ws.path, "feature.txt"), "step one\n");
  git(ws.path, "add", "-A");
  git(ws.path, "commit", "-m", "task: step one");
  writeFileSync(join(ws.path, "wip.txt"), "uncommitted\n");

  // 两条会话:s1 有会话文件(该被搬走),s2 没有(该记 note、cliSessionId 置空)。
  const cli1 = "11111111-aaaa-4bbb-8ccc-000000000001";
  const cli2 = "22222222-aaaa-4bbb-8ccc-000000000002";
  const sessionBase = {
    taskId, role: "implementer", agentType: "claude", executor: "claude",
    target: "local", worktreePath: ws.path, branch: ws.branch, cwd: ws.path,
  };
  await db.insert(sessions).values([
    { ...sessionBase, id: "handoffsess1", cliSessionId: cli1, startedAt: "2026-08-19T08:01:00.000Z" },
    { ...sessionBase, id: "handoffsess2", cliSessionId: cli2, startedAt: "2026-08-19T08:05:00.000Z" },
  ]);
  const cliFileSrc = join(home, ".claude", "projects", claudeProjectSlug(ws.path), `${cli1}.jsonl`);
  mkdirSync(join(cliFileSrc, ".."), { recursive: true });
  writeFileSync(cliFileSrc, `{"type":"user","text":"hello"}\n{"type":"assistant","text":"world"}\n`);
  for (const sid of ["handoffsess1", "handoffsess2"]) {
    const transcript = sessionTranscriptPath(taskId, sid);
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(transcript, `# ${sid}\n对话产物\n`);
  }

  // ── 起对端 ────────────────────────────────────────────────────────────────
  const peerUrl = await startPeer({
    HARNESS_DB: join(root, "target.db"),
    HARNESS_RUNS_DIR: join(root, "runs-dst"),
  });
  const peerProject = await api<{ id: string }>(peerUrl, "/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "acme", repoPath: dstRepo }),
  });

  // ── 1. preflight ─────────────────────────────────────────────────────────
  const probe = await preflightHandoff(taskId, peerUrl);
  assert.equal(probe.ok, true);
  assert.equal(probe.suggestedProjectId, peerProject.id, "同目录名的对端项目应被自动匹配");
  assert.equal(probe.local.status, "paused");
  assert.equal(probe.local.running, false);
  assert.equal(probe.local.sessions, 2);
  assert.equal(probe.local.sessionFilesFound, 1);
  assert.equal(probe.local.git, "bundle");
  assert.ok(probe.local.notes.some((n) => n.includes("找不到 CLI 会话文件")), "s2 缺文件应记 note");

  // ── 2. 应答丢失:pending 标记落库 + 本机启动硬拦 ─────────────────────────
  // 假对端:ping/refs 正常应答,import 一来就掐断 socket——制造「对端可能已收到、
  // 应答没回来」的网络类失败(审查缺陷 2 的第一半 + 缺陷 1 的启动硬拦)。
  const flaky = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/api/handoff/ping")) {
      res.end(JSON.stringify({
        ok: true, service: "harness", host: "flaky",
        projects: [{ id: "p1", name: "acme", repoPath: dstRepo, isRepo: true }],
      }));
    } else if (req.url?.includes("/refs")) {
      res.end(JSON.stringify({ refs: [] }));
    } else {
      req.socket.destroy();
    }
  });
  await new Promise<void>((r) => flaky.listen(0, "127.0.0.1", r));
  const flakyPort = (flaky.address() as { port: number }).port;
  await assert.rejects(
    exportHandoff(taskId, { targetUrl: `http://127.0.0.1:${flakyPort}`, targetProjectId: "p1", autoResume: false }),
    (e: unknown) => e instanceof HandoffError && e.network && /对端可能已经收到/.test(e.message),
    "应答丢失应按「可能已送达」提示重试收口,而不是当确认失败",
  );
  await new Promise<void>((r) => flaky.close(() => r()));

  const pendingMarker = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!).handoff!,
  ) as { direction: string; pending?: boolean; transferId?: string };
  assert.equal(pendingMarker.direction, "out");
  assert.equal(pendingMarker.pending, true, "应答丢失后必须留下「接力未确认」的持久标记");
  assert.ok(pendingMarker.transferId, "pending 标记要带 transferId,重试才有幂等身份");
  assert.ok(handoffBlockReason(JSON.stringify(pendingMarker)), "pending 态必须触发启动硬拦");

  // 硬拦生效:resumeOrRunTask(队列推进/调度/HTTP 路由全汇到这条路)一个副作用都不留。
  await resumeOrRunTask(taskId, { reason: "run" });
  const blockedTask = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  assert.equal(blockedTask.status, "paused", "接力中的任务不该被本机拉起");
  assert.equal(blockedTask.resumePrompt, "继续:完成第二步", "被拦下的续跑要把 checkpoint 指令放回原位");
  assert.equal(
    (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length, 2,
    "被拦下的启动不该新建会话",
  );

  // ── 3. 重试收口:export → import ──────────────────────────────────────────
  const result = await exportHandoff(taskId, {
    targetUrl: peerUrl, targetProjectId: peerProject.id, targetName: "测试机", autoResume: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.remoteTaskId, taskId);
  assert.equal(result.sessionsMigrated, 1);
  assert.equal(result.git, "bundle");
  assert.equal(result.autoResume, false);

  // 源机:WIP 已提交进任务分支,worktree 干净;任务落了 out 标记;时间线有系统说明。
  assert.equal(git(ws.path, "status", "--porcelain"), "");
  assert.match(git(ws.path, "log", "-1", "--format=%s"), /chore\(handoff\)/);
  const srcTask = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const marker = JSON.parse(srcTask.handoff!) as {
    direction: string; peerTaskId: string; peerName: string; pending?: boolean; transferId?: string;
  };
  assert.equal(marker.direction, "out");
  assert.ok(!marker.pending, "确认送达后 pending 必须改写成确认态");
  assert.equal(marker.transferId, pendingMarker.transferId, "重试必须沿用同一个 transferId(幂等身份)");
  assert.equal(marker.peerTaskId, taskId);
  assert.equal(marker.peerName, "测试机");
  assert.match(
    readFileSync(sessionTranscriptPath(taskId, "handoffsess2"), "utf8"),
    /任务已接力到 测试机/,
    "接力说明应追加在最近一条会话的时间线上",
  );

  // 对端:任务原状态原样落库,in 标记、resumePrompt 前言齐全。
  const peerTask = await api<{
    status: string; resumePrompt: string | null; useWorktree: boolean;
    handoff: { direction: string; sessions: number; git: string; peerName: string | null };
  }>(peerUrl, `/tasks/${taskId}`);
  assert.equal(peerTask.status, "paused");
  assert.equal(peerTask.useWorktree, true);
  assert.equal(peerTask.handoff.direction, "in");
  assert.equal(peerTask.handoff.sessions, 1);
  assert.equal(peerTask.handoff.git, "bundle");
  assert.match(peerTask.resumePrompt!, /【任务接力】/);
  assert.match(peerTask.resumePrompt!, /继续:完成第二步/, "原 resumePrompt 应保留在前言之后");
  const dstWs = worktreePathFor(dstRepo, taskId);
  assert.match(peerTask.resumePrompt!, new RegExp(dstWs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "前言应指出新工作目录");

  // 对端 git:分支到位、WIP 提交在、worktree 恢复且两份文件都在。
  const branch = worktreeBranchName(taskId);
  assert.match(git(dstRepo, "log", "-1", "--format=%s", branch), /chore\(handoff\)/);
  assert.equal(existsSync(join(dstWs, "feature.txt")), true);
  assert.equal(existsSync(join(dstWs, "wip.txt")), true, "未提交改动应随 WIP 提交到达对端 worktree");

  // 对端文件:claude 会话文件按对端 cwd 的 slug 归位、runs 产物归位。
  const cliFileDst = join(home, ".claude", "projects", claudeProjectSlug(dstWs), `${cli1}.jsonl`);
  assert.equal(existsSync(cliFileDst), true, "会话文件应落到对端 cwd 对应的 slug 目录");
  assert.equal(readFileSync(cliFileDst, "utf8"), readFileSync(cliFileSrc, "utf8"));
  assert.equal(existsSync(join(root, "runs-dst", taskId, "handoffsess1.md")), true);

  // 对端会话行:文件到货的保留 cliSessionId,没到货的置空;cwd 全部指到对端 worktree。
  const dstDb = createClient({ url: join(root, "target.db") });
  const dstSessions = (await dstDb.execute({
    sql: "select id, cli_session_id as cli, cwd from sessions where task_id = ? order by started_at",
    args: [taskId],
  })).rows as unknown as { id: string; cli: string | null; cwd: string }[];
  assert.equal(dstSessions.length, 2);
  assert.equal(dstSessions[0]!.cli, cli1);
  assert.equal(dstSessions[1]!.cli, null, "文件没到货的会话 cliSessionId 必须置空,否则 --resume 会当场报错");
  assert.ok(dstSessions.every((s) => s.cwd === dstWs));

  // ── 4. 幂等收口:pending 重试撞上「对端已导入」→ 按成功收敛,零副作用 ──────
  // 模拟「上次 POST 其实送达了,只是应答丢了」:把源机标记改回 pending,原样重试。
  // 对端凭同一个 transferId 识别成同一次接力,直接返回成功,不重复导入。
  await db.update(tasks)
    .set({ handoff: JSON.stringify({ ...marker, pending: true }) })
    .where(eq(tasks.id, taskId));
  const replay = await exportHandoff(taskId, {
    targetUrl: peerUrl, targetProjectId: peerProject.id, targetName: "测试机", autoResume: false,
  });
  assert.equal(replay.ok, true);
  assert.ok(replay.notes.some((n) => n.includes("幂等收口")), "对端应按同 transferId 识别成同一次接力");
  const settled = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!).handoff!,
  ) as { pending?: boolean; transferId?: string };
  assert.ok(!settled.pending, "重试成功后 pending 必须收口成确认态");
  assert.equal(settled.transferId, marker.transferId);
  const replayCount = (await dstDb.execute({
    sql: "select count(*) as n from sessions where task_id = ?", args: [taskId],
  })).rows as unknown as { n: number }[];
  assert.equal(Number(replayCount[0]!.n), 2, "幂等重放不该在对端重复插会话");

  // ── 5. 重复接力的两道闸 + 拒收回滚 ───────────────────────────────────────
  await assert.rejects(
    exportHandoff(taskId, { targetUrl: peerUrl, targetProjectId: peerProject.id, autoResume: false }),
    (e: unknown) => e instanceof HandoffError && e.status === 409 && /已经接力出去/.test(e.message),
    "本机 out 标记应挡住重复接力",
  );
  await db.update(tasks).set({ handoff: null }).where(eq(tasks.id, taskId));
  await assert.rejects(
    exportHandoff(taskId, { targetUrl: peerUrl, targetProjectId: peerProject.id, autoResume: false }),
    (e: unknown) => e instanceof HandoffError && /已有同 id 任务/.test(e.message),
    "对端同 id 任务应挡住重复导入",
  );
  // 对端明确拒收(4xx 应答)≠ 应答丢失:源机要恢复接力前的标记(此处为 null),本机照常可跑。
  const afterReject = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  assert.equal(afterReject.handoff, null, "对端明确拒收后应恢复接力前的标记,而不是留 pending");

  // ── 6. 导入原子性:冲突预检 409 零副作用;落库半路炸掉整体回滚 ────────────
  const rawImport = (body: unknown) =>
    fetch(`${peerUrl}/api/handoff/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  const manifestBase = {
    version: 1, sourceHost: "test-src", sourceWorkspace: null,
    targetProjectId: peerProject.id, autoResume: false, git: null, files: [] as unknown[],
    task: {
      id: "handoff-e2e-task-02", title: "原子性用例", body: "probe",
      status: "paused", createdAt: "2026-08-19T09:00:00.000Z",
    },
  };
  const probeSession = {
    role: "implementer", agentType: "claude", executor: "claude",
    startedAt: "2026-08-19T09:01:00.000Z",
  };
  // 会话 id 撞上对端已有会话(handoffsess1 刚随任务 01 导入过):预检 409,什么都不落。
  const conflictRes = await rawImport({
    ...manifestBase, transferId: "transfer-conflict-1",
    sessions: [{ ...probeSession, id: "handoffsess1" }],
  });
  assert.equal(conflictRes.status, 409);
  assert.match(((await conflictRes.json()) as { error: string }).error, /会话 id 与本机已有会话冲突/);
  assert.equal((await fetch(`${peerUrl}/api/tasks/handoff-e2e-task-02`)).status, 404, "预检拦下的导入不该留任务行");
  // 载荷内部两条同 id 会话:预检查不出(对端库里还没有),落库时 UNIQUE 炸 → 整体回滚。
  const dupRes = await rawImport({
    ...manifestBase, transferId: "transfer-dup-1",
    sessions: [
      { ...probeSession, id: "handoffdup1" },
      { ...probeSession, id: "handoffdup1", startedAt: "2026-08-19T09:02:00.000Z" },
    ],
  });
  assert.equal(dupRes.status, 500);
  assert.match(((await dupRes.json()) as { error: string }).error, /已回滚/);
  assert.equal((await fetch(`${peerUrl}/api/tasks/handoff-e2e-task-02`)).status, 404, "落库失败必须回滚任务行,不留半截任务");
  const dupRows = (await dstDb.execute({
    sql: "select count(*) as n from sessions where task_id = ?", args: ["handoff-e2e-task-02"],
  })).rows as unknown as { n: number }[];
  assert.equal(Number(dupRows[0]!.n), 0, "回滚要连已插入的会话行一起清掉");

  // ── 7. 跨平台路径:Windows 源机的反斜杠 rel 也要正确归位 ──────────────────
  // codex rollout 深度对(YYYY/MM/DD)→ findRollout 定位得到,cliSessionId 保留;
  // 深度不对 → 文件在盘上但 codex 自己找不到,必须按未迁移处理(置空 + note)。
  const threadA = "33333333-aaaa-4bbb-8ccc-000000000003";
  const threadB = "44444444-aaaa-4bbb-8ccc-000000000004";
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const winRes = await rawImport({
    ...manifestBase, transferId: "transfer-win-1",
    task: { ...manifestBase.task, id: "handoff-e2e-task-03", title: "Windows 源机用例", agentType: "codex" },
    sessions: [
      { ...probeSession, id: "handoffcodexa", agentType: "codex", executor: "codex", cliSessionId: threadA },
      { ...probeSession, id: "handoffcodexb", agentType: "codex", executor: "codex", cliSessionId: threadB, startedAt: "2026-08-19T09:03:00.000Z" },
    ],
    files: [
      { kind: "codex-rollout", rel: `2026\\08\\19\\rollout-2026-08-19T10-00-00-${threadA}.jsonl`, dataBase64: b64('{"turn":1}\n') },
      { kind: "codex-rollout", rel: `rollout-2026-08-19T10-05-00-${threadB}.jsonl`, dataBase64: b64('{"turn":2}\n') },
      { kind: "run-artifact", rel: "sub\\dir\\note.md", dataBase64: b64("# 产物\n") },
    ],
  });
  const winBody = (await winRes.json()) as { sessionsMigrated: number; notes: string[]; error?: string };
  assert.equal(winRes.status, 200, `Windows rel 导入应成功:${winBody.error ?? ""}`);
  assert.equal(winBody.sessionsMigrated, 1, "只有 findRollout 定位得到的 codex 会话算迁移成功");
  assert.ok(winBody.notes.some((n) => n.includes("无法按标准目录定位")), "定位不到的 rollout 要留 note");
  assert.equal(
    existsSync(join(home, ".codex", "sessions", "2026", "08", "19", `rollout-2026-08-19T10-00-00-${threadA}.jsonl`)),
    true, "反斜杠 rel 应按段重组后落进 codex 标准目录",
  );
  assert.equal(
    existsSync(join(root, "runs-dst", "handoff-e2e-task-03", "sub", "dir", "note.md")),
    true, "产物的反斜杠 rel 同样按段重组归位",
  );
  const codexRows = (await dstDb.execute({
    sql: "select id, cli_session_id as cli from sessions where task_id = ? order by started_at",
    args: ["handoff-e2e-task-03"],
  })).rows as unknown as { id: string; cli: string | null }[];
  assert.equal(codexRows[0]!.cli, threadA, "定位得到的 codex 会话保留 cliSessionId");
  assert.equal(codexRows[1]!.cli, null, "定位不到的必须置空,否则续跑是假恢复");

  console.log("test-handoff ok");
} finally {
  if (peer) {
    peer.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { peer?.kill("SIGKILL"); resolve(); }, 5_000);
      peer!.on("exit", () => { clearTimeout(t); resolve(); });
    });
  }
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}

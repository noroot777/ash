// 任务接力(handoff)端到端回归:测试进程自己当**源机**(进程内直调 preflight/export,
// HARNESS_DB 指向临时源库),再真 spawn 一个 harness server 当**对端**(PORT=0 随机端口、
// 独立临时库),两边走真 HTTP 协议。验的是:
//   1. preflight 探测/项目匹配/会话文件盘点
//   2. export 的 WIP 提交、bundle 前置提交协商、会话文件与 runs 产物打包
//   3. import 的 bundle 落库、worktree 恢复、行落库、resumePrompt 前言、文件归位
//   4. 重复接力的两道闸(本机 out 标记 409、对端同 id 任务 409)
// HARNESS_RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn,即使哪里失手触发续跑也
// 不会真拉起 CLI 烧额度;接力本身用 autoResume:false。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
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

  // ── 2. export → import ───────────────────────────────────────────────────
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
  const marker = JSON.parse(srcTask.handoff!) as { direction: string; peerTaskId: string; peerName: string };
  assert.equal(marker.direction, "out");
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

  // ── 3. 重复接力的两道闸 ──────────────────────────────────────────────────
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

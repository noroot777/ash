// 任务接力(handoff)端到端回归:测试进程自己当**源机**(进程内直调 preflight/export,
// ASH_DB 指向临时源库),再真 spawn 一个 ash server 当**对端**(PORT=0 随机端口、
// 独立临时库),两边走真 HTTP 协议。验的是:
//   1. preflight 探测/项目匹配/会话文件盘点
//   2. 应答丢失:pending 标记落库、本机启动被硬拦、重试沿用同一个 transferId
//      + 目标参数冻结:pending 重试换目标机/换对端项目一律 409、零副作用
//   3. export 的 WIP 提交、bundle 前置提交协商、会话文件与 runs 产物打包
//      + import 的 bundle 落库、worktree 恢复、行落库、resumePrompt 前言、文件归位
//   4. 幂等收口:pending 重试撞上「对端已导入」按成功收敛、零副作用,
//      且 autoResume 按对端实际应答如实上报(幂等分支没续跑就不能报 true)
//   5. 重复接力的两道闸(本机 out 标记 409、对端同 id 任务 409)+ 拒收后标记回滚
//   6. 导入原子性:会话 id 冲突预检 409 零副作用;落库半路炸掉整体回滚不留半截任务
//   7. 跨平台路径:Windows 源机的反斜杠 rel 按段重组归位;codex rollout 定位不到
//      (findRollout 找不着)时 cliSessionId 必须置空
//   8. 并发导入互斥:同一 task id 两个在途导入,后到者 409,先到者的行毫发无损
//   9. 源机写入口硬拦:接力出去的任务 accept/run/改 status/定时/stage/派审全 409,
//      改标题照常、移除标记后恢复可写
//  10. 上传附件迁移(织进 1/3 节):preflight 盘点数量;正文/会话 JSONL 引用的
//      uploads 文件随任务到达对端,原始与 JSON 转义两种形态的路径都改写成对端路径,
//      改完仍是合法 JSON(Windows 源机形态与纯函数上下文改写在 test-handoff-local.ts)
//  11. 待发送消息与定时计划随任务迁移(织进 1/3/4 节):preflight 盘点数量;pending
//      消息在对端原样落库(新 id、到期时间保留、附件路径改写),本机原件取消留档;
//      幂等收口只取消 pending 标记冻结的那批,收口期间新建的留在托盘如实提醒;
//      定时计划带 enabled/lastRunAt 落到对端并接上任务(schedule_id)
//  12. 网关伪造失败应答(对端实已导入成功、502 不带 ash 标记):按「送达未知」
//      保留 pending,重试走幂等收口——按业务拒绝回滚就是两台机器双跑
// ASH_RUNS_DIR 指到临时目录顺带打开 guardAgentSpawn,即使哪里失手触发续跑也
// 不会真拉起 CLI 烧额度;接力本身用 autoResume:false。
import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api, git, makeRepo, pairWithPeer, startFakePeer, startPeer } from "./handoff-test-utils.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-handoff-test-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
// claude 会话文件读写全部落进临时 HOME,不碰真实 ~/.claude。产品代码走 os.homedir(),
// 它认的变量两个平台不是同一个:POSIX 看 HOME,Windows 看 USERPROFILE——只改 HOME 的话
// Windows 上夹具形同没设,断言变成「看谁的机器」(test-cli-overrides.ts 同款坑)。
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ASH_DB = join(root, "source.db");
process.env.ASH_RUNS_DIR = join(root, "runs-src");
process.env.ASH_UPLOADS_DIR = join(root, "uploads-src"); // 上传附件迁移用:源/对端各一个隔离目录
assert.ok(
  process.env.ASH_ALLOW_REAL_AGENT !== "1",
  "本测试靠 guardAgentSpawn 兜底拦真 CLI;拦截器一失效就会烧用户的真额度",
);

let peer: ChildProcess | null = null;
// 对端 DB 直连句柄的关闭器:Windows 删不掉仍被打开的文件(EBUSY),清理前必须关;
// 挂在 finally 里,断言中途抛错也不会把句柄漏到 rmSync。
let closeDstDb: (() => void) | null = null;
process.on("exit", () => {
  try { peer?.kill("SIGKILL"); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
});

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, scheduledMessages, schedules, sessions, tasks } = await import("../src/db/schema.js");
  const { prepareWorktree, worktreeBranchName, worktreePathFor } = await import("../src/git.js");
  const { exportHandoff, handoffRemoteUrl, preflightHandoff } = await import("../src/handoff.js");
const { claudeProjectSlug } = await import("../src/handoff-collect.js");
// 这些 src 模块必须**在环境变量设好之后**才加载:paths.ts 在模块求值那一刻就把
// ASH_UPLOADS_DIR / ASH_RUNS_DIR 定死了,顶层 import 会被提升到赋值之前。
const { peerRequestHeaders } = await import("../src/handoff-peer-client.js");
  const { jsonEscaped } = await import("../src/handoff-uploads.js");
  const { HandoffError } = await import("../src/handoff-types.js");
  const { handoffBlockReason } = await import("../src/handoff-guard.js");
  const { localIdentity } = await import("../src/handoff-identity.js");
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
  // 上传附件:attachmentsPrompt 会把 uploads 绝对路径写进任务正文,随后进入会话 JSONL。
  // 正文放原始形态,JSONL 放 JSON 转义形态,接力后两种都该改写成对端路径。
  const uploadName = "up001abc-notes.txt";
  const uploadSrcPath = join(root, "uploads-src", uploadName);
  const msgUpName = "up003msg-checklist.txt";
  const msgUpPath = join(root, "uploads-src", msgUpName);
  mkdirSync(join(root, "uploads-src"), { recursive: true });
  writeFileSync(uploadSrcPath, "附件内容 attachment-body\n");
  writeFileSync(msgUpPath, "验收清单\n");
  await createTasks([{
    id: taskId, projectId, title: "接力回归任务",
    body: `把 feature.txt 写完并验证。\n\n[用户附带的文件,请用 Read 工具查看以下本地文件]\n- ${uploadSrcPath}`,
    mode: "single", status: "paused", agentType: "claude",
    useWorktree: true, worktreeBase: "main", workflowMode: "free",
    resumePrompt: "继续:完成第二步",
    createdAt: "2026-08-19T08:00:00.000Z", updatedAt: "2026-08-19T08:00:00.000Z",
  }]);
  // 定时计划 + 一条引用附件的待发送消息:都该随任务迁移(schedules 按 taskId 查,
  // tasks.schedule_id 只是反向缓存,源机不设也得能搬走)。
  await db.insert(schedules).values({
    id: "handoffsched01", taskId, kind: "cron", at: null, cron: "0 9 * * *",
    enabled: true, lastRunAt: null, createdAt: "2026-08-19T08:00:00.000Z",
  });
  await db.insert(scheduledMessages).values({
    id: "handoffmsg01", taskId, text: `到点看一眼验收清单:${msgUpPath}`,
    attachments: JSON.stringify([msgUpPath]), agent: "claude", executorId: null,
    model: null, reasoningEffort: null, sessionRole: null, mode: "timed",
    sendAt: "2027-01-01T09:00:00.000Z", status: "pending",
    createdAt: "2026-08-19T08:10:00.000Z", sentAt: null, deliveringSince: null,
  });

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
    worktreePath: ws.path, branch: ws.branch, cwd: ws.path,
  };
  await db.insert(sessions).values([
    { ...sessionBase, id: "handoffsess1", cliSessionId: cli1, startedAt: "2026-08-19T08:01:00.000Z" },
    { ...sessionBase, id: "handoffsess2", cliSessionId: cli2, startedAt: "2026-08-19T08:05:00.000Z" },
  ]);
  const cliFileSrc = join(home, ".claude", "projects", claudeProjectSlug(ws.path), `${cli1}.jsonl`);
  mkdirSync(join(cliFileSrc, ".."), { recursive: true });
  writeFileSync(cliFileSrc, [
    JSON.stringify({ type: "user", text: `hello,附件在 ${uploadSrcPath}` }),
    JSON.stringify({ type: "assistant", text: "world" }),
    "",
  ].join("\n"));
  for (const sid of ["handoffsess1", "handoffsess2"]) {
    const transcript = sessionTranscriptPath(taskId, sid);
    mkdirSync(join(transcript, ".."), { recursive: true });
    writeFileSync(transcript, `# ${sid}\n对话产物\n`);
  }

  // ── 起对端 ────────────────────────────────────────────────────────────────
  const peerUrl = await startPeer({
    ASH_DB: join(root, "target.db"),
    ASH_RUNS_DIR: join(root, "runs-dst"),
    ASH_UPLOADS_DIR: join(root, "uploads-dst"),
  }, (proc) => { peer = proc; });
  const peerProject = await api<{ id: string }>(peerUrl, "/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "acme", repoPath: dstRepo }),
  });

  // 配对:对端默认要求入站审批,先让它批准本进程的接力身份(等价于用户在对端设置页
  // 点「批准」)。身份核对本身的用例在 test-handoff-auth.ts。
  await pairWithPeer(peerUrl);

  // ── 1. preflight ─────────────────────────────────────────────────────────
  const probe = await preflightHandoff(taskId, peerUrl);
  assert.equal(probe.ok, true);
  assert.equal(probe.suggestedProjectId, peerProject.id, "同目录名的对端项目应被自动匹配");
  assert.equal(probe.local.status, "paused");
  assert.equal(probe.local.running, false);
  assert.equal(probe.local.sessions, 2);
  assert.equal(probe.local.sessionFilesFound, 1);
  assert.equal(probe.local.uploads, 2, "preflight 应盘点出正文与待发送消息引用的上传附件");
  assert.equal(probe.local.pendingMessages, 1, "preflight 应盘点出待发送消息");
  assert.equal(probe.local.schedule, "cron", "preflight 应盘点出定时计划类型");
  assert.equal(probe.local.git, "bundle");
  assert.ok(probe.local.notes.some((n) => n.includes("找不到 CLI 会话文件")), "s2 缺文件应记 note");

  // ── 2. 应答丢失:pending 标记落库 + 本机启动硬拦 ─────────────────────────
  // 假对端:ping/refs 正常应答;import 起初一来就掐断 socket——制造「对端可能已收到、
  // 应答没回来」的网络类失败;flakyForwards 打开后原样转发给真对端,模拟同一台机器
  // 恢复应答(收口重试的冻结校验只认同一 URL,所以恢复必须发生在同一个地址上)。
  let flakyForwards = false;
  const flaky = await startFakePeer({
    host: "flaky",
    upstream: peerUrl,
    project: { id: peerProject.id, name: "acme", repoPath: dstRepo },
    onImport: async (ctx) => {
      if (!flakyForwards) return ctx.destroy();
      const { status, body } = await ctx.forward();
      ctx.reply(status, body);
    },
  });
  const flakyUrl = flaky.url;
  await assert.rejects(
    exportHandoff(taskId, { targetUrl: flakyUrl, targetProjectId: peerProject.id, autoResume: false }),
    (e: unknown) => e instanceof HandoffError && e.network && /对端可能已经收到/.test(e.message),
    "应答丢失应按「可能已送达」提示重试收口,而不是当确认失败",
  );

  const pendingMarker = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!).handoff!,
  ) as {
    direction: string; pending?: boolean; transferId?: string;
    peerUrl?: string; targetProjectId?: string; autoResume?: boolean; messageIds?: string[]; originFp?: string | null;
  };
  assert.equal(pendingMarker.direction, "out");
  assert.equal(pendingMarker.pending, true, "应答丢失后必须留下「接力未确认」的持久标记");
  assert.ok(pendingMarker.transferId, "pending 标记要带 transferId,重试才有幂等身份");
  assert.equal(pendingMarker.originFp, localIdentity().fingerprint, "首次导出要把本机记为任务原机并冻结进 pending 标记");
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

  // ── 2b. 收口重试的参数冻结:换目标机/换对端项目一律 409,零副作用 ──────────
  // 缺陷形态(第 2 轮审查实测):pending 重试沿用同一个 transferId 却换了目标,两台
  // 机器各自导入成功,同一任务被复制成多份。冻结校验在 ping 之前,不需要对端在线。
  assert.equal(pendingMarker.peerUrl, flakyUrl, "pending 标记要冻结目标机地址");
  assert.equal(pendingMarker.targetProjectId, peerProject.id, "pending 标记要冻结对端项目");
  assert.equal(pendingMarker.autoResume, false, "pending 标记要冻结 autoResume");
  assert.deepEqual(pendingMarker.messageIds, ["handoffmsg01"], "pending 标记要冻结首次发送带走的消息 id");
  await assert.rejects(
    exportHandoff(taskId, { targetUrl: peerUrl, targetProjectId: peerProject.id, autoResume: false }),
    (e: unknown) => e instanceof HandoffError && e.status === 409 && /同一台机器/.test(e.message),
    "pending 重试换目标机必须 409——换机重放会把任务复制到两台机器",
  );
  await assert.rejects(
    exportHandoff(taskId, { targetUrl: flakyUrl, targetProjectId: "some-other-project", autoResume: false }),
    (e: unknown) => e instanceof HandoffError && e.status === 409 && /同一个项目/.test(e.message),
    "pending 重试换对端项目必须 409",
  );
  const frozen = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!).handoff!,
  ) as { pending?: boolean; transferId?: string };
  assert.equal(frozen.pending, true, "被拒的换目标重试不能动 pending 标记");
  assert.equal(frozen.transferId, pendingMarker.transferId, "被拒的重试不能换 transferId");

  // ── 3. 重试收口:同一台目标机恢复应答,export → import ────────────────────
  flakyForwards = true;
  const result = await exportHandoff(taskId, {
    targetUrl: flakyUrl, targetProjectId: peerProject.id, targetName: "测试机", autoResume: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.remoteTaskId, taskId);
  assert.equal(result.remoteUrl, `${flakyUrl}/?project=${peerProject.id}&task=${taskId}`);
  assert.equal(result.sessionsMigrated, 1);
  assert.equal(result.git, "bundle");
  assert.equal(result.autoResume, false);

  // 源机:WIP 已提交进任务分支,worktree 干净;任务落了 out 标记;时间线有系统说明。
  assert.equal(git(ws.path, "status", "--porcelain"), "");
  assert.match(git(ws.path, "log", "-1", "--format=%s"), /chore\(handoff\)/);
  const srcTask = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const marker = JSON.parse(srcTask.handoff!) as {
    direction: string; peerTaskId: string; peerName: string; pending?: boolean; transferId?: string;
    targetProjectId?: string; originFp?: string | null;
  };
  assert.equal(marker.direction, "out");
  assert.ok(!marker.pending, "确认送达后 pending 必须改写成确认态");
  assert.equal(marker.transferId, pendingMarker.transferId, "重试必须沿用同一个 transferId(幂等身份)");
  assert.equal(marker.peerTaskId, taskId);
  assert.equal(marker.peerName, "测试机");
  assert.equal(marker.targetProjectId, peerProject.id);
  assert.equal(marker.originFp, localIdentity().fingerprint, "确认送达后的 out 标记要继续保留原机指纹");
  const legacyMarker = { ...marker, peerUrl, targetProjectId: undefined };
  await db.update(tasks).set({ handoff: JSON.stringify(legacyMarker) }).where(eq(tasks.id, taskId));
  assert.equal(await handoffRemoteUrl(taskId), `${peerUrl}/?project=${peerProject.id}&task=${taskId}`);
  await db.update(tasks).set({ handoff: JSON.stringify(marker) }).where(eq(tasks.id, taskId));
  assert.match(
    readFileSync(sessionTranscriptPath(taskId, "handoffsess2"), "utf8"),
    /任务已接力到 测试机/,
    "接力说明应追加在最近一条会话的时间线上",
  );

  // 对端:任务原状态原样落库,in 标记、resumePrompt 前言齐全;正文里的附件路径已改写。
  const peerTask = await api<{
    status: string; body: string; resumePrompt: string | null; useWorktree: boolean;
    handoff: { direction: string; sessions: number; git: string; peerName: string | null; peerFp?: string | null; originFp?: string | null };
  }>(peerUrl, `/tasks/${taskId}`);
  const uploadDstPath = join(root, "uploads-dst", uploadName);
  assert.equal(peerTask.status, "paused");
  assert.ok(peerTask.body.includes(uploadDstPath), "正文里的附件路径应改写为对端 uploads 路径");
  assert.ok(!peerTask.body.includes(uploadSrcPath), "正文不该残留源机 uploads 路径");
  assert.equal(peerTask.useWorktree, true);
  assert.equal(peerTask.handoff.direction, "in");
  assert.equal(peerTask.handoff.sessions, 1);
  assert.equal(peerTask.handoff.git, "bundle");
  assert.equal(peerTask.handoff.peerFp, localIdentity().fingerprint, "导入标记应记住来源指纹，供安全移回时锁定机器");
  assert.equal(peerTask.handoff.originFp, localIdentity().fingerprint, "导入标记应保留任务原机指纹");
  assert.match(peerTask.resumePrompt!, /【任务接力】/);
  assert.match(peerTask.resumePrompt!, /继续:完成第二步/, "原 resumePrompt 应保留在前言之后");
  const dstWs = worktreePathFor(dstRepo, taskId);
  assert.match(peerTask.resumePrompt!, new RegExp(dstWs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "前言应指出新工作目录");

  // 对端 git:分支到位、WIP 提交在、worktree 恢复且两份文件都在。
  const branch = worktreeBranchName(taskId);
  assert.match(git(dstRepo, "log", "-1", "--format=%s", branch), /chore\(handoff\)/);
  assert.equal(existsSync(join(dstWs, "feature.txt")), true);
  assert.equal(existsSync(join(dstWs, "wip.txt")), true, "未提交改动应随 WIP 提交到达对端 worktree");

  // 对端文件:claude 会话文件按对端 cwd 的 slug 归位、runs 产物归位;
  // 附件本体到达对端 uploads 目录,JSONL 里的转义形态路径改写后每行仍是合法 JSON。
  const cliFileDst = join(home, ".claude", "projects", claudeProjectSlug(dstWs), `${cli1}.jsonl`);
  assert.equal(existsSync(cliFileDst), true, "会话文件应落到对端 cwd 对应的 slug 目录");
  const dstJsonl = readFileSync(cliFileDst, "utf8");
  // JSONL 里的路径是 JSON 转义形态:Windows 路径的 \ 在文件里是 \\,拿原始形态找永远
  // 落空(POSIX 两种形态相同,平台假设不会暴露)。断言统一按转义形态查。
  assert.ok(dstJsonl.includes(jsonEscaped(uploadDstPath)), "会话 JSONL 里的附件路径应改写为对端路径");
  assert.ok(!dstJsonl.includes(jsonEscaped(uploadSrcPath)), "会话 JSONL 不该残留源机附件路径");
  for (const line of dstJsonl.trim().split("\n")) JSON.parse(line);
  assert.equal(
    readFileSync(uploadDstPath, "utf8"), readFileSync(uploadSrcPath, "utf8"),
    "附件内容应原样到达对端 uploads 目录",
  );
  assert.ok(result.notes.some((n) => n.includes("迁移上传附件")), "导入应答要说明附件迁移");
  assert.equal(existsSync(join(root, "runs-dst", taskId, "handoffsess1.md")), true);

  // 对端会话行:文件到货的保留 cliSessionId,没到货的置空;cwd 全部指到对端 worktree。
  const dstDb = createClient({ url: join(root, "target.db") });
  closeDstDb = () => dstDb.close();
  const dstSessions = (await dstDb.execute({
    sql: "select id, cli_session_id as cli, cwd from sessions where task_id = ? order by started_at",
    args: [taskId],
  })).rows as unknown as { id: string; cli: string | null; cwd: string }[];
  assert.equal(dstSessions.length, 2);
  assert.equal(dstSessions[0]!.cli, cli1);
  assert.equal(dstSessions[1]!.cli, null, "文件没到货的会话 cliSessionId 必须置空,否则 --resume 会当场报错");
  assert.ok(dstSessions.every((s) => s.cwd === dstWs));

  // 待发送消息:对端新 id 原样落库,附件路径/本体一起到;源机原件取消留档且 sent_at
  // 保持 null(sent 只在原话真的进了会话之后才写)。定时计划落到对端并接上任务。
  const dstMsgs = (await dstDb.execute({
    sql: "select id, status, mode, send_at as sendAt, text, attachments from scheduled_messages where task_id = ?",
    args: [taskId],
  })).rows as unknown as { id: string; status: string; mode: string; sendAt: string; text: string; attachments: string }[];
  assert.equal(dstMsgs.length, 1, "待发送消息应随任务到达对端");
  assert.equal(dstMsgs[0]!.status, "pending");
  assert.equal(dstMsgs[0]!.mode, "timed");
  assert.equal(dstMsgs[0]!.sendAt, "2027-01-01T09:00:00.000Z", "到期时间要原样保留");
  assert.notEqual(dstMsgs[0]!.id, "handoffmsg01", "对端要发新 id,不能沿用源机 id");
  const msgUpDst = join(root, "uploads-dst", msgUpName);
  assert.ok(dstMsgs[0]!.text.includes(msgUpDst), "消息正文里的附件路径应改写为对端路径");
  assert.deepEqual(JSON.parse(dstMsgs[0]!.attachments), [msgUpDst], "附件清单(JSON)同样改写为对端路径");
  assert.equal(readFileSync(msgUpDst, "utf8"), "验收清单\n", "消息引用的附件本体应到达对端");
  const dstSched = (await dstDb.execute({
    sql: "select id, kind, cron, enabled, last_run_at as lastRunAt from schedules where task_id = ?",
    args: [taskId],
  })).rows as unknown as { id: string; kind: string; cron: string | null; enabled: number; lastRunAt: string | null }[];
  assert.equal(dstSched.length, 1, "定时计划应随任务到达对端");
  assert.equal(dstSched[0]!.kind, "cron");
  assert.equal(dstSched[0]!.cron, "0 9 * * *");
  assert.equal(Number(dstSched[0]!.enabled), 1, "enabled 要原样带过去");
  assert.equal(dstSched[0]!.lastRunAt, null);
  const dstTaskSched = (await dstDb.execute({
    sql: "select schedule_id as sid from tasks where id = ?", args: [taskId],
  })).rows as unknown as { sid: string | null }[];
  assert.equal(dstTaskSched[0]!.sid, dstSched[0]!.id, "对端任务要接上新计划(schedule_id 反向缓存)");
  const srcMsg = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "handoffmsg01"))).at(0)!;
  assert.equal(srcMsg.status, "canceled", "本机原件应取消,否则同一句话两台机器各发一遍");
  assert.equal(srcMsg.sentAt, null, "取消不是发送,sent_at 必须保持 null");
  assert.ok(result.notes.some((n) => n.includes("迁移待发送消息 1 条")), "应答要说明消息迁移");
  assert.ok(result.notes.some((n) => n.includes("定时计划已随任务迁移")), "应答要说明计划迁移");

  // ── 4. 幂等收口:pending 重试撞上「对端已导入」→ 按成功收敛,零副作用 ──────
  // 模拟「上次 POST 其实送达了,只是应答丢了」:把源机标记改回 pending,原样重试。
  // 对端凭同一个 transferId 识别成同一次接力,直接返回成功,不重复导入。
  // 故意在重试时请求 autoResume:true(老 settled 标记没有冻结字段,按本次请求走):
  // 幂等分支对端根本没续跑,应答必须如实说 autoResume:false,不能按请求参数谎报。
  await db.update(tasks)
    .set({ handoff: JSON.stringify({ ...marker, pending: true }) })
    .where(eq(tasks.id, taskId));
  // 收口期间新建的待发送消息:settled 标记没冻结 messageIds(冻结批为空),幂等收口
  // 一条都不能取消——它没迁移到对端,静默取消就是丢消息;只能留在托盘并如实提醒。
  await db.insert(scheduledMessages).values({
    id: "handoffmsg02", taskId, text: "接力未确认期间补的一句", attachments: "[]",
    agent: null, executorId: null, model: null, reasoningEffort: null, sessionRole: null,
    mode: "queued", sendAt: "2026-08-19T12:00:00.000Z", status: "pending",
    createdAt: "2026-08-19T12:00:00.000Z", sentAt: null, deliveringSince: null,
  });
  const replay = await exportHandoff(taskId, {
    targetUrl: flakyUrl, targetProjectId: peerProject.id, targetName: "测试机", autoResume: true,
  });
  assert.equal(replay.ok, true);
  assert.ok(replay.notes.some((n) => n.includes("幂等收口")), "对端应按同 transferId 识别成同一次接力");
  assert.equal(replay.autoResume, false, "幂等收口时对端并没有续跑,autoResume 必须按对端实际应答上报");
  const settled = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!).handoff!,
  ) as { pending?: boolean; transferId?: string };
  assert.ok(!settled.pending, "重试成功后 pending 必须收口成确认态");
  assert.equal(settled.transferId, marker.transferId);
  const replayCount = (await dstDb.execute({
    sql: "select count(*) as n from sessions where task_id = ?", args: [taskId],
  })).rows as unknown as { n: number }[];
  assert.equal(Number(replayCount[0]!.n), 2, "幂等重放不该在对端重复插会话");
  assert.ok(replay.notes.some((n) => n.includes("没有随幂等收口迁移")), "收口期间新建的消息要如实提醒");
  const msg02 = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "handoffmsg02"))).at(0)!;
  assert.equal(msg02.status, "pending", "没迁移到对端的消息必须留在本机托盘,不能静默取消");
  const replayMsgs = (await dstDb.execute({
    sql: "select count(*) as n from scheduled_messages where task_id = ?", args: [taskId],
  })).rows as unknown as { n: number }[];
  assert.equal(Number(replayMsgs[0]!.n), 1, "幂等重放不该在对端重复插消息");
  await flaky.close();

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
      method: "POST",
      // 直接发原始请求也要签名:导入端点要求来源已获批准(配对在上面 pairWithPeer 做过)。
      headers: {
        "content-type": "application/json",
        ...peerRequestHeaders(`${peerUrl}/api/handoff/import`, "POST", JSON.stringify(body)),
      },
      body: JSON.stringify(body),
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
  const conflictBody = (await conflictRes.json()) as { error: string; ash?: boolean };
  assert.match(conflictBody.error, /会话 id 与本机.*任务冲突/);
  assert.equal(conflictBody.ash, true, "业务拒绝应答要带 ash 标记,源机才敢回滚 pending");
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

  // ── 8. 并发导入互斥:同一 task id 两个在途导入,后到者 409 且零副作用 ───────
  // 缺陷形态(第 2 轮审查实测):两个并发 import 都过了 existing 预检,输家撞
  // tasks.id UNIQUE 后补偿回滚按公共 task id 把赢家的行也删了(req1 200、req2 500、
  // 最终 GET 404)。进程内直调本机(源库)的 importHandoff:互斥闸是入口处的同步
  // 前缀,两个调用必然重叠,后到者在任何副作用之前就被挡下。
  const { importHandoff } = await import("../src/handoff-import.js");
  const raceManifest = (transferId: string, sessionId: string) => ({
    version: 1, sourceHost: "test-src", sourceWorkspace: null,
    targetProjectId: projectId, autoResume: false, git: null, files: [] as unknown[],
    transferId,
    task: {
      id: "handoff-e2e-task-04", title: "并发导入用例", body: "race",
      status: "paused", createdAt: "2026-08-19T10:00:00.000Z",
    },
    sessions: [{
      id: sessionId, role: "implementer", agentType: "claude", executor: "claude",
      startedAt: "2026-08-19T10:01:00.000Z",
    }],
  });
  const [race1, race2] = await Promise.allSettled([
    importHandoff(raceManifest("transfer-race-1", "handoffrace1")),
    importHandoff(raceManifest("transfer-race-2", "handoffrace2")),
  ]);
  assert.equal(race1.status, "fulfilled", "先到的导入应正常落库");
  assert.equal(race2.status, "rejected", "同 id 的并发导入必须被互斥闸挡下");
  const raceErr = (race2 as PromiseRejectedResult).reason as HandoffError;
  assert.ok(raceErr instanceof HandoffError && raceErr.status === 409, "互斥闸应 409(稍后原样重试),而不是 500");
  assert.match(raceErr.message, /另一次导入还在本机进行中/);
  const raceTask = (await db.select().from(tasks).where(eq(tasks.id, "handoff-e2e-task-04"))).at(0);
  assert.ok(raceTask, "输家被挡下后,赢家的任务行必须毫发无损");
  const raceSessions = await db.select().from(sessions).where(eq(sessions.taskId, "handoff-e2e-task-04"));
  assert.equal(raceSessions.length, 1, "只该留下赢家那一条会话行");
  assert.equal(raceSessions[0]!.id, "handoffrace1");

  // ── 9. 接力出去的任务在源机是历史存档:非启动类写入口全被 handoff 守卫 409 ──
  // 缺陷形态(第 2 轮审查实测):out+pending 任务 accept 直接 200,把接力时刻的旧
  // 提交合入本机主分支——对端还在同一分支上继续干活,回程必然更难合。给对端库里的
  // task-03 种一个 out 标记,走真 HTTP 验各写入口;确认送达后只能从对端移回，源机
  // 不能再清标记造出双跑。送达未知的 pending 也必须先让记录中的目标机确认撤销；
  // 旧记录缺地址/身份时宁可继续硬拦，不能仅凭本机确认框恢复成双跑。
  const outMarker = JSON.stringify({
    direction: "out", transferId: "transfer-out-guard", pending: false,
    peerUrl: "http://192.0.2.1:1", peerName: "另一台机器", peerTaskId: "handoff-e2e-task-03",
    at: "2026-08-19T11:00:00.000Z", sessions: 1, git: "none",
  });
  await dstDb.execute({
    sql: "update tasks set handoff = ? where id = ?",
    args: [outMarker, "handoff-e2e-task-03"],
  });
  const peerCall = (method: string, path: string, body?: unknown) =>
    fetch(`${peerUrl}/api${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  const expect409 = async (method: string, path: string, body?: unknown) => {
    const res = await peerCall(method, path, body);
    const parsed = (await res.json()) as { error?: string; handoff?: boolean; reason?: string };
    assert.equal(res.status, 409, `${method} ${path} 对接力出去的任务应 409,实得 ${res.status}:${parsed.error ?? ""}`);
    return parsed;
  };
  const acceptBody = await expect409("POST", "/tasks/handoff-e2e-task-03/accept");
  assert.equal(acceptBody.reason, "task_handed_off", "验收失败原因要可编程识别");
  await expect409("POST", "/tasks/handoff-e2e-task-03/run");
  const patchBody = await expect409("PATCH", "/tasks/handoff-e2e-task-03", { status: "backlog" });
  assert.equal(patchBody.handoff, true, "409 应带 handoff 标记,前端才好指引「先移除接力标记」");
  await expect409("PUT", "/tasks/handoff-e2e-task-03/schedule", { kind: "once", at: "2026-08-21T00:00:00.000Z" });
  await expect409("POST", "/tasks/handoff-e2e-task-03/stage", { stage: "implemented" });
  await expect409("POST", "/tasks/handoff-e2e-task-03/free-workflow/review", {});
  // 非 status 字段照常可改:历史存档允许整理标题/标签。
  const titleRes = await peerCall("PATCH", "/tasks/handoff-e2e-task-03", { title: "Windows 源机用例(已接力)" });
  assert.equal(titleRes.status, 200, `接力出去的任务改标题不该被拦:${await titleRes.text()}`);
  const confirmedClear = await peerCall("DELETE", "/tasks/handoff-e2e-task-03/handoff");
  assert.equal(confirmedClear.status, 409, `确认送达的存档不允许在源机恢复:${await confirmedClear.text()}`);
  await dstDb.execute({
    sql: "update tasks set handoff = ? where id = ?",
    args: [JSON.stringify({ ...JSON.parse(outMarker), pending: true }), "handoff-e2e-task-03"],
  });
  const clearRes = await peerCall("DELETE", "/tasks/handoff-e2e-task-03/handoff");
  assert.equal(clearRes.status, 409, `无法向目标机核验的 pending 标记不能仅凭本机操作移除:${await clearRes.text()}`);
  const scheduleStillBlocked = await peerCall(
    "PUT", "/tasks/handoff-e2e-task-03/schedule", { kind: "once", at: "2026-08-21T00:00:00.000Z", enabled: false },
  );
  assert.equal(scheduleStillBlocked.status, 409, `安全核验失败后写入口仍应保持硬拦:${await scheduleStillBlocked.text()}`);

  // (第 10/11 项的双机断言织在 1/3/4 节;单进程就能验的 Windows 源机附件形态、
  //  纯函数上下文改写、幂等收口 autoResume 事实在 test-handoff-local.ts。)

  // ── 12. 网关伪造失败应答:对端实已导入成功,502 却不带 ash 标记 ──────────
  // 缺陷形态(第 3 轮审查实测):路径上的网关(nginx/frp)把上游 200 吃掉、自己回
  // 502,源机按业务拒绝回滚标记 → 本机可再启动,而对端那份也在跑 → 双机双跑。
  // 没有 ash 标记的失败应答证明不了对端没落库,必须按「送达未知」保留 pending。
  const mangleTaskId = "handoff-e2e-task-07";
  await createTasks([{
    id: mangleTaskId, projectId, title: "网关伪造应答用例", body: "mangle 用例",
    mode: "single", status: "paused", agentType: "claude",
    useWorktree: false, workflowMode: "free",
    createdAt: "2026-08-19T13:00:00.000Z", updatedAt: "2026-08-19T13:00:00.000Z",
  }]);
  let mangle = true;
  let mangleUpstreamStatus = 0;
  const mangler = await startFakePeer({
    host: "mangler",
    upstream: peerUrl,
    project: { id: peerProject.id, name: "acme", repoPath: dstRepo },
    onImport: async (ctx) => {
      const { status, body } = await ctx.forward();
      mangleUpstreamStatus = status;
      // mangle 期间:对端其实已经导入成功,网关却回一个不带 ash 标记的 502。
      if (mangle) ctx.reply(502, { error: "gateway lost upstream" });
      else ctx.reply(status, body);
    },
  });
  const manglerUrl = mangler.url;
  await assert.rejects(
    exportHandoff(mangleTaskId, { targetUrl: manglerUrl, targetProjectId: peerProject.id, autoResume: false }),
    (e: unknown) => e instanceof HandoffError && e.network && /对端可能已经收到/.test(e.message),
    "不带 ash 标记的 502 证明不了对端没落库,必须按「送达未知」处理而不是回滚",
  );
  assert.equal(mangleUpstreamStatus, 200, "前提:对端确实导入成功了(网关才有 200 可篡改)");
  assert.equal((await fetch(`${peerUrl}/api/tasks/${mangleTaskId}`)).status, 200, "对端确实持有这份任务");
  const mangledMarker = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, mangleTaskId))).at(0)!).handoff!,
  ) as { pending?: boolean; transferId?: string };
  assert.equal(mangledMarker.pending, true, "送达未知必须保留 pending——回滚标记就等于放任本机双跑");
  assert.ok(handoffBlockReason(JSON.stringify(mangledMarker)), "pending 态继续硬拦本机启动");
  // 网关恢复直通后原样重试:对端凭同一个 transferId 幂等收口,pending 改写成确认态。
  mangle = false;
  const mangleCloseout = await exportHandoff(mangleTaskId, {
    targetUrl: manglerUrl, targetProjectId: peerProject.id, autoResume: false,
  });
  assert.equal(mangleCloseout.ok, true);
  assert.ok(mangleCloseout.notes.some((n) => n.includes("幂等收口")), "重试应撞上幂等收口而不是重复导入");
  const mangleSettled = JSON.parse(
    ((await db.select().from(tasks).where(eq(tasks.id, mangleTaskId))).at(0)!).handoff!,
  ) as { pending?: boolean; transferId?: string };
  assert.ok(!mangleSettled.pending, "收口后 pending 改写成确认态");
  assert.equal(mangleSettled.transferId, mangledMarker.transferId, "收口必须沿用同一个 transferId");
  await mangler.close();

  console.log("test-handoff ok");
} finally {
  if (peer) {
    peer.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { peer?.kill("SIGKILL"); resolve(); }, 5_000);
      peer!.on("exit", () => { clearTimeout(t); resolve(); });
    });
  }
  try { closeDstDb?.(); } catch {}
  await releaseTmpDb();
  // Windows 上句柄释放有滞后(对端进程刚被杀),EBUSY 时重试而不是把真实测试结果盖掉。
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

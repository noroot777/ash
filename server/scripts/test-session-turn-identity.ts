// 回合身份与完整性：**走真实起跑链路**（`runTask` / `continueTask` + PATH 上的假 CLI），
// 不是往库里种好看的数字。
//
// 为什么非得这么跑：第 3 轮那条「中间缺一轮」的用例直接 `turnsStarted: 3` 种进去，于是测试
// 全绿、生产入口照样漏——普通 fresh run（`task-run.ts`，绝大多数任务走的就是它）压根没写过
// 这个计数，少计的那一次正好抵掉后面真缺的那一轮，第二轮做出来的图被静默滤掉
// （第 4 轮审查必须修 1）。判据必须架在真实写端上。
//
// 假 CLI 只写文件、吐几行 JSONL 就退出，不调模型、不花钱。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("session-turn-identity");
const stage = realpathSync(mkdtempSync(join(tmpdir(), "ash-turn-identity-")));
// **自己的舞台自己清**。挂在 `exit` 上而不是包一层 try/finally：这份是顶层 await 平铺的
// 脚本,而且断言失败走的是未捕获异常那条路——`exit` 钩子两种结局都盖得住。只删这一次
// 自己建的那个目录,别人留下的不碰。
process.on("exit", () => {
  try { rmSync(stage, { recursive: true, force: true }); } catch { /* Windows 上文件还开着就留给下次 */ }
});
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.ASH_UPLOADS_DIR = join(stage, "uploads");
// spawn.ts 的隔离闸默认不许真起执行器。这条测试要的就是真走完 spawn 链路——而 PATH 上那个
// `codex` 是下面亲手种的假货。
process.env.ASH_ALLOW_REAL_AGENT = "1";
mkdirSync(process.env.ASH_RUNS_DIR, { recursive: true });

// ── 假 codex：每次运行往 output/ 写一张图,顺便把运行次数记在盘上 ──────────────
const bin = join(stage, "bin");
mkdirSync(bin, { recursive: true });
const fakeJs = join(bin, "fake-codex.mjs");
writeFileSync(fakeJs, `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli 0.147.0'); process.exit(0); }
const args = process.argv.slice(2);
const resumeAt = args.indexOf('resume');
const countPath = join(process.cwd(), '.fake-run-count');
const count = (existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) : 0) + 1;
writeFileSync(countPath, String(count));
mkdirSync(join(process.cwd(), 'output'), { recursive: true });
writeFileSync(join(process.cwd(), 'output', 'run-' + count + '.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><text y="40">run ' + count + '</text></svg>');
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
emit({ type: 'thread.started', thread_id: resumeAt >= 0 ? args[resumeAt + 1] : '01a03415-e32e-72d2-8510-26a3beb2832f' });
emit({ type: 'item.completed', item: { type: 'agent_message', text: '第 ' + count + ' 次运行的海报（测试桩）' } });
emit({ type: 'turn.completed' });
setTimeout(() => process.exit(0), 50);
`);
writeFileSync(join(bin, "codex"),
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeJs)} "$@"\n`, { mode: 0o755 });
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { agents, appSettings, projects, sessions, tasks } = await import("../src/db/schema.js");
const { readTaskArtifacts } = await import("../src/task-artifacts.js");
const { recordTurnSpan } = await import("../src/session-turns.js");
const { runTask } = await import("../src/task-run.js");
const { continueTask } = await import("../src/orchestrator.js");

await ensureSchema();
await db.insert(appSettings).values({ key: "instanceMode", value: JSON.stringify("single") });
await db.insert(agents).values({ id: "fake-codex", name: "fake codex", type: "codex", isDefault: true });

const base = Date.now() - 12 * 60 * 60 * 1000;
const stamp = (minutes: number) => new Date(base + minutes * 60000).toISOString();
const git = (root: string, args: string[], minutes = -60) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8",
  env: { ...process.env, GIT_AUTHOR_DATE: stamp(minutes), GIT_COMMITTER_DATE: stamp(minutes) },
});
const initRepo = (name: string) => {
  const root = join(stage, name);
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "turn identity test"]);
  git(root, ["config", "user.email", "test@example.test"]);
  git(root, ["config", "commit.gpgSign", "false"]);
  git(root, ["config", "core.hooksPath", join(stage, "no-hooks")]);
  writeFileSync(join(root, ".gitignore"), "output/\n.fake-run-count\n.worktrees/\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "baseline"]);
  return root;
};
const addTask = async (taskId: string, root: string, title: string, extra: Record<string, unknown> = {}) => {
  const projectId = `project-${taskId}`;
  await db.insert(projects).values({ id: projectId, repoPath: root, name: title, createdAt: stamp(-60) });
  await db.insert(tasks).values({
    id: taskId, projectId, title, body: "回合身份回归；只跑本地桩", mode: "single", status: "backlog",
    agentType: "codex", autoTitle: false, useWorktree: false, mergeTargetBranch: "main", workflowMode: "free",
    createdAt: stamp(-50), updatedAt: stamp(-50), ...extra,
  });
};
const rootFor = (root: string, taskId: string) =>
  ({ path: root, repo: root, projectId: `project-${taskId}`, branch: "main", gitRepo: true, source: "session" }) as never;
const listing = (root: string, taskId: string) => readTaskArtifacts(taskId, rootFor(root, taskId));
const paths = (result: { artifacts: { path: string }[] }) => result.artifacts.map((a) => a.path).sort();
const sessionRow = async (taskId: string, sessionId?: string) =>
  (await dbClient.execute(
    `SELECT turns_started, turns_lost, turns_base, turns_base_approx FROM sessions
      WHERE task_id='${taskId}'${sessionId ? ` AND id='${sessionId}'` : ""}`,
  )).rows[0];
const turnRows = async (taskId: string) =>
  (await dbClient.execute(`SELECT started_at, ended_at FROM session_turns WHERE task_id='${taskId}' ORDER BY started_at`)).rows;
const settle = () => new Promise((resolve) => setTimeout(resolve, 3200));
/**
 * 续聊**同一行会话**。显式指定 `resumeSessionId`,因为这条测试要验的是「一行会话上的多个
 * 回合」（报告里那个场景),而不是候选筛选那一套（profile / 归属人 / slash）——假 CLI 不写
 * rollout 文件,候选筛选会判它接不上、另开一行,那样每行各自只有一个回合,压根复现不了。
 */
const resumeSame = async (taskId: string, text: string) => {
  const row = (await dbClient.execute(`SELECT id FROM sessions WHERE task_id='${taskId}' ORDER BY started_at LIMIT 1`)).rows[0];
  // 真实 CLI 会把自己的会话 id 写回这一列,`resuming` 就是看它（orchestrator.ts:380）。
  // 假 CLI 吐的 thread.started 在这个舞台上解析不出来,补上它才进得了复用分支——补的是
  // **前置条件**,被测的那段 update 和 openTurn 仍然是真跑。
  await dbClient.execute(
    `UPDATE sessions SET cli_session_id='01a03415-e32e-72d2-8510-26a3beb2832f' WHERE id='${String(row.id)}' AND (cli_session_id IS NULL OR cli_session_id='')`,
  );
  await continueTask(taskId, text, { resumeSessionId: String(row.id) });
};

// ── ① fresh run 这一处就得把计数记上（第 4 轮审查必须修 1 的根因入口）────────────
{
  const root = initRepo("fresh-run");
  await addTask("TiFresh00001", root, "真实 fresh run 的回合计数");
  await runTask("TiFresh00001");
  const row = await sessionRow("TiFresh00001");
  assert.equal(Number(row.turns_started), 1, "fresh run 必须把回合数记成 1——漏了它,少计的那一次会抵掉后面真缺的那一轮");
  assert.equal(Number(row.turns_base), 0, "升级后新建的会话没有未知历史");
  const turns = await turnRows("TiFresh00001");
  assert.equal(turns.length, 1, "回合开始就该落一行");
  assert(turns[0].ended_at, "正常跑完的回合要收过口");
  assert.equal(readFileSync(join(root, ".fake-run-count"), "utf8"), "1", "假 CLI 确实跑过（证明走的是真实 spawn 链路）");
}

// ── ② 三轮、中间那轮「连开始都没写进去」：第三轮之后仍要认它、仍要披露 ──────────
{
  const root = initRepo("insert-blocked");
  await addTask("TiNoRow00001", root, "中间那轮的记录整条写不进去");
  await runTask("TiNoRow00001");
  await settle();
  await dbClient.executeMultiple(
    "CREATE TRIGGER block_insert BEFORE INSERT ON session_turns WHEN NEW.task_id='TiNoRow00001' BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  await resumeSame("TiNoRow00001", "第二轮");
  await dbClient.executeMultiple("DROP TRIGGER block_insert;");
  const second = await listing(root, "TiNoRow00001");
  assert(paths(second).includes("output/run-2.svg"), "第二轮做出来的图当场要能看见");
  await settle();
  await resumeSame("TiNoRow00001", "第三轮");
  const third = await listing(root, "TiNoRow00001");
  const blocked = await sessionRow("TiNoRow00001");
  // 行和计数是**同一个原子批**（见 session-turns.ts）：第二轮那一批整个回滚,所以计数停在 2。
  // 「刚才漏了一轮」这件事只有写端自己知道,它记在 turns_lost 上——两个数仍然相等,对账那一道
  // 在这种情形下一点痕迹都看不出来（第 5 轮审查必须修 2.3）。
  assert.equal(Number(blocked.turns_started), 2, "成功落账的是第一、第三轮");
  assert.equal(Number(blocked.turns_lost), 1, "整批没写成的那一轮要留下持久标记,否则缺口在库里无迹可寻");
  assert.equal((await turnRows("TiNoRow00001")).length, 2, "中间那轮一行都没写上");
  // 这就是报告里那条：第三轮正常落账后,第二轮的海报从清单里消失、还什么都不说。
  assert(paths(third).includes("output/run-2.svg"), "第三轮成功落账不能把第二轮的图抹掉");
  assert(third.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `缺口要照实说出来,实际提示：${JSON.stringify(third.incomplete)}`);
}

// ── ③ 三轮、中间那轮「开始了没收口」：逐行事实,后来成功的一轮抵消不掉 ──────────
{
  const root = initRepo("update-blocked");
  await addTask("TiNoEnd00001", root, "中间那轮的收尾写不进去");
  await runTask("TiNoEnd00001");
  await settle();
  await dbClient.executeMultiple(
    "CREATE TRIGGER block_close BEFORE UPDATE ON session_turns WHEN NEW.task_id='TiNoEnd00001' BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  await resumeSame("TiNoEnd00001", "第二轮");
  await dbClient.executeMultiple("DROP TRIGGER block_close;");
  await settle();
  await resumeSame("TiNoEnd00001", "第三轮");
  const third = await listing(root, "TiNoEnd00001");
  const turns = await turnRows("TiNoEnd00001");
  assert.equal(turns.length, 3, "三轮各有一行（开始就落）");
  assert.equal(turns.filter((t) => !t.ended_at).length, 1, "中间那轮停在「开了没收口」");
  assert(paths(third).includes("output/run-2.svg"), "没收口的那一轮做出来的图照样是它的");
  assert(third.incomplete.some((note) => note.includes("没留下收尾时刻")),
    `没收口要照实说出来,实际提示：${JSON.stringify(third.incomplete)}`);
}

// ── ④ 正常在飞的那一轮不是「写入失败」（第 4 轮审查 N1）──────────────────────
{
  const root = initRepo("healthy-live");
  await addTask("TiLive000001", root, "正常继续运行中", { status: "running" });
  await db.insert(sessions).values({
    id: "session-TiLive000001", taskId: "TiLive000001", role: "single", agentType: "codex", executor: "fixture",
    // 计数只算第一轮：第二轮那一笔由 `openTurn` 自己加（它跟那行回合记录同批写,见
    // session-turns.ts）,这里种两个就等于替它多加了一次,反而凭空多出一个缺口。
    cwd: root, startedAt: stamp(0), endedAt: null, turnStartedAt: stamp(120), turnsStarted: 1, turnsBase: 0,
    activeMs: 30 * 60000, exitStatus: null,
  });
  await recordTurnSpan({ sessionId: "session-TiLive000001", taskId: "TiLive000001", cwd: root, startedAt: stamp(0), endedAt: stamp(10) });
  // 第二轮正在跑：开始行落了、还没收口。
  const { openTurn } = await import("../src/session-turns.js");
  await openTurn({ sessionId: "session-TiLive000001", taskId: "TiLive000001", cwd: root, startedAt: stamp(120) });
  mkdirSync(join(root, "output"), { recursive: true });
  const live = join(root, "output", "live.svg");
  writeFileSync(live, "<svg xmlns='http://www.w3.org/2000/svg'><text>live</text></svg>");
  const at = new Date(stamp(125));
  utimesSync(live, at, at);
  const result = await listing(root, "TiLive000001");
  assert(paths(result).includes("output/live.svg"), "正在跑的那一轮做出来的东西当然算它的");
  assert(!result.incomplete.some((note) => note.includes("写入失败") || note.includes("没留下收尾时刻")),
    `健康的在飞回合不该报成写入失败,实际提示：${JSON.stringify(result.incomplete)}`);
}

// ── ⑤ 升级前的历史不当「抵扣额」（第 4 轮审查「升级历史也会抵消后续缺口」）─────────
{
  const root = initRepo("upgraded");
  await addTask("TiUpgrad0001", root, "升级前已经跑过几轮", { status: "failed" });
  // 老库形状：两列都还是 NULL，但它名下已经有两条历史回合记录。
  await db.insert(sessions).values({
    id: "session-TiUpgrad0001", taskId: "TiUpgrad0001", role: "single", agentType: "codex", executor: "fixture",
    cwd: root, startedAt: stamp(0), endedAt: stamp(130), turnStartedAt: stamp(120),
    turnsStarted: null, turnsBase: null, activeMs: 30 * 60000, exitStatus: 0,
  });
  for (const [from, to] of [[0, 10], [120, 130]]) {
    await recordTurnSpan({ sessionId: "session-TiUpgrad0001", taskId: "TiUpgrad0001", cwd: root, startedAt: stamp(from), endedAt: stamp(to) });
  }
  const { migrateSessionTurnIdentity } = await import("../src/db/migrate-session-turns.js");
  await migrateSessionTurnIdentity(dbClient);
  const upgraded = await sessionRow("TiUpgrad0001");
  assert.equal(Number(upgraded.turns_base), 2, "升级时把已知的历史回合数记成基数");
  assert.equal(upgraded.turns_started, null, "升级本身不伪造「升级后开过几轮」");
  assert.equal(Number(upgraded.turns_base_approx), 1, "基数只是下界,这个标记才是读端披露「升级前算不准」的判据");
  // 升级前的历史算不准，要照实说——不能因为「行数对得上」就宣称完整。
  const afterUpgrade = await listing(root, "TiUpgrad0001");
  assert(afterUpgrade.incomplete.some((note) => note.includes("升级之前")),
    `升级前那段的未知要说出来,实际提示：${JSON.stringify(afterUpgrade.incomplete)}`);
  // 升级后又跑一轮、且这一轮的记录整条没写上：缺口必须报出来,不能被两条历史行抵扣掉。
  await dbClient.execute(
    `UPDATE sessions SET turns_started=COALESCE(turns_started,0)+1, turn_started_at='${stamp(240)}', ended_at='${stamp(250)}' WHERE task_id='TiUpgrad0001'`,
  );
  const missed = await listing(root, "TiUpgrad0001");
  assert(missed.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `升级后缺的那一轮不能被历史行抵扣,实际提示：${JSON.stringify(missed.incomplete)}`);
}

// ── ⑥ 重复行不能冒充「多跑了一轮」去抵掉真缺口 ─────────────────────────────
{
  const root = initRepo("dupes");
  await addTask("TiDupes00001", root, "同一回合两行", { status: "failed" });
  await db.insert(sessions).values({
    id: "session-TiDupes00001", taskId: "TiDupes00001", role: "single", agentType: "codex", executor: "fixture",
    cwd: root, startedAt: stamp(0), endedAt: stamp(250), turnStartedAt: stamp(240),
    turnsStarted: 2, turnsBase: 0, activeMs: 30 * 60000, exitStatus: 0,
  });
  await recordTurnSpan({ sessionId: "session-TiDupes00001", taskId: "TiDupes00001", cwd: root, startedAt: stamp(0), endedAt: stamp(10) });
  // 唯一索引先拦一道：同一个回合再收一次口（接回、重试、旧调度台也来收）只更新那一行。
  await recordTurnSpan({ sessionId: "session-TiDupes00001", taskId: "TiDupes00001", cwd: root, startedAt: stamp(0), endedAt: stamp(20) });
  assert.equal((await turnRows("TiDupes00001")).length, 1, "重放收尾不该多出一行");
  assert.equal(String((await turnRows("TiDupes00001"))[0].ended_at), stamp(10), "认第一次收口,不被改晚");
  // 老库上索引可能没建成（迁移那一步失败）：读端自己也要按身份去重,否则第二轮的真缺口
  // 会被这条重复行抵掉。
  await dbClient.execute("DROP INDEX IF EXISTS session_turns_turn_key");
  await dbClient.execute(
    `INSERT INTO session_turns (id, session_id, task_id, cwd, started_at, ended_at)
     VALUES ('dupe-row', 'session-TiDupes00001', 'TiDupes00001', '${root}', '${stamp(0)}', '${stamp(10)}')`,
  );
  assert.equal((await turnRows("TiDupes00001")).length, 2, "这一步要的就是库里真有两行");
  const result = await listing(root, "TiDupes00001");
  assert(result.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `两行同一个回合不能顶掉第二轮的缺口,实际提示：${JSON.stringify(result.incomplete)}`);
  // 恢复现场：那道索引是**全库**的,留着不建会让后面几组测不出「同一个身份只有一行」。
  await dbClient.execute("DELETE FROM session_turns WHERE id='dupe-row'");
  await dbClient.execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS session_turns_turn_key ON session_turns(session_id, started_at)",
  );
}

// ── ⑦ 崩过的老会话不因为任务又跑起来而被当成「还在写」（第 5 轮审查必须修 1）──────
{
  const root = initRepo("stale-live");
  await addTask("TiStale00001", root, "崩过的老会话不随新一轮复活", { status: "running" });
  const { openTurn, clearTurnActive } = await import("../src/session-turns.js");
  const insertSession = async (id: string, startedAt: string) => {
    await db.insert(sessions).values({
      id, taskId: "TiStale00001", role: "single", agentType: "codex", executor: "fixture",
      cwd: root, startedAt, endedAt: null, turnStartedAt: startedAt,
      turnsBase: 0, turnsBaseApprox: false, activeMs: 0, exitStatus: null,
    });
    await openTurn({ sessionId: id, taskId: "TiStale00001", cwd: root, startedAt });
  };
  // 上一次进程里开了一个回合,崩了没收口。库里那一行**就该**停在「开了没收口」——真实的
  // 重启对账只把任务落 failed,不伪造它的收尾时刻,那是合理保留未知。
  await insertSession("session-stale-old", stamp(0));
  // ash 重启：进程内的活动登记跟着没了（它本来就只代表「这个进程还在跑这个回合」）。
  clearTurnActive("session-stale-old", stamp(0));
  // 任务又跑起来了：新开一行会话,新的回合正在跑（这一轮登记在册）。
  await insertSession("session-stale-new", stamp(600));

  mkdirSync(join(root, "output"), { recursive: true });
  // 歇着的那几个钟头里,同一个目录上出现的东西（并行跑的别的任务做的）。
  const foreign = join(root, "output", "someone-else.svg");
  writeFileSync(foreign, "<svg xmlns='http://www.w3.org/2000/svg'><text>else</text></svg>");
  const foreignAt = new Date(stamp(300));
  utimesSync(foreign, foreignAt, foreignAt);
  // 正在跑的这一轮自己做的。
  const mine = join(root, "output", "new-run.svg");
  writeFileSync(mine, "<svg xmlns='http://www.w3.org/2000/svg'><text>mine</text></svg>");
  const mineAt = new Date(stamp(610));
  utimesSync(mine, mineAt, mineAt);

  const result = await listing(root, "TiStale00001");
  assert(paths(result).includes("output/new-run.svg"), "正在跑的这一轮做出来的当然算它的");
  // 修复前：任务是 running,于是**每一条**未收口的会话都被当成还在写——老那条从 stamp(0)
  // 一路开到无穷、还不标 approx。后果是两条：那句「没留下收尾时刻」整个消失,歇着期间别人
  // 做的东西被当成实测证据收进来。
  assert(result.incomplete.some((note) => note.includes("没留下收尾时刻")),
    `崩过那一轮的未知不能因为任务又跑起来就消失,实际提示：${JSON.stringify(result.incomplete)}`);
  assert(result.incomplete.some((note) => note.includes("按估出来的时间段")),
    `靠推断认进来的东西必须说成候选,实际提示：${JSON.stringify(result.incomplete)}`);
}

// ── ⑧ 同一个回合身份被开两次只能计一次（第 5 轮审查必须修 2.1）──────────────────
{
  const root = initRepo("same-start-twice");
  await addTask("TiTwice00001", root, "同一个回合起点被开两次", { status: "failed" });
  const { openTurn, resumedTurnFields } = await import("../src/session-turns.js");
  await db.insert(sessions).values({
    id: "session-twice", taskId: "TiTwice00001", role: "lead", agentType: "codex", executor: "fixture",
    cwd: root, startedAt: stamp(0), endedAt: stamp(20), turnStartedAt: stamp(0),
    turnsBase: 0, turnsBaseApprox: false, activeMs: 20 * 60000, exitStatus: 0,
  });
  // 团队那条路的真实调用序列：`openLead` 落一次,紧接着它下面那句 `beginTurn(lead, turnStart)`
  // 用**同一个起点**再开一次（team/session.ts 的 openTurn 与 beginTurn）。
  const open = () => openTurn({ sessionId: "session-twice", taskId: "TiTwice00001", cwd: root, startedAt: stamp(0) });
  await open();
  await open();
  await recordTurnSpan({ sessionId: "session-twice", taskId: "TiTwice00001", cwd: root, startedAt: stamp(0), endedAt: stamp(20) });
  const row = await sessionRow("TiTwice00001", "session-twice");
  assert.equal(Number(row.turns_started), 1, "同一个回合身份只能计一次——多计一次就永远报「缺一个回合记录」");
  assert.equal((await turnRows("TiTwice00001")).length, 1, "同一个身份也只该有一行");
  const result = await listing(root, "TiTwice00001");
  assert(!result.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `团队的第一个回合不该被报成缺口,实际提示：${JSON.stringify(result.incomplete)}`);
  // 护栏：计数一旦搬回字段 helper,八处起跑入口里凡是「先写字段、再 beginTurn」的那几条
  // 又会加两次。这条断言比上面那两条便宜,而且直接钉住不变量住在哪一层。
  assert(!("turnsStarted" in resumedTurnFields(stamp(0))),
    "回合计数只能由 openTurn 按身份加,不能回到字段 helper 里");
}

// ── ⑨ 升级那一刻一行记录都没有、之后又跑过一轮：未知历史照样要披露（必须修 2.2 读端）──
{
  const root = initRepo("upgraded-empty");
  await addTask("TiUpEmpt0001", root, "升级前跑过但一行记录都没留下", { status: "failed" });
  const { migrateSessionTurnIdentity } = await import("../src/db/migrate-session-turns.js");
  const { openTurn } = await import("../src/session-turns.js");
  // 老库形状：两列都是 NULL,而且它名下**一行回合记录都没有**（那一版压根不写这张表）。
  await db.insert(sessions).values({
    id: "session-upempty", taskId: "TiUpEmpt0001", role: "single", agentType: "codex", executor: "fixture",
    cwd: root, startedAt: stamp(0), endedAt: stamp(130), turnStartedAt: stamp(0),
    turnsStarted: null, turnsBase: null, activeMs: 30 * 60000, exitStatus: 0,
  });
  await migrateSessionTurnIdentity(dbClient);
  const upgraded = await sessionRow("TiUpEmpt0001", "session-upempty");
  assert.equal(Number(upgraded.turns_base), 0, "数得出来的下界就是 0——那一版压根没写过这张表");
  assert.equal(Number(upgraded.turns_base_approx), 1, "下界是 0 不等于「确定没跑过」");
  // 升级之后又跑了一轮（这一轮有记录、也对得上账）。此时「升级前缺没缺」仍然无从得知,
  // 而按「base 大于 0」判的话这条会话会被当成没有未知历史——那正是必须修 2.2 的读端一侧。
  await openTurn({ sessionId: "session-upempty", taskId: "TiUpEmpt0001", cwd: root, startedAt: stamp(200) });
  await recordTurnSpan({ sessionId: "session-upempty", taskId: "TiUpEmpt0001", cwd: root, startedAt: stamp(200), endedAt: stamp(210) });
  const result = await listing(root, "TiUpEmpt0001");
  assert(result.incomplete.some((note) => note.includes("升级之前")),
    `下界是 0 的那种老会话,它的未知历史同样要说出来,实际提示：${JSON.stringify(result.incomplete)}`);
  assert(!result.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `升级后那一轮账是对得上的,不该报成缺口,实际提示：${JSON.stringify(result.incomplete)}`);
}

console.log("✓ turn identity: fresh run 记上计数、两种缺口都认且披露、整批失败留下持久标记、在飞不误报、崩过的老会话不复活、同一身份只计一次、升级历史不抵扣（含下界为 0 的）、重复行不顶替");
await dbClient.close();
releaseTmpDb();

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
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
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
  assert(second.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `库还坏着、欠账只在内存里的那一刻,缺口就得照实说,实际提示：${JSON.stringify(second.incomplete)}`);
  await settle();
  await resumeSame("TiNoRow00001", "第三轮");
  const third = await listing(root, "TiNoRow00001");
  const blocked = await sessionRow("TiNoRow00001");
  // 行和计数是**同一个原子批**（见 session-turns.ts）：第二轮那一批整个回滚,那一刻只有写端
  // 自己知道刚才漏了一轮,它**按身份**把这笔欠着（第 5 轮审查必须修 2.3）。库一恢复（第三轮
  // 开回合时）就按同一个身份把那行开始记录补上去 —— 所以计数是 3、表里也是 3 行,中间那轮
  // 从「整段会话都算不准」升级成「开了没收口」（第 1 轮审查 F2:压成一个无身份的数字的话,
  // 同一个身份后来补齐也消不掉它,读端只能继续把整条寿命算宽）。
  assert.equal(Number(blocked.turns_started), 3, "库恢复后那一轮的开始记录要按身份补回来");
  assert.equal(blocked.turns_lost ?? 0, 0, "欠账补成了真正的开始行,不该再往那个无身份的计数上记一笔");
  const rows = await turnRows("TiNoRow00001");
  assert.equal(rows.length, 3, `三轮各有一行（中间那行是补的）,实际：${JSON.stringify(rows)}`);
  assert.equal(rows.filter((row) => !row.ended_at).length, 1, "补回来的那一行只知道起点:它停在「开了没收口」");
  // 这就是报告里那条：第三轮正常落账后,第二轮的海报从清单里消失、还什么都不说。
  assert(paths(third).includes("output/run-2.svg"), "第三轮成功落账不能把第二轮的图抹掉");
  assert(third.incomplete.some((note) => note.includes("没留下收尾时刻")),
    `补回来的那一轮缺的是收尾时刻,得照实说,实际提示：${JSON.stringify(third.incomplete)}`);
}

// ── ②' 欠账补齐之后不许再制造假缺口（第 1 轮审查 F2）────────────────────────────
// 上一条验的是「缺口照实说」,这一条验的是**别多说**：按身份补齐之后,两段精确区间之间的
// 停顿就是确定的「它没在跑」,那期间别的任务在同一个目录里做的东西必须排除。压成一个无身份
// 的 `turns_lost` 数字时做不到这件事 —— 那个数字没人消得掉,读端只能把整条会话寿命算成宽的
// 一段,停顿里的外来产物又被收进来,面板还谎称「有一次连开始都没留下记录」。
{
  const root = initRepo("recovered-identity");
  await addTask("TiRecover0001", root, "欠账按身份补齐后不再扩大归属");
  await runTask("TiRecover0001");
  const firstEnd = Date.parse(String((await turnRows("TiRecover0001"))[0].ended_at));
  await settle();
  // 停顿里别的任务做的东西。mtime 显式钉在「第一轮收尾 + 落定余量」之后、第二轮开跑之前。
  const foreign = join(root, "output", "other-task-in-break.svg");
  writeFileSync(foreign, '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">another task</text></svg>');
  const foreignAt = (firstEnd + 2600) / 1000;
  utimesSync(foreign, foreignAt, foreignAt);
  await dbClient.executeMultiple(
    "CREATE TRIGGER block_recover BEFORE INSERT ON session_turns WHEN NEW.task_id='TiRecover0001' BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  await resumeSame("TiRecover0001", "第二轮(开始行写不进去)");
  await dbClient.executeMultiple("DROP TRIGGER block_recover;");
  await settle();
  await resumeSame("TiRecover0001", "第三轮(库已恢复)");
  const after = await listing(root, "TiRecover0001");
  assert(paths(after).includes("output/run-2.svg"), "欠账那一轮做出来的图仍然是它的");
  assert(!paths(after).includes("output/other-task-in-break.svg"),
    `两轮之间歇着的那段时间里别人做的东西不该混进来,实际清单：${JSON.stringify(paths(after))}`);
  assert(!after.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `那一轮的开始记录已经补回来了,不该还报它缺,实际提示：${JSON.stringify(after.incomplete)}`);
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

// ── ⑩ 结束时报错：图不能当场消失,重试也不能把中间别人做的东西当成实测（第 6 轮必须修 1）──
{
  const root = initRepo("end-failure");
  await addTask("TiEndErr0001", root, "结束时报错不留假活动身份");
  // 只拦「带收尾时刻的那次会话 UPDATE」:single-run 的收尾就卡在这里抛,于是**走不到**
  // recordTurnSpan ——活动登记只挂在正常收尾上的话,这条会话从此一直是「还在写」。
  await dbClient.executeMultiple(
    "CREATE TRIGGER block_end BEFORE UPDATE ON sessions WHEN NEW.task_id='TiEndErr0001' AND NEW.ended_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  await runTask("TiEndErr0001");
  await dbClient.executeMultiple("DROP TRIGGER block_end;");
  const sess = (await dbClient.execute(
    "SELECT id, ended_at FROM sessions WHERE task_id='TiEndErr0001'",
  )).rows[0];
  assert.equal(sess.ended_at, null, "这一步的前提：收尾时刻确实没写进去（真实的对账不伪造它）");
  // **全出口注销不变量**：收尾函数根本没跑完,活动身份也必须已经撤掉。这一条直接钉住
  // 「注销不依赖走到 recordTurnSpan」,不靠下游别的机制兜底（第 6 轮审查必须修 1）。
  const { activeTurnStarts } = await import("../src/session-turns.js");
  assert.equal(activeTurnStarts(String(sess.id)).size, 0,
    "结束时报错也要撤掉「正在跑」的身份——留着它,下次跑起来就从这个老起点开到无穷");
  // 修复前这里是 `incomplete=[]` 且清单为空：残留的活动登记让读端跳过了未收尾告警,
  // 那一轮既不出区间也不报未知,刚画好的图当场看不见。
  const after = await listing(root, "TiEndErr0001");
  assert(paths(after).includes("output/run-1.svg"), "异常收尾不能让这一轮刚做出来的图当场消失");
  assert(after.incomplete.some((note) => note.includes("没留下收尾时刻")),
    `异常收尾那一轮要照实说算不准,实际提示：${JSON.stringify(after.incomplete)}`);

  // 中间另一项任务在**同一个目录**里画一张,然后重试原任务。
  await settle();
  await addTask("TiEndOth0001", root, "停顿期间的另一项任务");
  await runTask("TiEndOth0001");
  await settle();
  await runTask("TiEndErr0001");
  assert.equal(activeTurnStarts(String(sess.id)).size, 0, "重试开的是新会话,崩过那条不该被重新登记成活动");
  const retried = await listing(root, "TiEndErr0001");
  assert(paths(retried).includes("output/run-3.svg"), "重试这一轮自己做的当然算它的");
  // 修复前：旧 session 的残留登记 + 任务重新 running ⇒ 它被当成 live,从那个老起点开到无穷
  // 且不标 approx,中间那张图被当成实测证据收进来,提示还是空的。
  assert(retried.incomplete.some((note) => note.includes("没留下收尾时刻")),
    `崩过那一轮的未知不能因为重试就消失,实际提示：${JSON.stringify(retried.incomplete)}`);
  if (paths(retried).includes("output/run-2.svg")) {
    // 它落在「开了没收口」那段推断区间里,所以可以列出来——但只能作为候选,不能冒充实测。
    assert(retried.incomplete.some((note) => note.includes("按估出来的时间段")),
      `中间那张图只能算候选,实际提示：${JSON.stringify(retried.incomplete)}`);
  }
}

// ── ⑪ 欠账一直持久化不了时,后来成功的一轮不能把它抹掉（第 6 轮审查必须修 2）────────
{
  const root = initRepo("lost-then-ok");
  await addTask("TiLost000001", root, "没确认的开始意图不能被忘掉");
  await runTask("TiLost000001");
  await settle();
  // 开始那一批整个回滚（身份和计数同生共死）。补账走的**也是**这个批（按身份补那行开始
  // 记录,见 session-turns.ts）,所以拦住它就等于「连欠账都持久化不了」那条路 —— 第 5 轮的
  // 实现到这里就只剩一句日志,把账忘了。
  await dbClient.executeMultiple(
    "CREATE TRIGGER block_turn_insert BEFORE INSERT ON session_turns WHEN NEW.task_id='TiLost000001' BEGIN SELECT RAISE(ABORT,'injected'); END;",
  );
  await resumeSame("TiLost000001", "第二轮");
  const second = await listing(root, "TiLost000001");
  assert(paths(second).includes("output/run-2.svg"), "第二轮做出来的图当场要能看见");
  assert.equal((await sessionRow("TiLost000001")).turns_lost, null, "这一步的前提：库里一个字都没有");
  assert(second.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `库里一个字都没有时,内存里那笔未确认的意图要算进缺口,实际提示：${JSON.stringify(second.incomplete)}`);
  // 换一道**只对那一个身份**坏着的闸：第三轮自己照常落账,欠着的那一笔补不进去。这才是
  // 「后来成功的一轮会不会把那笔账抹掉」的那个问题 —— 两边都通的话根本问不出来。
  await dbClient.executeMultiple("DROP TRIGGER block_turn_insert;");
  const owed = String((await dbClient.execute(
    "SELECT turn_started_at FROM sessions WHERE task_id='TiLost000001'",
  )).rows[0].turn_started_at);
  await dbClient.executeMultiple(
    `CREATE TRIGGER block_owed BEFORE INSERT ON session_turns WHEN NEW.started_at='${owed}' BEGIN SELECT RAISE(ABORT,'injected'); END;`,
  );
  await settle();
  await resumeSame("TiLost000001", "第三轮");
  const third = await listing(root, "TiLost000001");
  await dbClient.executeMultiple("DROP TRIGGER block_owed;");
  // 修复前：第三轮一落账,成功计数和成功身份数重新相等,图 2 从清单里消失且一个字都不说。
  assert(paths(third).includes("output/run-2.svg"), "第三轮成功落账不能把第二轮的图抹掉");
  assert(third.incomplete.some((note) => note.includes("连开始都没在库里留下记录")),
    `缺口要照实说出来,实际提示：${JSON.stringify(third.incomplete)}`);
  const rows = await turnRows("TiLost000001");
  assert.equal(rows.length, 2, `补不进去的那一轮库里仍然一行都没有,实际：${JSON.stringify(rows)}`);
}

// ── ⑫ 讨论(duet)初始化就抛：别留下一个谁都不会来注销的活动身份（第 7 轮审查必须修 1）──
{
  const root = initRepo("duet-setup");
  await addTask("TiDuetIn0001", root, "讨论初始化失败不留假活动身份", {
    mode: "duet",
    // 一轮就收、不开人工闸：这条用例要的是**起跑那一段**,不是讨论本身(开着闸它会停在
    // 等人拍板那儿永远不返回)。
    duet: JSON.stringify({ topic: "随便聊一轮就够", voiceA: "codex", voiceB: "codex", maxRounds: 1, gateG1: "off" }),
  });
  // **真实的初始化失败**：讨论的日志目录该在的位置先放一个普通文件,`mkdirSync(runDir)` 当场
  // 抛 EEXIST。那一句在 runTurn 里排在 `openTurn` **之后**、消费循环的 try **之前**,所以它
  // 正好打在「身份已经拿到、保护还没开始」那个窗口上（第 7 轮报告的复现用的就是这一手）。
  const runsDir = process.env.ASH_RUNS_DIR as string;
  writeFileSync(join(runsDir, "TiDuetIn0001"), "占住这个位置,让建日志目录那一步真的抛");
  const { runDuet } = await import("../src/duet/index.js");
  const { activeTurnStarts: active } = await import("../src/session-turns.js");
  await runDuet("TiDuetIn0001");
  const crashed = (await dbClient.execute(
    "SELECT id, ended_at FROM sessions WHERE task_id='TiDuetIn0001'",
  )).rows;
  assert(crashed.length > 0, "这一步的前提：讨论者的会话行已经落库了（身份就是在那之后拿的）");
  assert(crashed.every((row) => row.ended_at === null),
    "这一步的前提：初始化就抛了,这几行压根没走到收尾（真实的未知不伪造成已收尾）");
  // 修复前：两位讨论者各留一个活动身份,而 runTurn 的 finally 开得太晚、外层 duet/index 的
  // finally 只还回合锁,没有任何人会来注销它们。
  for (const row of crashed) {
    assert.equal(active(String(row.id)).size, 0,
      "初始化抛出来也要撤掉「正在跑」的身份——留着它,任务重跑时这条会话就从老起点开到无穷");
  }

  // 修好位置、隔开运行另一项画图任务,再重跑原讨论（报告里的时序）。
  rmSync(join(runsDir, "TiDuetIn0001"));
  // 先等第一次那两个假 CLI 把该写的写完再拍快照:它们在初始化抛出之前就已经 spawn 了,
  // 写盘比抛出晚一点,算进「中间那张」会把断言钉在错误的文件上。
  await settle();
  const outputs = () => {
    try { return readdirSync(join(root, "output")); } catch { return [] as string[]; }
  };
  const before = new Set(outputs());
  await addTask("TiDuetOth0001", root, "停顿期间的另一项任务");
  await runTask("TiDuetOth0001");
  await settle();
  const middle = outputs().filter((name) => !before.has(name));
  assert.equal(middle.length, 1, `中间那项任务应该只画一张,实际：${JSON.stringify(middle)}`);
  const middlePath = `output/${middle[0]}`;
  await runDuet("TiDuetIn0001");
  for (const row of crashed) {
    assert.equal(active(String(row.id)).size, 0, "重跑开的是新会话,崩过那两条不该被重新登记成活动");
  }
  // 这一步的前提:报告是在**重跑正在跑着**的时候读的清单,而这条脚本读不到那个瞬间——
  // `running` 就是真实入口起跑时写的那个状态（runDuet 的第一句 setStatus）,这里只把那一刻
  // 摆出来。被断言的是读端怎么解释「老会话未收口 + 任务在飞」,不是状态本身。
  await dbClient.execute("UPDATE tasks SET status='running' WHERE id='TiDuetIn0001'");
  const listed = await listing(root, "TiDuetIn0001");
  // 修复前：残留登记 + 任务在飞 ⇒ 老会话被判 live,从那个老起点一路开到无穷,中间那张图被
  // 当成实测证据收进清单,`incomplete` 一个字都没有。
  assert(listed.incomplete.some((note) => note.includes("没留下收尾时刻")),
    `崩掉那两轮的未知要照实说出来,实际提示：${JSON.stringify(listed.incomplete)}`);
  if (paths(listed).includes(middlePath)) {
    assert(listed.incomplete.some((note) => note.includes("按估出来的时间段")),
      `中间那张图只能算候选、不能冒充实测,实际提示：${JSON.stringify(listed.incomplete)}`);
  }
}

// ── ⑬ 注销之后内存登记要对称收回（第 7 轮审查 N1）──────────────────────────────
{
  const { openTurn, recordTurnSpan: close, closeSessionTurns, activeRegistrySize } = await import("../src/session-turns.js");
  const idle = activeRegistrySize();
  await db.insert(sessions).values({
    id: "session-reclaim", taskId: "TiReclaim0001", role: "single", agentType: "codex", executor: "fixture",
    cwd: stage, startedAt: stamp(0), endedAt: null, turnStartedAt: stamp(0),
    turnsBase: 0, turnsBaseApprox: false, activeMs: 0, exitStatus: null,
  });
  await openTurn({ sessionId: "session-reclaim", taskId: "TiReclaim0001", cwd: stage, startedAt: stamp(0) });
  const busy = activeRegistrySize();
  assert.equal(busy.sessions, idle.sessions + 1, "这一步的前提：登记确实进去了");
  assert.equal(busy.tasks, idle.tasks + 1, "这一步的前提：任务那张反向索引也进去了");
  // 正常收尾走的是 recordTurnSpan（它只知道一个起点,拿不到 taskId）——反向索引的回收必须
  // 在这条路上就发生,否则只有 closeTaskTurns 会删,而 duet/team 两条路压根不走它。
  await close({ sessionId: "session-reclaim", taskId: "TiReclaim0001", cwd: stage, startedAt: stamp(0), endedAt: stamp(1) });
  assert.deepEqual(activeRegistrySize(), idle,
    "最后一个身份注销之后,会话和任务两张表都要收回去（跑过的 id 不许永久留在内存里）");
  // 另一条注销路径（消费循环结束那种）同样要收干净。
  await openTurn({ sessionId: "session-reclaim", taskId: "TiReclaim0001", cwd: stage, startedAt: stamp(5) });
  closeSessionTurns("session-reclaim");
  assert.deepEqual(activeRegistrySize(), idle, "closeSessionTurns 这条路也要对称回收");
}

console.log("✓ turn identity: fresh run 记上计数、两种缺口都认且披露、整批失败留下持久标记、在飞不误报、崩过的老会话不复活、同一身份只计一次、升级历史不抵扣（含下界为 0 的）、重复行不顶替、异常收尾不留假活动身份、未确认的开始意图不被后来成功的一轮抹掉、讨论初始化抛出也不留无主的活动身份、注销后内存登记对称回收");
await dbClient.close();
releaseTmpDb();

// 预览播种（server/src/preview-seed.ts）。
//
// 这条测试钉的是**「什么不该被搬、搬了必须洗掉什么」比「什么该被搬」更要命**：
//
//   · 少搬了 = 预览里一个执行器都没有、任务列表空空如也，凡是得有数据才看得见的改动
//     一概验不了（2026-08-07 第一轮验证正是卡在这儿）。烦，但一眼看得见。
//   · 多搬了、或者搬了没洗 = 副本上的调度器拿着**真** pid、真 running 任务去接管、
//     推进队列、甚至停掉本机正在干活的 agent。看不见，且损坏的是**主实例**的活。
//
// 所以两张名单都是正着列的（新表默认进不来），且快照档多一条硬约束：schedules /
// scheduled_messages 一张都不许进——那两张一进副本，预览就会到点替你派活、替你发消息。
//
// 跑法：npm -w server run test:preview-seed
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const root = mkdtempSync(join(tmpdir(), "harness-preview-seed-"));
// preview-seed 会 import db/index.js（模块加载时就打开库）。先把库指到临时目录，
// 免得跑一次测试就在仓库的 data/ 下多一个文件。
process.env.HARNESS_DB = join(root, "app.db");
const { CONFIG_TABLES, SNAPSHOT_TABLES, copyConfigTables, copyTables, sanitizeSnapshot } =
  await import("../src/preview-seed.js");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

// —— 名单本身（不碰数据库）。加表的人不会来读这份文件，但会跑测试 ——
for (const forbidden of ["tasks", "sessions", "usage_cumulative_snapshots", "groups", "queues", "queue_items", "schedules", "scheduled_messages", "notes"]) {
  check(`config 档白名单里没有 ${forbidden}`, (CONFIG_TABLES as readonly string[]).includes(forbidden), false);
}
for (const forbidden of ["schedules", "scheduled_messages"]) {
  // 这两张是「会替你干活」的：一进副本，预览的调度器就拿真项目目录去派活/发消息。
  check(`快照也不搬 ${forbidden}`, (SNAPSHOT_TABLES as readonly string[]).includes(forbidden), false);
}
check("供应商排在执行器前面（被引用的先落地）",
  CONFIG_TABLES.indexOf("llm_providers") < CONFIG_TABLES.indexOf("agents"), true);
check("审查者配置会进入预览", (CONFIG_TABLES as readonly string[]).includes("reviewer_profiles"), true);
check("快照搬任务，也搬它的分组与队列",
  ["groups", "tasks", "sessions", "queue_items"].every((t) => (SNAPSHOT_TABLES as readonly string[]).includes(t)), true);
check("快照会连 Codex 累计基线一起搬",
  (SNAPSHOT_TABLES as readonly string[]).includes("usage_cumulative_snapshots"), true);
check("快照会带上自由工作流实际记录",
  ["free_workflow_states", "free_workflow_events", "free_review_runs", "free_review_rounds"].every((t) => (SNAPSHOT_TABLES as readonly string[]).includes(t)), true);

const source = createClient({ url: `file:${join(root, "live.db")}` });
const dest = createClient({ url: `file:${join(root, "preview.db")}` });

try {
  // 主库：设置有货，运行态也有货。
  await source.executeMultiple(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE llm_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '');
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      provider_id TEXT, is_default INTEGER NOT NULL DEFAULT 0, speed TEXT
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'single', verify_round INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_pid INTEGER, agent_started_at TEXT, agent_offset INTEGER, usage_output INTEGER);
    CREATE TABLE usage_cumulative_snapshots (source_id TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL);
    CREATE TABLE free_workflow_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, detail TEXT, occurred_at TEXT NOT NULL);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, cron TEXT);
    CREATE TABLE scheduled_messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO app_settings VALUES ('worktreeDefault', 'true');
    INSERT INTO llm_providers VALUES ('p1', 'cpa', 'sk-real-key');
    INSERT INTO agents VALUES ('a1', 'claude@local', 'claude', NULL, 1, NULL);
    INSERT INTO agents VALUES ('a2', 'codex@cpa', 'codex', 'p1', 0, 'fast');
    INSERT INTO projects VALUES ('proj', 'harness', '/repo');
    INSERT INTO tasks VALUES ('t1', 'running', 'single', 2);
    INSERT INTO tasks VALUES ('t2', 'queued', 'single', NULL);
    INSERT INTO tasks VALUES ('t3', 'done', 'single', NULL);
    INSERT INTO tasks VALUES ('t4', 'running', 'team', NULL);
    INSERT INTO sessions VALUES ('s1', 't1', 4242, 'Mon Aug 7 10:00:00 2026', 991, 706);
    INSERT INTO usage_cumulative_snapshots VALUES ('codex:thread-1', 123456);
    INSERT INTO free_workflow_events VALUES ('event1', 't3', 'preview_closed', 'user', 'http://127.0.0.1:4567', '2026-08-08T10:00:00.000Z');
    INSERT INTO schedules VALUES ('sch1', 't3', '0 9 * * *');
    INSERT INTO scheduled_messages VALUES ('msg1', 't3', 'pending');
  `);
  // 预览库：agents 少一列 speed、多一列 note —— 两个方向的 schema 漂移同时存在。
  // 另外**故意不建 team_presets / workflows / notes**，模拟「这张表这个分支还没有」。
  await dest.executeMultiple(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE llm_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '');
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      provider_id TEXT, is_default INTEGER NOT NULL DEFAULT 0, note TEXT
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'single', verify_round INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_pid INTEGER, agent_started_at TEXT, agent_offset INTEGER, usage_output INTEGER);
    CREATE TABLE usage_cumulative_snapshots (source_id TEXT PRIMARY KEY, input_tokens INTEGER NOT NULL);
    CREATE TABLE free_workflow_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, detail TEXT, occurred_at TEXT NOT NULL);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, cron TEXT);
    CREATE TABLE scheduled_messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL);
    INSERT INTO schedules VALUES ('old-sch', 'old', '0 1 * * *');
    INSERT INTO scheduled_messages VALUES ('old-msg', 'old', 'pending');
  `);

  // —— config 档：老行为，一张运行态都不进来 ——
  const copied = await copyConfigTables(source, dest);
  check("config 档搬了哪些表、各几行", copied, { app_settings: 1, llm_providers: 1, agents: 2, projects: 1 });
  check("config 档不搬任务", Number((await dest.execute("SELECT COUNT(*) AS n FROM tasks")).rows[0].n), 0);
  check("表不存在也只是跳过，不炸", "team_presets" in copied, false);

  // 执行器要完整可用：挂着的供应商得在，key 得是真的（否则起 CLI 时注入的是个空壳）。
  const agents = (await dest.execute("SELECT id, provider_id, is_default FROM agents ORDER BY id")).rows;
  check("两个执行器都在，供应商绑定原样", agents.map((r) => [r.id, r.provider_id, Number(r.is_default)]),
    [["a1", null, 1], ["a2", "p1", 0]]);
  check("供应商的 key 原样搬过来（不搬 = 挂了供应商的执行器起不来）",
    (await dest.execute("SELECT api_key FROM llm_providers")).rows[0].api_key, "sk-real-key");
  // 交集：源有目标没有的列（speed）丢掉，目标有源没有的列（note）留空——都不该报错。
  check("目标独有的列留空", (await dest.execute("SELECT note FROM agents WHERE id='a2'")).rows[0].note, null);

  // —— 第二次启动：非空的表整张跳过 ——
  // 预览是反复重启的，用户在预览里自己改过的配置不该被下一次启动悄悄盖回去。
  await dest.execute("UPDATE agents SET name = '我在预览里改过的名字' WHERE id = 'a1'");
  await dest.execute("DELETE FROM projects");
  const again = await copyConfigTables(source, dest);
  check("非空的表跳过，空了的表补上", again, { projects: 1 });
  check("预览里改过的配置没被覆盖",
    (await dest.execute("SELECT name FROM agents WHERE id='a1'")).rows[0].name, "我在预览里改过的名字");

  // —— snapshot 档：运行态也搬，搬完必须洗 ——
  const snap = await copyTables(source, dest, SNAPSHOT_TABLES);
  check("快照搬了任务与会话", { tasks: snap.tasks, sessions: snap.sessions }, { tasks: 4, sessions: 1 });
  check("快照保留自由工作流预览历史", (await dest.execute("SELECT kind FROM free_workflow_events WHERE id='event1'")).rows[0].kind, "preview_closed");
  check("主库的定时任务没搬进来",
    (await dest.execute("SELECT id FROM schedules ORDER BY id")).rows.map((row) => row.id), ["old-sch"]);
  check("token 账跟着会话行一起进来（不然预览里芯片没数）",
    (await dest.execute("SELECT usage_output FROM sessions WHERE id='s1'")).rows[0].usage_output, 706);
  check("Codex 累计基线跟着进来（否则预览续聊会重复累计）",
    (await dest.execute("SELECT input_tokens FROM usage_cumulative_snapshots WHERE source_id='codex:thread-1'")).rows[0].input_tokens, 123456);

  await sanitizeSnapshot(dest);
  const statuses = (await dest.execute("SELECT id, status FROM tasks ORDER BY id")).rows
    .map((r) => [r.id, r.status]);
  check("在跑的任务落成 paused、团队台落成 idle、终态原样",
    statuses, [["t1", "paused"], ["t2", "paused"], ["t3", "done"], ["t4", "idle"]]);
  check("正在跑的验证轮清空", (await dest.execute("SELECT verify_round FROM tasks WHERE id='t1'")).rows[0].verify_round, null);
  const sess = (await dest.execute("SELECT agent_pid, agent_started_at, agent_offset FROM sessions WHERE id='s1'")).rows[0];
  // 这条是整份测试里最要命的一行：pid + 启动时间是 isSameProcess 的全部判据，副本跟主库
  // 拿的是同一台机器上同一个进程，留着就会**判中**，预览于是开始 tail 一个主实例正在消费
  // 的输出文件。
  check("会话上的真 pid 与位置全洗干净", [sess.agent_pid, sess.agent_started_at, sess.agent_offset], [null, null, null]);
  check("洗的是运行态，不碰账", (await dest.execute("SELECT usage_output FROM sessions WHERE id='s1'")).rows[0].usage_output, 706);
  check("持久测试库里旧定时任务每次启动都清空",
    Number((await dest.execute("SELECT COUNT(*) AS n FROM schedules")).rows[0].n), 0);
  check("持久测试库里旧待发消息每次启动都清空",
    Number((await dest.execute("SELECT COUNT(*) AS n FROM scheduled_messages")).rows[0].n), 0);
} finally {
  source.close();
  dest.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);

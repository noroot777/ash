// 预览播种（server/src/preview-seed.ts）。
//
// 这条测试钉的是**「什么不该被搬」比「什么该被搬」更要命**：
//
//   · 少搬了设置 = 预览里一个执行器都没有，新建任务的按钮是灰的，预览退化成静态页面
//     （2026-08-07 第一轮验证正是卡在这儿）。烦，但一眼看得见。
//   · 多搬了运行态 = 副本上的调度器拿着真 pid、真 running 任务去接管、推进队列、
//     甚至停掉本机正在干活的 agent。看不见，且损坏的是**主实例**的活。
//
// 所以白名单是正着列的，这里也正着钉：新表默认进不来，谁想让它进来得先改常量、
// 而改常量会撞上下面这条「运行态一张都不许在名单里」。
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
const { CONFIG_TABLES, copyConfigTables } = await import("../src/preview-seed.js");

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

// —— 运行态一张都不许在白名单里 ——
// 这条不依赖任何数据库，它钉的是名单本身。加表的人不会来读这份文件，但会跑测试。
for (const forbidden of ["tasks", "sessions", "groups", "queues", "queue_items", "schedules", "scheduled_messages", "notes"]) {
  check(`白名单里没有 ${forbidden}`, (CONFIG_TABLES as readonly string[]).includes(forbidden), false);
}
check("供应商排在执行器前面（被引用的先落地）",
  CONFIG_TABLES.indexOf("llm_providers") < CONFIG_TABLES.indexOf("agents"), true);

const source = createClient({ url: `file:${join(root, "live.db")}` });
const dest = createClient({ url: `file:${join(root, "preview.db")}` });

try {
  // 主库：设置有货，运行态也有货（后者必须原地不动）。
  await source.executeMultiple(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE llm_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '');
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      provider_id TEXT, is_default INTEGER NOT NULL DEFAULT 0, speed TEXT
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO app_settings VALUES ('worktreeDefault', 'true');
    INSERT INTO llm_providers VALUES ('p1', 'cpa', 'sk-real-key');
    INSERT INTO agents VALUES ('a1', 'claude@local', 'claude', NULL, 1, NULL);
    INSERT INTO agents VALUES ('a2', 'codex@cpa', 'codex', 'p1', 0, 'fast');
    INSERT INTO projects VALUES ('proj', 'harness', '/repo');
    INSERT INTO tasks VALUES ('t1', 'running');
  `);
  // 预览库：agents 少一列 speed、多一列 note —— 两个方向的 schema 漂移同时存在。
  // 另外**故意不建 team_presets / workflows**，模拟「这张表这个分支还没有」。
  await dest.executeMultiple(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE llm_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '');
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      provider_id TEXT, is_default INTEGER NOT NULL DEFAULT 0, note TEXT
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  `);

  const copied = await copyConfigTables(source, dest);
  check("搬了哪些表、各几行", copied, { app_settings: 1, llm_providers: 1, agents: 2, projects: 1 });
  check("运行态没被搬", Number((await dest.execute("SELECT COUNT(*) AS n FROM tasks")).rows[0].n), 0);
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
} finally {
  source.close();
  dest.close();
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 条没过` : "\n全过");
process.exit(failures ? 1 : 0);

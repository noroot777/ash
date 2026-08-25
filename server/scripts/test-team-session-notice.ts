// 团队调度台的**收尾**那一段:一个 exit 0、正文完整、但恢复 thread 被判 poisoned 的
// 回合,随后用户按「停止全组」。
//
// 为什么必须端到端(真的 startTeam → resident → consume → haltTeam → closeLead):
// 这条路上的病灶全在**分支选择**上,静态检查看不出来 ——
//   ① 「停止全组」那句话在按下按钮时就写死成「再说一句话就能接回同一会话」,而会话
//      刚被作废,于是 closeLead 事后补一条红色 error「更正上面那条」;
//   ② 结果是一次健康产出的团队回合被停掉后照样挂着「执行过程 · 1 异常」。
// (自由工作流第 2 轮审查 P1 第二层。第 1 轮的 test-session-notice 只对 team 做了
// 「有没有引用共用判据」的静态检查,正好漏在这里。)
//
// 假 codex 只吐固定 JSONL + 真机 poisoned stderr 指纹,不打任何模型。
// 跑法：npm -w server run test:session-notice(串在 test-session-notice 后面)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ServerEvent } from "@ash/shared";

const root = mkdtempSync(join(tmpdir(), "ash-team-session-notice-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 这个测试就是要验证进程管理(常驻回合 → 停止 → closeLead),必须放开隔离闸。
// PATH 上唯一能被启动的 `codex` 是下面那个只会 echo JSONL 的桩,打不到任何模型。
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

const IS_WINDOWS = process.platform === "win32";
const repo = join(root, "repo");
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
git("init", "-q");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(repo, "README.md"), "team session notice\n");
git("add", "-A");
git("commit", "-qm", "init");

// 真机 Codex 0.147.x 的指纹之一(session-lost.ts 的 CODEX_POISON_PATTERNS)。
const POISON_STDERR = "dropping turn-scoped item for unknown turn id 0199";
const stubDir = join(root, "bin");
mkdirSync(stubDir, { recursive: true });
const stubJs = join(stubDir, "fake-codex.mjs");
writeFileSync(
  stubJs,
  `const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const args = process.argv.slice(2);
const at = args.indexOf("resume");
emit({ type: "thread.started", thread_id: at >= 0 ? args[at + 1] : "01a03415-e32e-72d2-8510-26a3beb2832f" });
emit({ type: "item.completed", item: { type: "agent_message", text: "调度台这一轮正文已经完整产出。" } });
emit({ type: "turn.completed" });
process.stderr.write(${JSON.stringify(POISON_STDERR)} + "\\n");
// 健康收尾:exit 0 + turn.completed。会话轮换与本回合成败正交,正是这一点被画红了。
setTimeout(() => process.exit(0), 50);
`,
);
writeFileSync(
  join(stubDir, IS_WINDOWS ? "codex.cmd" : "codex"),
  IS_WINDOWS
    ? `@echo off\r\n"${process.execPath}" "${stubJs}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubJs)} "$@"\n`,
  { mode: 0o755 },
);
process.env.PATH = `${stubDir}${delimiter}${process.env.PATH ?? ""}`;

const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, sessions } = await import("../src/db/schema.js");
const { bus } = await import("../src/bus.js");
const { RUNS_DIR } = await import("../src/paths.js");
const { startTeam, haltTeam } = await import("../src/team/session.js");
const { eq } = await import("drizzle-orm");
await ensureSchema();

const ok = (m: string) => console.log("   ✓ " + m);
const AT = "2026-08-25T00:00:00.000Z";
const taskId = "team-session-notice";
await db.insert(projects).values({ id: "proj", name: "team-notice", repoPath: repo, createdAt: AT });
await db.insert(tasks).values({
  id: taskId, projectId: "proj", title: "会话轮换后停止全组", body: "随便做点什么", mode: "team",
  status: "backlog", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]",
  team: JSON.stringify({ lead: "codex", worker: "codex", review: false }),
  autoTitle: false, createdAt: AT, updatedAt: AT, useWorktree: false,
});

const live: ServerEvent[] = [];
const unsubscribe = bus.subscribe((event) => live.push(event));
const agentEvents = () => live.flatMap((e) => e.type === "agent.event" ? [e.event] : []);
const waitFor = async (label: string, done: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`超时等待:${label}\n收到的事件:${JSON.stringify(agentEvents(), null, 2)}`);
};
const waitForAsync = async (label: string, done: () => Promise<boolean>, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`超时等待:${label}\n收到的事件:${JSON.stringify(agentEvents(), null, 2)}`);
};

try {
  await startTeam(taskId);
  // 第一轮跑完:poisoned 诊断已经到了,调度台落待命。
  await waitFor(
    "poisoned 诊断",
    () => agentEvents().some((e) => e.kind === "system" && e.text.includes("poisoned_session")),
  );
  await waitForAsync(
    "调度台落待命",
    async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)?.status === "idle",
  );

  const beforeHalt = agentEvents().filter((e) => e.kind === "error").map((e) => e.message);
  assert.deepEqual(beforeHalt, [], `健康回合不该发出 error:${JSON.stringify(beforeHalt)}`);
  ok("exit 0 的健康回合本身没有红色异常");

  // 用户按「停止全组」。这一步必须照实说「会话已作废」,而不是先承诺接回、再红字更正。
  await haltTeam(taskId);
  await waitFor(
    "「停止全组」注记",
    () => agentEvents().some((e) => e.kind === "system" && e.text.includes("停止全组")),
  );
  // closeLead 是在进程 close 事件里跑的,给它一点时间把注记写完。
  await new Promise((r) => setTimeout(r, 1500));

  const errors = agentEvents().filter((e) => e.kind === "error").map((e) => e.message);
  assert.deepEqual(errors, [], `停止全组之后仍有红色异常:${JSON.stringify(errors)}`);
  ok("停止全组之后仍然一条 error 都没有");

  const notes = agentEvents().flatMap((e) => e.kind === "system" ? [e.text] : []);
  const haltNote = notes.find((text) => text.includes("停止全组"));
  assert.ok(haltNote, `没找到「停止全组」的系统注记:${JSON.stringify(notes)}`);
  assert.match(haltNote, /已经作废|会开一条全新会话/, "会话已作废时不能承诺「接回同一会话」");
  assert.doesNotMatch(haltNote, /接回同一会话/, "这句指路会把用户推回同一堵墙");
  assert.ok(
    !notes.some((text) => text.includes("更正上面那条")),
    `照实说过就不该再补一条更正:${JSON.stringify(notes)}`,
  );
  ok("「停止全组」当场照实说会话已作废，不留需要更正的话");

  // 刷新后同样看得见:.md 里是 t:"system" 回合行,不是 `> **执行诊断**`。
  const [row] = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const md = readFileSync(join(RUNS_DIR, taskId, `${row.id}.md`), "utf8");
  const systemTurns = md.split("\n").flatMap((line) => {
    if (!line.startsWith("\x1e")) return [];
    const parsed = JSON.parse(line.slice(1));
    return parsed.t === "system" ? [parsed.text as string] : [];
  });
  assert.ok(
    systemTurns.some((text) => text.includes("poisoned_session")),
    `.md 里没有轮换诊断的 system 回合行:${JSON.stringify(systemTurns)}`,
  );
  assert.ok(systemTurns.some((text) => text.includes("停止全组")), ".md 里没有停止说明");
  assert.doesNotMatch(md, /执行诊断/, ".md 里仍写了红色执行诊断");
  assert.equal(row.cliSessionId, null, "poisoned 会话仍必须清 cli_session_id");
  ok(".md 只留 system 注记，恢复字段照清");
} finally {
  unsubscribe();
}

console.log("team-session-notice: 全部通过");

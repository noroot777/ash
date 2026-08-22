/**
 * duet 撞上「CLI 说这条会话我不认识」时,一整轮要**跑完**、并且把该清的清掉。
 *
 * 为什么要一条业务级的(而不是只留 test:session-lost 那种纯函数级):这条路上第一次
 * 写出来的修复,清理逻辑本身是对的,却把补充说明写在了 `out.end()` 之后 —— 写一条已关闭
 * 的写流会发出一个没人监听的 `error`('ERR_STREAM_WRITE_AFTER_END'),当场打崩整个
 * server,而且只在这条冷路径上崩:正常跑一百遍都碰不到,单测全绿(第 1 轮审查 P1)。
 * 所以这里真的驱动一轮 `runTurn`,拿一个只会说那句话的假执行器喂它,盯四件事:
 *   ① 这一轮走完了,没有任何未捕获异常(write-after-end 会在这里现形)
 *   ② 补充说明真的落进了 `.md`(既没被丢弃,也没崩在半路)
 *   ③ 库里 id + 三件套恢复命令都清了 —— 下一次 /retry 才会开新会话
 *   ④ 返回值里的 cliId 也清了 —— 本次运行的后续轮次不会接着拿死 id 去 --resume
 * 跑:ASH_DB=/tmp/t.db npm -w server run test:duet-session-lost
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

requireTmpDb("test-duet-session-lost");

// runTurn 的产物落在 RUNS_DIR 下,必须在 import paths.js 之前指走,别写进真实 data/runs。
const stage = mkdtempSync(join(tmpdir(), "ash-duet-session-lost-"));
process.env.ASH_RUNS_DIR = join(stage, "runs");

const [{ db, ensureSchema }, schema, duet] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/duet/index.js"),
]);
const { projects, tasks, sessions } = schema;
await ensureSchema();

// 未捕获异常在这里只可能来自被测代码。它默认会直接杀掉进程(实测:把 out.end() 挪回
// 补充说明之前,这条测试就死在 ERR_STREAM_WRITE_AFTER_END 上)—— 两种死法都算红,接住
// 只是为了让**赶在断言之前**冒出来的那一种能报得清楚点。
const crashes: unknown[] = [];
const capture = (e: unknown) => { crashes.push(e); };
process.on("uncaughtException", capture);
process.on("unhandledRejection", capture);

const at = "2026-08-22T02:00:00.000Z";
const taskId = "duet-session-lost";
const DEAD_ID = "6f8c7cdd-b820-416e-a4f3-96b516d6a8e2";
// 真机原话(claude 2.1.220 对着一个不存在的 transcript 跑 `--resume`)。
const REAL = `No conversation found with session ID: ${DEAD_ID}`;

await db.insert(projects).values({ id: "p", name: "p", repoPath: stage, apiKeys: null, createdAt: at });
await db.insert(tasks).values({
  id: taskId, projectId: "p", groupId: null, parentId: null, title: "会话失效", body: "", mode: "duet",
  status: "running", labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: null, executorId: null,
  autoTitle: false, duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at,
  useWorktree: false, worktreeBase: null, originTaskId: null,
});

/** 起跑就否认会话的假 CLI:一条 error + 非零退出,跟真机那次一模一样。 */
const executor = {
  type: "claude",
  label: "claude@stub",
  run: () => ({
    sessionId: DEAD_ID,
    commandLine: `claude --resume ${DEAD_ID}`,
    events: (async function* () {
      yield { kind: "error", message: REAL };
      yield { kind: "done", exitStatus: 1 };
    })(),
    kill() {},
  }),
  resumeCommand: () => `claude --resume ${DEAD_ID}`,
  resumeFields: () => ({ resumeCommand: `claude --resume ${DEAD_ID}`, resumeEnv: "K=x", resumeArgs: "--settings {}" }),
} as unknown as Parameters<typeof duet.runTurn>[0]["executor"];

const turn = await duet.runTurn({
  taskId, role: "voiceA", speaker: "A", round: 1, executor,
  prompt: "随便说点什么", cwd: stage, resumeCliId: DEAD_ID,
});
// 摘掉 —— 再留着,下面断言失败(ESM 顶层抛出走的是 unhandledRejection)也会被这两个
// handler 吞掉,测试变成静默半途退出、还打着绿勾。
process.off("uncaughtException", capture);
process.off("unhandledRejection", capture);

const ok = (m: string) => console.log("   ✓ " + m);

// ① 一整轮走完了,没崩。
assert.deepEqual(crashes, [], `这一轮抛出了未捕获异常(write-after-end?):${crashes.map(String).join(" / ")}`);
ok("整轮跑完,没有未捕获异常");

// ② 说明真的写进了 .md。用户翻这一轮的正文,得看到「为什么下一次是新会话」。
// 写流是异步落盘的(runTurn 只 end() 不等 'finish'),所以给它一小段时间,别把
// 「还没 flush」误判成「没写」。
const mdPath = join(process.env.ASH_RUNS_DIR!, taskId, `${turn.rowId}.md`);
let md = "";
for (let i = 0; i < 100 && !md.includes("已经把这个失效的 id 清掉"); i++) {
  try { md = readFileSync(mdPath, "utf8"); } catch { /* 还没建出来 */ }
  if (!md.includes("已经把这个失效的 id 清掉")) await new Promise((r) => setTimeout(r, 20));
}
assert.ok(md.includes(REAL), "CLI 那句原话没落进 .md");
assert.ok(md.includes("已经把这个失效的 id 清掉"), `失效会话的补充说明没落进 .md:${JSON.stringify(md)}`);
ok(".md 里既有 CLI 原话,也有清理说明");

// ③ 库里那份:喂下一次 /retry。四列一起清,留着任何一列都是给用户一条撞墙的命令。
const [row] = await db.select().from(sessions).where(eq(sessions.id, turn.rowId));
assert.equal(row.cliSessionId, null, "失效的 cli_session_id 还留在库里");
assert.equal(row.resumeCommand, null, "resume_command 没跟着清");
assert.equal(row.resumeEnv, null, "relay_env 没跟着清");
assert.equal(row.resumeArgs, null, "resume_args 没跟着清");
assert.equal(row.exitStatus, 1, "结算还是要如实记下这一轮失败了");
ok("库里的 id + 三件套恢复命令都清了");

// ④ 返回值那份:喂本次运行的后续轮次(ctx.A.cliId → 下一轮的 resumeCliId)。只清库不清
// 它,同一次 duet 跑下去照样撞同一堵墙。
assert.equal(turn.cliId, "", "返回值里的 cliId 没清,后续轮次会接着 --resume 死 id");
assert.ok(turn.error?.includes("已经把这个失效的 id 清掉"), "错误文本里要带上说明(时间线/transcript 都取自它)");
ok("返回值里的 cliId 也清了,后续轮次会开新会话");

await releaseTmpDb();
rmSync(stage, { recursive: true, force: true });
console.log("duet session-lost: 全部通过");

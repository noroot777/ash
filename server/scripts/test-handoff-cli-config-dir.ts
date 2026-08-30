// 接力搬 CLI 会话文件时,「放哪」和「起跑时 CLI 去哪找」必须是同一个目录。
//
// 2026-08-29 现场:一条任务从自用机接力到一台**多用户** ash,导入侧把 claude 的
// transcript 写死进宿主机 `~/.claude/projects/…`,而多用户模式起跑注入了
// `CLAUDE_CONFIG_DIR`(它**整个取代** `~/.claude`,不回落)。文件在盘上、CLI 眼里没有,
// `claude --resume` 换回一句 "No conversation found with session ID",回合 0.9 秒空转,
// 任务按「没调 complete_task」记 failed。导入侧那道「只认写盘成功的会话」的闸也拦不住:
// 它只问文件名到没到,不问 CLI 站在自己的配置目录里看不看得见。
//
// 这条测试钉五件事:
//   ① 判据同源 —— cliConfigDirForOwner 给出的目录 == 起跑注入的那个环境变量的值
//   ② 导入侧真的落进那个目录,而且**不在** `~/.claude` 下(反向断言才抓得住回归)
//   ③ 导出侧也去那个目录找:归属人对了找得到,按自用模式找就找不到
//   ④ 跨人回合:共享项目里 B 回复 A 的任务,会话写在 B 的目录下,导出必须按
//      `sessions.run_owner_user_id` 逐条找,不能按任务归属人 A 一刀切(第 1 轮审查 finding 1)
//   ⑤ 「读会话元数据」的那条链同样得站这个目录:起跑前的 Codex 版本守卫、会话列表里的
//      版本提示,都从 rollout 首行读 cli_version —— 站错目录读不到,而读不到是 fail-open
// 外加自用模式(owner 为 null)逐字节维持老行为:仍然是 `~/.claude` / `$CODEX_HOME`。
//
// 跑法(自带临时库):
//   npm -w server run test:handoff-cli-config-dir
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-handoff-cli-dir-"));
// 产品代码走 os.homedir():POSIX 看 HOME,Windows 看 USERPROFILE,只设一个等于没设。
const home = join(stage, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = join(home, ".codex");
process.env.ASH_DB ||= join(stage, "handoff-cli-dir.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-handoff-cli-config-dir");

const CLAUDE_ID = "edb416ee-d4bc-46c2-9bda-f05fbcc84f87";
const SOLO_CWD = join(stage, "workspace", "repo", ".worktrees", "TASKSOLO0001");
const OWNED_CWD = join(stage, "workspace", "repo", ".worktrees", "TASKOWNED001");
// 两段各用自己的 thread id:codex 按 `-<threadId>.jsonl` 后缀在整棵 sessions 树里扫,
// 复用同一个 id 会让第二段扫到第一段留下的那份,反向断言就成了假绿。
const codexRel = (threadId: string) => `2026/08/29/rollout-2026-08-29T13-26-46-${threadId}.jsonl`;

let failed = false;
let cleanupUserDir: string | null = null;
let cleanupBobDir: string | null = null;
try {
  const { ensureSchema } = await import("../src/db/index.js");
  const mode = await import("../src/auth/mode.js");
  const store = await import("../src/auth/store.js");
  const { cliConfigDirForOwner, runEnvForOwner } = await import("../src/auth/run-env.js");
  const { USER_CLI_ROOT } = await import("../src/auth/user-cli.js");
  const { claudeProjectDir, claudeSessionFilePath, collectSessionFiles } =
    await import("../src/handoff-collect.js");
  const { writePayloadFiles } = await import("../src/handoff-import-payload.js");
  const { codexHome } = await import("../src/executors/codex-rollout.js");

  await ensureSchema();

  const noRewrites = { raw: [], json: [], ambiguous: false };
  const payload = (threadId: string) => [
    { kind: "claude-session" as const, rel: `${CLAUDE_ID}.jsonl`, dataBase64: Buffer.from("{}\n").toString("base64") },
    { kind: "codex-rollout" as const, rel: codexRel(threadId), dataBase64: Buffer.from("{}\n").toString("base64") },
  ];
  // 会话行只用到这几个字段;整行 SessionRow 有三十多列,凑齐没有信息量。
  const sessionRow = (agentType: string, cliSessionId: string, cwd: string, runOwnerUserId: string | null = null) =>
    ({ id: `s-${agentType}`, agentType, cliSessionId, cwd, worktreePath: cwd, runOwnerUserId } as never);

  // ── 自用模式:owner 为 null,一切照旧落宿主机默认目录 ────────────────────
  const SOLO_THREAD = "aaaa1111bbbb2222";
  assert.equal(await cliConfigDirForOwner(null, "claude"), null, "自用模式不该算出个人配置目录");
  assert.equal(await cliConfigDirForOwner(null, "codex"), null, "自用模式不该算出个人配置目录");

  await writePayloadFiles(payload(SOLO_THREAD), "TASKSOLO0001", SOLO_CWD, noRewrites, [], { claude: null, codex: null });
  assert.ok(
    existsSync(claudeSessionFilePath(SOLO_CWD, CLAUDE_ID, null)),
    "自用模式:claude 会话仍应落在 ~/.claude/projects/<slug>/ 下",
  );
  assert.ok(
    existsSync(join(codexHome(), "sessions", ...codexRel(SOLO_THREAD).split("/"))),
    "自用模式:codex rollout 仍落 $CODEX_HOME",
  );
  const solo = await collectSessionFiles(
    [sessionRow("claude", CLAUDE_ID, SOLO_CWD), sessionRow("codex", SOLO_THREAD, SOLO_CWD)],
    SOLO_CWD, false, null,
  );
  assert.equal(solo.found.size, 2, `自用模式:导出侧要在宿主机目录里找得到刚落的两份:${solo.notes.join(" / ")}`);

  // ── 多用户模式:配置目录跟人走 ──────────────────────────────────────────
  const OWNED_THREAD = "cccc3333dddd4444";
  const rootDir = join(stage, "users");
  mkdirSync(join(rootDir, "lj"), { recursive: true });
  await mode.setInstanceMode("multi", rootDir);
  const user = await store.createUser({
    name: "lj", role: "member", dirName: "lj", gitName: "LJ", gitEmail: "lj@x", createdBy: null,
  });

  // ① 判据同源:接力找/放会话文件用的目录,就是起跑注入给 CLI 的那一个。
  const claudeDir = await cliConfigDirForOwner(user.id, "claude");
  assert.equal(
    claudeDir,
    (await runEnvForOwner(user.id, "claude")).CLAUDE_CONFIG_DIR,
    "claude:接力用的目录必须等于起跑注入的 CLAUDE_CONFIG_DIR",
  );
  assert.ok(claudeDir?.startsWith(USER_CLI_ROOT), `claude 个人配置目录应在 ${USER_CLI_ROOT} 下,实际 ${claudeDir}`);
  cleanupUserDir = join(USER_CLI_ROOT, user.id);
  const codexDir = await cliConfigDirForOwner(user.id, "codex");
  assert.equal(
    codexDir,
    (await runEnvForOwner(user.id, "codex")).CODEX_HOME,
    "codex:接力用的目录必须等于起跑注入的 CODEX_HOME",
  );

  // ② 导入侧落进个人目录,而且不在宿主机默认目录下。
  await writePayloadFiles(
    payload(OWNED_THREAD), "TASKOWNED001", OWNED_CWD, noRewrites, [], { claude: claudeDir, codex: codexDir },
  );
  assert.ok(
    existsSync(claudeSessionFilePath(OWNED_CWD, CLAUDE_ID, claudeDir)),
    "多用户:claude 会话必须落进归属人的 CLAUDE_CONFIG_DIR",
  );
  assert.ok(
    !existsSync(claudeSessionFilePath(OWNED_CWD, CLAUDE_ID, null)),
    "多用户:落进宿主机 ~/.claude 就是 CLI 永远找不到的地方(2026-08-29 现场)",
  );
  assert.ok(claudeProjectDir(OWNED_CWD, claudeDir).startsWith(claudeDir!), "claude 项目目录必须在个人配置目录下");
  assert.ok(
    existsSync(join(codexHome(codexDir), "sessions", ...codexRel(OWNED_THREAD).split("/"))),
    "多用户:codex rollout 必须落进归属人的 CODEX_HOME",
  );
  assert.ok(
    !existsSync(join(codexHome(), "sessions", ...codexRel(OWNED_THREAD).split("/"))),
    "多用户:codex rollout 不该落宿主机 $CODEX_HOME",
  );

  // ③ 导出侧对称:按归属人找得到,按自用模式(null)就找不到。
  const rows = [sessionRow("claude", CLAUDE_ID, OWNED_CWD), sessionRow("codex", OWNED_THREAD, OWNED_CWD)];
  const mine = await collectSessionFiles(rows, OWNED_CWD, false, user.id);
  assert.equal(mine.found.size, 2, `按归属人应盘点到两条会话,实际 ${mine.found.size}:${mine.notes.join(" / ")}`);
  const asSolo = await collectSessionFiles(rows, OWNED_CWD, false, null);
  assert.equal(asSolo.found.size, 0, "按宿主机默认目录找,这两条都不该找得到——两侧判据必须同源");

  // ④ 跨人回合:共享项目里任务归属人是 A,B 回复了一轮,那一轮的 CLI 会话写在 **B** 的
  //    配置目录下(orchestrator.ts 的 `runOwner = actingUserId ?? task.ownerUserId`)。
  //    导出必须按会话行自己的 run_owner 找;按任务归属人 A 一刀切就会扑空,最新那段
  //    上下文不随任务走(第 1 轮审查 finding 1)。
  const bob = await store.createUser({
    name: "bob", role: "member", dirName: "bob", gitName: "Bob", gitEmail: "b@x", createdBy: null,
  });
  cleanupBobDir = join(USER_CLI_ROOT, bob.id);
  const bobClaudeDir = await cliConfigDirForOwner(bob.id, "claude");
  const bobCodexDir = await cliConfigDirForOwner(bob.id, "codex");
  assert.notEqual(bobClaudeDir, claudeDir, "两个人的个人配置目录不该是同一个");
  const CROSS_CWD = join(stage, "workspace", "repo", ".worktrees", "TASKCROSS001");
  const CROSS_THREAD = "eeee5555ffff6666";
  await writePayloadFiles(
    payload(CROSS_THREAD), "TASKCROSS001", CROSS_CWD, noRewrites, [], { claude: bobClaudeDir, codex: bobCodexDir },
  );
  // 任务归属人仍是 lj(user.id),但这两行会话是 bob 跑出来的。
  const crossRows = [
    sessionRow("claude", CLAUDE_ID, CROSS_CWD, bob.id),
    sessionRow("codex", CROSS_THREAD, CROSS_CWD, bob.id),
  ];
  const cross = await collectSessionFiles(crossRows, CROSS_CWD, false, user.id);
  assert.equal(
    cross.found.size, 2,
    `跨人回合的会话要按 run_owner 找得到,实际 ${cross.found.size}:${cross.notes.join(" / ")}`,
  );
  // 反向:同样两行、但没有 run_owner(老行),就只能退回任务归属人 A 的目录 —— 找不到。
  const legacyRows = [
    sessionRow("claude", CLAUDE_ID, CROSS_CWD),
    sessionRow("codex", CROSS_THREAD, CROSS_CWD),
  ];
  assert.equal(
    (await collectSessionFiles(legacyRows, CROSS_CWD, false, user.id)).found.size, 0,
    "没有 run_owner 就退回任务归属人:这两条本来就不在他的目录下,找不到才是对的",
  );

  // ⑤ 「找文件」对了还不够:**读会话元数据**的那条链也得站同一个目录。起跑前的版本守卫
  //    (0.147 建的 Codex 会话要在 spawn 前换掉)和会话列表里的版本提示,都从 rollout 首行
  //    读 cli_version。按宿主机默认 CODEX_HOME 读必然扑空,而扑空是 fail-open —— 受影响的
  //    会话被静默放行,照样把旧 id 交给 `codex exec resume`(第 1 轮 finding 1)。
  const { affectedCodexResumeVersion } = await import("../src/session-version-guard.js");
  const writeRollout = (dir: string | null, threadId: string) => {
    const file = join(codexHome(dir), "sessions", ...codexRel(threadId).split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { session_id: threadId, cli_version: "0.147.0" } })}\n`,
    );
  };
  // 每段一个新 thread id:版本读取带进程内缓存(按 thread id),复用同一个会让后一段
  // 拿到前一段的缓存值,反向断言就成了假绿。
  const GUARD_THREAD = "01a032e5-c973-78c2-bbc7-a2ff7d10b3da";
  writeRollout(bobCodexDir, GUARD_THREAD);
  assert.equal(
    await affectedCodexResumeVersion("codex", GUARD_THREAD),
    undefined,
    "按宿主机默认 CODEX_HOME 读 —— 读不到,这正是漏拦的形状(先跑它,免得缓存喂出假绿)",
  );
  assert.equal(
    await affectedCodexResumeVersion("codex", GUARD_THREAD, bob.id),
    "0.147.0",
    "按会话的 run_owner 读:受影响的版本必须在起跑前就认出来",
  );

  // 会话列表也得读同一个目录,否则界面说「读不出版本」、守卫却在换会话,两套结论。
  // 这一行**故意不写 run_owner**(老库里就是这样),走的是「回落到任务归属人」那条路。
  const { db } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { sessionsForTask } = await import("../src/task-session-routes.js");
  const LIST_THREAD = "01b032e5-c973-78c2-bbc7-a2ff7d10b3da";
  writeRollout(codexDir, LIST_THREAD);
  const at = "2026-08-29T13:26:46.000Z";
  await db.insert(projects).values({ id: "p-cli-dir", name: "cli-dir", repoPath: stage, createdAt: at });
  await db.insert(tasks).values({
    id: "t-cli-dir", projectId: "p-cli-dir", title: "会话列表", body: "", mode: "single", status: "done",
    labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
    ownerUserId: user.id, createdAt: at, updatedAt: at, useWorktree: false,
  });
  await db.insert(sessions).values({
    id: "s-cli-dir", taskId: "t-cli-dir", role: "single", agentType: "codex", executor: "codex@x",
    cliSessionId: LIST_THREAD, startedAt: at,
  });
  const listed = await sessionsForTask("t-cli-dir");
  assert.equal(
    listed.at(0)?.cliVersion,
    "0.147.0",
    "会话列表要按归属人的 CODEX_HOME 读版本,否则界面与起跑守卫给出两套结论",
  );

  console.log("test-handoff-cli-config-dir: OK");
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
  // 个人配置目录锚在 <repo>/data 下(paths.ts),舞台目录删不掉它。只删这次建的那个
  // 用户 id 的子树 —— USER_CLI_ROOT 整个删掉会连带清空真实实例里所有人的个人 CLI 环境。
  if (cleanupUserDir) rmSync(cleanupUserDir, { recursive: true, force: true });
  if (cleanupBobDir) rmSync(cleanupBobDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

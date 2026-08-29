// 接力搬 CLI 会话文件时,「放哪」和「起跑时 CLI 去哪找」必须是同一个目录。
//
// 2026-08-29 现场:一条任务从自用机接力到一台**多用户** ash,导入侧把 claude 的
// transcript 写死进宿主机 `~/.claude/projects/…`,而多用户模式起跑注入了
// `CLAUDE_CONFIG_DIR`(它**整个取代** `~/.claude`,不回落)。文件在盘上、CLI 眼里没有,
// `claude --resume` 换回一句 "No conversation found with session ID",回合 0.9 秒空转,
// 任务按「没调 complete_task」记 failed。导入侧那道「只认写盘成功的会话」的闸也拦不住:
// 它只问文件名到没到,不问 CLI 站在自己的配置目录里看不看得见。
//
// 这条测试钉三件事:
//   ① 判据同源 —— cliConfigDirForOwner 给出的目录 == 起跑注入的那个环境变量的值
//   ② 导入侧真的落进那个目录,而且**不在** `~/.claude` 下(反向断言才抓得住回归)
//   ③ 导出侧也去那个目录找:归属人对了找得到,按自用模式找就找不到
// 外加自用模式(owner 为 null)逐字节维持老行为:仍然是 `~/.claude` / `$CODEX_HOME`。
//
// 跑法(自带临时库):
//   npm -w server run test:handoff-cli-config-dir
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // 会话行只用到这四个字段;整行 SessionRow 有三十多列,凑齐没有信息量。
  const sessionRow = (agentType: string, cliSessionId: string, cwd: string) =>
    ({ id: `s-${agentType}`, agentType, cliSessionId, cwd, worktreePath: cwd } as never);

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
}
process.exit(failed ? 1 : 0);

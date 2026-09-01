// 接力搬 CLI 会话文件时,「放哪」和「起跑时 CLI 去哪找」必须是同一个目录。
//
// 2026-08-29 现场:一条任务从自用机接力到一台**多用户** ash,导入侧把 claude 的
// transcript 写死进宿主机 `~/.claude/projects/…`,而多用户模式起跑注入了
// `CLAUDE_CONFIG_DIR`(它**整个取代** `~/.claude`,不回落)。文件在盘上、CLI 眼里没有,
// `claude --resume` 换回一句 "No conversation found with session ID",回合 0.9 秒空转,
// 任务按「没调 complete_task」记 failed。导入侧那道「只认写盘成功的会话」的闸也拦不住:
// 它只问文件名到没到,不问 CLI 站在自己的配置目录里看不看得见。
//
// 这条测试钉七件事:
//   ① 判据同源 —— cliConfigDirForOwner 给出的目录 == 起跑注入的那个环境变量的值
//   ② 导入侧真的落进那个目录,而且**不在** `~/.claude` 下(反向断言才抓得住回归)
//   ③ 导出侧也去那个目录找:归属人对了找得到,按自用模式找就找不到
//   ④ 跨人回合:共享项目里 B 回复 A 的任务,会话写在 B 的目录下,导出必须按
//      `sessions.run_owner_user_id` 逐条找,不能按任务归属人 A 一刀切(第 1 轮审查 finding 1)
//   ⑤ 「读会话元数据」的那条链同样得站这个目录:起跑前的 Codex 版本守卫、会话列表里的
//      版本提示,都从 rollout 首行读 cli_version —— 站错目录读不到,而读不到是 fail-open
//   ⑥ 「CLI 额度」在共用/隔离之间换档(§八之二)时,**人没变、目录变了**:注入、出站凭证
//      清理、派发闸三条都要跟着翻,而「这条旧会话接不接得上」必须认会话行记下的那个目录
//      ——按归属人现算的话这一档换过之后会一路放行,然后在 CLI 那头硬失败
//   ⑦ **老行**(cli_config_dir 上线之前建的会话)在共用档下的解释:迁移只 ADD COLUMN
//      不回填,而老行确实写在个人目录里,所以判据只能是**当时**那条规则(有 run_owner
//      就是个人目录),不能按当前设置现算 —— 现算会让老会话在换档后被判成接得上
//      (第 1 轮审查 P1)。顺带钉住「读」这条路不许有 mkdir 副作用
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
    SOLO_CWD, false,
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
  const rows = [
    sessionRow("claude", CLAUDE_ID, OWNED_CWD, user.id),
    sessionRow("codex", OWNED_THREAD, OWNED_CWD, user.id),
  ];
  const mine = await collectSessionFiles(rows, OWNED_CWD, false);
  assert.equal(mine.found.size, 2, `按归属人应盘点到两条会话,实际 ${mine.found.size}:${mine.notes.join(" / ")}`);
  // 反向:同样两份文件,但会话行说这一轮没有归属人(自用模式的形状)—— 那就该去宿主机
  // 默认目录找,于是找不到。两侧判据必须同源,不同源的话这条会假绿。
  const asSolo = await collectSessionFiles(
    [sessionRow("claude", CLAUDE_ID, OWNED_CWD), sessionRow("codex", OWNED_THREAD, OWNED_CWD)],
    OWNED_CWD, false,
  );
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
  const cross = await collectSessionFiles(crossRows, CROSS_CWD, false);
  assert.equal(
    cross.found.size, 2,
    `跨人回合的会话要按 run_owner 找得到,实际 ${cross.found.size}:${cross.notes.join(" / ")}`,
  );
  // 反向:同样两行、但没有 run_owner(老行),按当时那条规则就是宿主机默认目录 —— 找不到。
  // 注意这里**不能**退回任务归属人 lj:存量任务在自用转多人时会被整体划给管理员,
  // 拿它当「当初写在哪」的证据只会把老会话指到一个从没写过东西的目录(第 1 轮 P1)。
  const legacyRows = [
    sessionRow("claude", CLAUDE_ID, CROSS_CWD),
    sessionRow("codex", CROSS_THREAD, CROSS_CWD),
  ];
  assert.equal(
    (await collectSessionFiles(legacyRows, CROSS_CWD, false)).found.size, 0,
    "没有 run_owner 的老行按宿主机默认目录找:这两条不在那儿,找不到才是对的",
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
    await affectedCodexResumeVersion("codex", GUARD_THREAD, bobCodexDir),
    "0.147.0",
    "按会话记下的那个配置目录读:受影响的版本必须在起跑前就认出来",
  );

  // 会话列表也得读同一个目录,否则界面说「读不出版本」、守卫却在换会话,两套结论。
  // 这一行**故意不写 cli_config_dir**(那一列上线前的老行就是这样),但写了 run_owner ——
  // 真实的多人老行正是这个形状:两列是同一批插入点写的,不会只有一半。所以它整条走的是
  // 老行解析那条路,顺带把「列表 → sessionCliConfigDir → 老行规则」串起来验一遍。
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
    cliSessionId: LIST_THREAD, startedAt: at, runOwnerUserId: user.id,
  });
  const listed = await sessionsForTask("t-cli-dir");
  assert.equal(
    listed.at(0)?.cliVersion,
    "0.147.0",
    "会话列表要按归属人的 CODEX_HOME 读版本,否则界面与起跑守卫给出两套结论",
  );

  // ⑥ 「CLI 额度」换档(§八之二):同一个人,配置目录整体挪位置,而盘上的会话文件没动。
  //    这是与④同一堵墙的第三个触发口,但它更阴 —— ④ 换的是人,这里人没变,所以任何
  //    「按归属人现算一遍」的判据都会一路放行,然后在 CLI 那头硬失败。
  const { patchAppSettings } = await import("../src/app-settings.js");
  const { agentBaseEnv } = await import("../src/executors/spawn.js");
  const { dispatchRejection } = await import("../src/auth/dispatch-gate.js");
  const { sessionCliConfigDir, sessionResumableHere } = await import("../src/auth/run-env.js");
  // 起跑那一刻记下的行:目录是隔离档下那个个人目录。
  const recorded = { cliConfigDir: claudeDir ?? "", runOwnerUserId: user.id };

  process.env.ANTHROPIC_API_KEY = "sk-host-subscription";
  assert.equal(
    agentBaseEnv().ANTHROPIC_API_KEY, undefined,
    "隔离档:宿主机的出站凭证不许透传给 agent(§八)",
  );
  assert.ok(
    await dispatchRejection({ agentType: "claude", owner: user.id }),
    "隔离档:没挂供应商的执行器派不出去",
  );

  await patchAppSettings({ sharedHostCli: true });
  assert.equal(
    (await runEnvForOwner(user.id, "claude")).CLAUDE_CONFIG_DIR, undefined,
    "共用档:不注个人配置目录,大家用宿主机那份登录态",
  );
  assert.equal(
    (await runEnvForOwner(user.id, "claude")).GIT_AUTHOR_NAME, "LJ",
    "共用档:共用额度不等于共用身份,git 署名照样按人注入(审查修订 B6)",
  );
  assert.equal(await cliConfigDirForOwner(user.id, "claude"), null, "共用档:现算的答案变成宿主机默认目录");
  assert.equal(
    await sessionCliConfigDir(recorded, "claude"), claudeDir,
    "但**记下来的**那个目录不会跟着变 —— 文件还躺在那儿,判据必须认它",
  );
  assert.equal(
    await sessionResumableHere(recorded, user.id, "claude"), false,
    "所以这条旧会话接不上:必须另开一条,而不是把注定扑空的 id 交给 CLI --resume",
  );
  assert.equal(
    agentBaseEnv().ANTHROPIC_API_KEY, "sk-host-subscription",
    "共用档:宿主机的 key 正是大家要烧的那把,清掉等于把这一档关了",
  );
  assert.equal(
    await dispatchRejection({ agentType: "claude", owner: user.id }), null,
    "共用档:没挂供应商是常态,派发闸必须整条穿透",
  );

  // ⑦ **老行**(cli_config_dir 上线之前建的会话,这一列是 null)在共用档下怎么解释。
  //    这是第 1 轮审查的 P1:迁移只 ADD COLUMN 不回填,而老行当初实实在在写在个人目录里。
  //    「按归属人现算」在这里会回答「宿主机默认目录」,于是老会话被判成接得上,再一次
  //    撞回本次改动要堵的 "No conversation found"。判据必须是**当时**那条规则。
  const legacyOwned = { runOwnerUserId: user.id };          // 多人模式下跑过的老行
  const legacyUnowned = { runOwnerUserId: null };            // 自用模式 / 转换前的老行
  // 一个从没建过目录的用户 id,专用来验「读」这条路没有 mkdir 副作用。
  const GHOST = "ghost-never-seeded";
  const { userCliDir } = await import("../src/auth/user-cli.js");
  await sessionCliConfigDir({ runOwnerUserId: GHOST }, "claude");
  assert.equal(
    await sessionCliConfigDir(legacyOwned, "claude"), claudeDir,
    "共用档下的老行:当初没有「共用」这一档,跑在谁名下就一定注了谁的个人目录",
  );
  assert.equal(
    await sessionResumableHere(legacyOwned, user.id, "claude"), false,
    "所以它同样接不上 —— 老行不回填不等于可以按新设置重新解释(第 1 轮 P1)",
  );
  assert.equal(
    await sessionCliConfigDir(legacyUnowned, "claude"), null,
    "没有归属人的老行才是宿主机默认目录(自用模式,以及自用转多人之前的存量会话)",
  );
  assert.equal(
    await sessionResumableHere(legacyUnowned, null, "claude"), true,
    "自用模式两边恒为 null,这道闸永远放行,行为与它加入前逐字节一致",
  );

  await patchAppSettings({ sharedHostCli: false });
  assert.equal(await cliConfigDirForOwner(user.id, "claude"), claudeDir, "改回隔离档要立刻生效,不能等重启");
  assert.equal(
    await sessionResumableHere(recorded, user.id, "claude"), true,
    "改回来之后那条旧会话又接得上了 —— 文件从头到尾没动过",
  );
  assert.equal(
    await sessionResumableHere(legacyOwned, user.id, "claude"), true,
    "隔离档下老行照常续跑:这一列上线前后行为不变,不能因为没回填就把人挡在外面",
  );
  assert.ok(
    !existsSync(userCliDir(GHOST, "claude")),
    "问「旧文件在哪」不许有副作用:解释老行时不能顺手 mkdir 出一套没人读的个人目录",
  );
  assert.equal(agentBaseEnv().ANTHROPIC_API_KEY, undefined, "同步镜像也得跟着回来(spawn 走的是它)");
  delete process.env.ANTHROPIC_API_KEY;

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

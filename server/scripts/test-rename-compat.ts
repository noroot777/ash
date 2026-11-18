// 改名 navi(③ 服务端运行时标识)的兼容回归:旧名还认得、新旧两版互斥没被改名打穿、两份镜像不漂。
//
//   ① 旧名清单:shared 那份和 scripts 的裸 Node 镜像逐项相等;human-approval.mjs 里冻结的签名用途串跟 shared 一致;
//   ② 环境变量:旧名读得到、新名优先、擦就三代一起擦(大小写不敏感);指向数据的变量几代不一致就拒绝;
//   ③ MCP 登记名 / 工具名:navi、ash、harness 三代都认;
//   ④ 任务分支:新建写 navi/,已有的 ash/、harness/ 分支照旧找得到;
//   ⑤ 互斥:改名之前的服务只写 `.ash.lock` / `.ash-claim.lock` / `.ash-online.` —— 新版必须被它们挡下,
//      自己则两代名字都持有;
//   ⑥ 接力线:旧版对端的 ping/错误标记照认,旧版对端 + 新前缀分支在打包之前就拒;
//   ⑦ setup 把 codex 里旧名的登记迁成 navi;真执行器开关的闸三代名字都拦。
//
// 跑:`npm -w server run test:rename-compat`
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as legacyNames from "@ash/shared/legacy-names";
import {
  clearEnv, envNameGenerations, readEnv, readStorageEnv, setEnv, withLegacyEnvNames,
} from "@ash/shared/env-names";
import { ASH_MCP_SERVER_NAME, ashMcpToolOf, isAshMcpServerName } from "@ash/shared/mcp";
import { isNaviHeaderName, readHeader, withLegacyHeaderNames } from "@ash/shared/http-headers";
import {
  hasTaskBranchPrefix, isTaskBranchOf, taskBranchName, taskBranchNames, taskIdPrefixOfBranch,
} from "@ash/shared/task-branch";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "navi-rename-compat-"));
// 产品模块在加载那一刻就定下库和数据目录:先把继承来的各代名字擦掉,再指到临时目录,之后才动态导入。
for (const name of ["NAVI_DB", "NAVI_DATA_DIR", "NAVI_RUNS_DIR", "NAVI_UPLOADS_DIR", "NAVI_ALLOW_MULTI"] as const) clearEnv(process.env, name);
const dataDir = join(root, "data");
mkdirSync(dataDir, { recursive: true });
const dbFile = join(dataDir, "ash.db");
process.env.NAVI_DB = dbFile;
process.env.NAVI_DATA_DIR = dataDir;
process.env.NAVI_RUNS_DIR = join(root, "runs");

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function repoWithCommit(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

let sleeper: ReturnType<typeof spawn> | null = null;
try {
  // ── ① 旧名清单与镜像 ──────────────────────────────────────────────────────
  {
    const mirror = await import(new URL("../../scripts/legacy-names.mjs", import.meta.url).href) as Record<string, unknown>;
    const own = Object.fromEntries(Object.entries(legacyNames));
    assert.deepEqual(Object.keys(mirror).sort(), Object.keys(own).sort(), "两份清单的条目要一一对上");
    for (const [key, value] of Object.entries(own)) assert.deepEqual(mirror[key], value, `${key}:两份的值不一样`);
    const approval = readFileSync(join(REPO, "scripts", "human-approval.mjs"), "utf8");
    assert.equal(/const PURPOSE = "([^"]+)"/.exec(approval)?.[1], legacyNames.FROZEN_HUMAN_APPROVAL_PURPOSE,
      "宿主签名脚本的用途串是冻结值,跟服务端验签那份必须一字不差");
    console.log("✓ 旧名清单:shared 与 scripts 镜像逐项相等,冻结的签名用途串两边一致");
  }

  // ── ② 环境变量 ───────────────────────────────────────────────────────────
  {
    const bare = await import(new URL("../../scripts/env.mjs", import.meta.url).href) as {
      readEnv: typeof readEnv; readStorageEnv: typeof readStorageEnv; clearEnv: typeof clearEnv;
    };
    assert.deepEqual(envNameGenerations("NAVI_DB"), ["NAVI_DB", "ASH_DB", "HARNESS_DB"]);
    for (const read of [readEnv, bare.readEnv]) {
      assert.equal(read({ ASH_URL: "a" }, "NAVI_URL"), "a", "改名之前的启动命令写的是 ASH_*");
      assert.equal(read({ HARNESS_URL: "h" }, "NAVI_URL"), "h", "更早一代的 HARNESS_* 也照旧认");
      assert.equal(read({ NAVI_URL: "n", ASH_URL: "a", HARNESS_URL: "h" }, "NAVI_URL"), "n", "新名优先");
      assert.equal(read({ NAVI_URL: "", ASH_URL: "a" }, "NAVI_URL"), "", "显式设成空串也算设了");
    }
    for (const clear of [clearEnv, bare.clearEnv]) {
      const env: Record<string, string | undefined> = { NAVI_TASK_ID: "n", ash_task_id: "a", Harness_Task_Id: "h", OTHER: "x" };
      clear(env, "NAVI_TASK_ID");
      assert.deepEqual(env, { OTHER: "x" }, "三代一起擦,键名大小写不论(Windows 的环境变量名不分大小写)");
    }
    const child: Record<string, string | undefined> = { ASH_DB: "/old", HARNESS_DB: "/older" };
    setEnv(child, "NAVI_DB", "/new");
    assert.deepEqual(child, { NAVI_DB: "/new" }, "写给子进程只写新名,继承来的旧名一并拿掉");
    assert.deepEqual(withLegacyEnvNames({ NAVI_PREVIEW_BASE: "/p/", PORT: "1" }),
      { NAVI_PREVIEW_BASE: "/p/", ASH_PREVIEW_BASE: "/p/", PORT: "1" }, "给用户命令的那几个带一份上一代旧名");
    for (const read of [readStorageEnv, bare.readStorageEnv]) {
      assert.equal(read({ ASH_DB: "/tmp/x.db" }, "NAVI_DB"), "/tmp/x.db");
      assert.equal(read({ NAVI_DB: "/tmp/x.db", ASH_DB: " /tmp/x.db " }, "NAVI_DB"), "/tmp/x.db", "几代指向同一处不算冲突");
      assert.equal(read({ NAVI_DB: "  ", ASH_DB: "/tmp/x.db" }, "NAVI_DB"), "/tmp/x.db", "空串当没设,不顶掉旧名");
      // 预览实例底下的智能体继承了 NAVI_DB,测试又拿旧名指向临时库:挑哪个都可能挑错,所以拒。
      assert.throws(() => read({ NAVI_DB: "/data/preview.db", ASH_DB: "/tmp/x.db" }, "NAVI_DB"),
        /NAVI_DB=\/data\/preview\.db 和 ASH_DB=\/tmp\/x\.db 同时设了/);
    }
    console.log("✓ 环境变量:旧名读得到、新名优先、三代一起擦;指向数据的变量几代不一致就拒绝");
  }

  // ── ③ MCP 登记名 / 工具名 ──────────────────────────────────────────────────
  {
    assert.equal(ASH_MCP_SERVER_NAME, "navi");
    for (const name of ["navi", "ash", "harness"]) {
      assert.ok(isAshMcpServerName(name), `${name}:用户配置里旧版 setup 登记的名字也是这个 MCP`);
      assert.equal(ashMcpToolOf(`mcp__${name}__complete_task`), "complete_task", `${name}:升级之前起的会话报的是旧工具名`);
    }
    assert.ok(!isAshMcpServerName("kb") && !isAshMcpServerName(undefined));
    assert.equal(ashMcpToolOf("mcp__kb__kb_search"), null, "别家的 MCP 工具不算");
    assert.equal(ashMcpToolOf("mcp__navi__"), null, "只有前缀没有工具名不算");
    console.log("✓ MCP:登记名与工具名 navi / ash / harness 三代都认");
  }

  // ── ④ 任务分支 ───────────────────────────────────────────────────────────
  {
    const id = "Ab3dEf9hXYZ";
    assert.equal(taskBranchName(id), "navi/Ab3dEf9h", "新建的分支写新前缀");
    assert.deepEqual(taskBranchNames(id), ["navi/Ab3dEf9h", "ash/Ab3dEf9h", "harness/Ab3dEf9h"]);
    for (const prefix of ["navi/", "ash/", "harness/"]) {
      assert.equal(taskIdPrefixOfBranch(`${prefix}Ab3dEf9h`), "Ab3dEf9h", `${prefix}:分支归属认各代前缀`);
      assert.ok(hasTaskBranchPrefix(`${prefix}x`) && isTaskBranchOf(`${prefix}Ab3dEf9h`, id));
    }
    assert.equal(taskIdPrefixOfBranch("feature/topic"), null);
    assert.equal(taskIdPrefixOfBranch("navi/a/b"), null, "多一层斜杠的不是任务分支");
    assert.ok(!isTaskBranchOf("navi/Zzzzzzzz", id));

    const { resolveWorktreeBranchName } = await import("../src/git.js");
    const repo = repoWithCommit("branches");
    assert.equal(await resolveWorktreeBranchName(repo, id), "navi/Ab3dEf9h", "没有分支:新建时用新前缀");
    for (const old of ["harness/Ab3dEf9h", "ash/Ab3dEf9h"]) {
      git(repo, "branch", old);
      assert.equal(await resolveWorktreeBranchName(repo, id), old, `升级之前的 ${old} 照旧找得到,不另开一条空分支`);
    }
    git(repo, "branch", "navi/Ab3dEf9h");
    assert.equal(await resolveWorktreeBranchName(repo, id), "navi/Ab3dEf9h", "几代都在时新名优先");
    console.log("✓ 任务分支:新建写 navi/,已有的 ash/、harness/ 分支照旧找得到");
  }

  // ── ⑤ 互斥:改名之前的服务留下的锁、占有锁、在线登记都要挡得住新版 ─────────────
  {
    // 一个「活着的、长得像 Navi 服务」的进程:命令行形状是 `node …/server/dist/index.js`。
    const fakeServer = join(root, "old", "server", "dist", "index.js");
    mkdirSync(join(fakeServer, ".."), { recursive: true });
    writeFileSync(fakeServer, "setInterval(() => {}, 1000);\n");
    sleeper = spawn(process.execPath, [fakeServer], { stdio: "ignore" });
    const pid = sleeper.pid!;
    await new Promise((r) => setTimeout(r, 300));

    const { acquireDbSingletonLock, liveAshHolderForDb, singletonLockFilesForDb, SingletonConflictError } = await import("../src/singleton.js");
    const { canonicalResourceKey, withResourceClaim, ResourceClaimError } = await import("../src/resource-claim.js");
    const { liveAshPresenceFor } = await import("../src/ash-presence.js");

    const [lockFile, legacyLock] = singletonLockFilesForDb(dbFile);
    assert.equal(lockFile, `${dbFile}.navi.lock`);
    assert.equal(legacyLock, `${dbFile}${legacyNames.LEGACY_SINGLETON_LOCK_SUFFIX}`);
    // 旧版服务只写旧名那一把。
    writeFileSync(legacyLock, JSON.stringify({
      version: 1, pid, acquiredAt: new Date().toISOString(), port: 4317, dbFile, cwd: root, argv: [fakeServer], token: "old-server",
    }));
    assert.equal(liveAshHolderForDb(dbFile)?.pid, pid, "旧名锁上活着的旧版服务认得出来");
    assert.throws(() => acquireDbSingletonLock({ port: null }),
      (e: unknown) => e instanceof SingletonConflictError && e.lockFile === legacyLock && e.holder.pid === pid,
      "旧版服务占着这份库 ⇒ 新版起不来,而且挡下它的正是那把旧名锁");
    assert.ok(!existsSync(lockFile), "被挡下时不留新名的锁");
    rmSync(legacyLock);

    const lock = acquireDbSingletonLock({ port: null });
    assert.ok(lock, "没人占着就拿得到");
    assert.ok(existsSync(lockFile) && existsSync(legacyLock), "新版两代名字都持有:旧版服务只认旧名");
    assert.deepEqual(JSON.parse(readFileSync(legacyLock, "utf8")), JSON.parse(readFileSync(lockFile, "utf8")), "两份内容相同");
    lock!.release();
    assert.ok(!existsSync(lockFile) && !existsSync(legacyLock), "放锁两份一起放");

    // 起手动作的占有锁:旧版只建 `.ash-claim.lock`。
    const key = canonicalResourceKey(dbFile);
    const legacyClaim = `${key}${legacyNames.LEGACY_RESOURCE_CLAIM_SUFFIX}`;
    writeFileSync(legacyClaim, JSON.stringify({ pid, note: "改名之前的服务", token: "t", at: new Date().toISOString() }));
    assert.throws(() => withResourceClaim([key], "新版", () => "ran"),
      (e: unknown) => e instanceof ResourceClaimError && e.claimFile === legacyClaim, "旧名占有锁被活进程拿着 ⇒ 等不到就拒");
    rmSync(legacyClaim);
    assert.equal(withResourceClaim([key], "新版", () => "ran"), "ran");
    assert.ok(!existsSync(legacyClaim) && !existsSync(`${key}.navi-claim.lock`), "用完两代都放掉");

    // 在线登记:旧版只写 `.ash-online.<pid>.json`。
    const legacyPresence = `${key}${legacyNames.LEGACY_PRESENCE_PREFIX}${pid}.json`;
    writeFileSync(legacyPresence, JSON.stringify({ pid, port: 4317, startedAt: new Date().toISOString() }));
    assert.equal(liveAshPresenceFor(key)?.pid, pid, "旧名在线登记照样算「有人在用」");
    rmSync(legacyPresence);
    console.log("✓ 互斥:旧版服务的 .ash.lock / .ash-claim.lock / .ash-online. 都挡得住新版;新版两代都持有、两代都放");
  }

  // ── ⑥ 接力线 ─────────────────────────────────────────────────────────────
  {
    const { HANDOFF_TRUSTED_MARK, hasHandoffTrustedMark, isHandoffService, legacyPeerBranchRefusal } = await import("../src/handoff-wire.js");
    assert.ok(isHandoffService("ash") && isHandoffService("navi") && !isHandoffService("other"), "ping 应答新旧两代都认");
    assert.ok(hasHandoffTrustedMark({ ash: true }) && hasHandoffTrustedMark({ navi: true }) && !hasHandoffTrustedMark({}));
    assert.deepEqual({ ...HANDOFF_TRUSTED_MARK }, { navi: true, ash: true }, "发出去的错误标记两代各一份,旧版只认 ash");
    assert.deepEqual(withLegacyHeaderNames({ "x-navi-peer-key": "k" }), { "x-navi-peer-key": "k", "x-ash-peer-key": "k" });
    assert.equal(readHeader((name) => ({ "x-ash-peer-key": "old" } as Record<string, string>)[name], "x-navi-peer-key"), "old",
      "旧版对端只发旧名的头");
    assert.ok(isNaviHeaderName("X-Ash-Turn-Token") && isNaviHeaderName("x-navi-turn-token") && !isNaviHeaderName("x-other"));

    const repo = repoWithCommit("handoff");
    const task = { id: "HandOff1xyz", useWorktree: true };
    git(repo, "branch", "navi/HandOff1");
    assert.match(await legacyPeerBranchRefusal({}, task, repo) ?? "", /对端还是改名之前的版本.*navi\/HandOff1/,
      "旧版对端不报分支前缀、这条任务是新前缀 ⇒ 打包之前就拒,说清原因");
    assert.equal(await legacyPeerBranchRefusal({ taskBranchPrefix: "navi/" }, task, repo), null, "新版对端放行");
    assert.equal(await legacyPeerBranchRefusal({}, { ...task, useWorktree: false }, repo), null, "不用 worktree 的任务没有分支要挂");
    git(repo, "branch", "-D", "navi/HandOff1");
    git(repo, "branch", "ash/HandOff1");
    assert.equal(await legacyPeerBranchRefusal({}, task, repo), null, "升级之前的 ash/ 分支旧版认得,照常放行");
    console.log("✓ 接力:旧版对端的 ping / 错误标记 / 请求头照认,旧版对端 + 新前缀分支在打包之前就拒");
  }

  // ── ⑦ setup 迁移 codex 登记 + 真执行器开关的闸 ─────────────────────────────
  {
    const { registerCodexMcp } = await import(new URL("../../scripts/codex-mcp.mjs", import.meta.url).href) as {
      registerCodexMcp: (opts: Record<string, unknown>) => { action: string; legacyLeft?: boolean };
    };
    const file = join(root, "codex", "config.toml");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `[mcp_servers.ash]\ncommand = "node"\n[other]\nk = 1\n`);
    const answers = [
      { ok: true, servers: [{ name: "ash", enabled: true }] },
      { ok: true, servers: [{ name: ASH_MCP_SERVER_NAME, enabled: true }] },
    ];
    const result = registerCodexMcp({
      configFile: file, mcpEntry: "/x/mcp/dist/index.js", url: "http://localhost:4317",
      name: ASH_MCP_SERVER_NAME, legacyNames: legacyNames.LEGACY_MCP_SERVER_NAMES,
      listServers: () => answers.shift() ?? assert.fail("多问了一次 codex"),
      // codex 在沙盘里删旧名:模拟成那份配置只剩 [other]。
      removeServer: (_name: string, home: string) => { writeFileSync(join(home, "config.toml"), "[other]\nk = 1\n"); return true; },
    });
    assert.equal(result.action, "migrated", "用户配置里旧版 setup 登记的 ash ⇒ 迁成 navi");
    const migrated = readFileSync(file, "utf8");
    assert.match(migrated, /\[mcp_servers\.navi\]/);
    assert.doesNotMatch(migrated, /\[mcp_servers\.ash\]/, "旧名那条不留:注入用的是新名,留着就是两份同样的工具");

    const { realAgentSwitchViolations } = await import(new URL("../../scripts/test-process-conventions.mjs", import.meta.url).href) as {
      realAgentSwitchViolations: (source: string, filename: string) => string[];
    };
    for (const name of envNameGenerations("NAVI_ALLOW_REAL_AGENT")) {
      assert.equal(realAgentSwitchViolations(`process.env.${name} = "1";`, "fixture.ts").length, 1, `${name}:闸那一侧各代都认,这边各代都拦`);
    }
    console.log("✓ setup 把 codex 里旧名 ash 的登记迁成 navi;真执行器开关三代名字都拦");
  }
} finally {
  sleeper?.kill();
  rmSync(root, { recursive: true, force: true });
}
console.log("rename compat: 全部通过");

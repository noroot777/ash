// 验收「推送到远程」的目的地这一面（task-accept-push.ts / accept-push-destination.ts / git-accept-remote.ts 的 network）：
// 推到哪照 git 的口径解析；确认层看到的就是执行时推的那一处（指纹核）；推送地址里的认证信息不出服务端（发给页面的、
// 报错、任务记录、git 命令行参数里都没有）；实际联系的只有确认过的那个地址；确认失效（旧版本、坏值）就拒，不当没选推送。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePushChoice } from "@navi/shared/accept-gate";
import { git, makeStage, pushHarness, root } from "./accept-push-fixture.js";
import { releaseTmpDb } from "./tmp-db.js";

try {
  const { acceptTask } = await import("../src/task-accept.js");
  const { resolvePushTarget } = await import("../src/git-accept-remote.js");
  const { pushDestinationView } = await import("../src/task-accept-push.js");
  const { parseChoices } = await import("../src/accept-gate-handoff.js");
  const { wsOf, seedTask, rowOf, projectOf, stageOf } = await pushHarness();
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  /** 跑 fn 期间把每一次 git 的命令行参数记进 log。 */
  const recordingArgv = async <T>(log: string, fn: () => Promise<T>): Promise<T> => {
    const shim = join(root, `argv-shim-${Date.now()}`);
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, "git"), ["#!/bin/sh", `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`, `exec "${realGit}" "$@"`, ""].join("\n"), { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = `${shim}:${saved}`;
    try { return await fn(); } finally { process.env.PATH = saved; }
  };

  // 1. 推到哪：照 git 自己的口径（pushRemote → pushDefault → 上游 → origin）；没有远程就不提供。
  {
    const bare = join(root, "no-remote");
    execFileSync("git", ["init", "-q", "-b", "main", bare]);
    assert.equal(await resolvePushTarget(bare, "main"), null, "没有远程就没有可推的地方");
    const { repo, remote } = makeStage("resolve");
    assert.deepEqual(await resolvePushTarget(repo, "main"), { remote: "origin", remoteBranch: "main", url: remote });
    git(repo, "remote", "add", "mirror", remote);
    git(repo, "config", "branch.main.pushRemote", "mirror");
    assert.deepEqual(await resolvePushTarget(repo, "main"), { remote: "mirror", remoteBranch: "main", url: remote }, "pushRemote 优先");
    git(repo, "config", "--unset", "branch.main.pushRemote");
    git(repo, "branch", "-q", "trunk");
    assert.deepEqual(await resolvePushTarget(repo, "trunk"), { remote: "origin", remoteBranch: "trunk", url: remote }, "没上游时推到 origin 的同名分支");
    git(repo, "config", "branch.trunk.remote", ".");
    assert.equal(await resolvePushTarget(repo, "trunk"), null, "上游是本地分支：不推");
  }

  // 8. 门禁跑完自动接着验收的那一次带的是冻结下来的目的地：存下来的读得回来；存了却认不出（只有 true、坏值、上一版
  //    没有指纹的）是「确认失效」，不是「没选推送」（审查第 4 轮第 3 条）。
  {
    const dest = { branch: "main", remote: "origin", remoteBranch: "main", url: "/x.git", fingerprint: "fp" };
    assert.deepEqual(parseChoices(JSON.stringify({ by: "human", push: dest }))?.push, dest);
    assert.equal(parseChoices(JSON.stringify({ by: "human", push: true }))?.push, "stale", "续做只认冻结的目的地");
    assert.equal(parseChoices(JSON.stringify({ by: "human", push: { ...dest, url: 3 } }))?.push, "stale");
    const { fingerprint: _drop, ...legacy } = dest;
    assert.equal(parseChoices(JSON.stringify({ by: "human", push: legacy }))?.push, "stale", "上一版存的没有指纹：确认失效");
    assert.equal(parsePushChoice(legacy), "stale", "请求体里同一个口径");
    assert.equal(parsePushChoice(undefined), null);
    assert.equal(parsePushChoice(false), null);
    assert.equal(parseChoices(JSON.stringify({ by: "human" }))?.push, undefined);
  }

  // 9. 确认的目的地和执行时解析出来的不是同一处（审查第 1 轮 F1）：拒，什么都不动；一样就照常推。
  {
    const { repo, remote } = makeStage("dest-changed");
    const mirror = join(root, "dest-changed-mirror.git");
    execFileSync("git", ["clone", "-q", "--bare", remote, mirror]);
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const shown = (await pushDestinationView(await rowOf(taskId), await projectOf(taskId)))!;
    assert.deepEqual({ ...shown, fingerprint: "" }, { branch: "main", remote: "origin", remoteBranch: "main", url: remote, fingerprint: "" });
    assert.ok(shown.fingerprint);
    git(repo, "remote", "add", "mirror", mirror);
    git(repo, "config", "branch.main.pushRemote", "mirror");
    const before = git(repo, "rev-parse", "main");
    const changed = await acceptTask(taskId, "human", { push: shown });
    assert.equal(changed.accepted, false);
    if (!changed.accepted) assert.equal(changed.reason, "push_destination_changed");
    assert.equal(git(repo, "rev-parse", "main"), before, "目的地变了就不合");
    assert.equal(git(mirror, "rev-parse", "main"), before, "也不推到新的那一处");
    git(repo, "config", "--unset", "branch.main.pushRemote");
    const same = await acceptTask(taskId, "human", { push: shown });
    assert.equal(same.accepted, true, same.accepted ? "" : same.error);
    assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "main"), "推到的就是确认的那一处");
    assert.equal(git(mirror, "rev-parse", "main"), before);
  }

  // 22. 推送地址里内嵌认证信息（审查第 4 轮第 2 条）：两种写法 —— `user:密码@` 和直接把令牌写在用户名位置的 `令牌@`。
  //     发给确认层的目的地只有抹掉整段认证信息的地址和指纹；目的地变了的报错、任务记录里都没有明文；指纹被改过就拒；
  //     真去拉推时认证信息不进 git 命令行参数，拉不到的报错里也没有明文。
  for (const [name, auth] of [["cred-userpass", "review-user:SECRET"], ["cred-token", "SECRET"]] as const) {
    const { repo } = makeStage(name);
    const taskId = await seedTask(repo, "task.txt", "task\n");
    git(repo, "remote", "set-url", "origin", `https://${auth}_OLD@127.0.0.1:1/r.git`);
    const view = (await pushDestinationView(await rowOf(taskId), await projectOf(taskId)))!;
    assert.ok(!JSON.stringify(view).includes("SECRET"), JSON.stringify(view));
    assert.equal(view.url, "https://***@127.0.0.1:1/r.git", `${name}：整段认证信息都抹掉`);
    git(repo, "remote", "set-url", "origin", `https://${auth}_NEW@127.0.0.1:1/r.git`);
    const changed = await acceptTask(taskId, "human", { push: view });
    assert.equal(changed.accepted, false);
    if (!changed.accepted) {
      assert.equal(changed.reason, "push_destination_changed", "只有认证信息变了也算目的地变了");
      assert.ok(!changed.error.includes("SECRET"), changed.error);
    }
    const current = (await pushDestinationView(await rowOf(taskId), await projectOf(taskId)))!;
    const forged = await acceptTask(taskId, "human", { push: { ...current, fingerprint: view.fingerprint } });
    assert.equal(forged.accepted, false);
    if (!forged.accepted) assert.equal(forged.reason, "push_destination_changed", "指纹对不上就拒");
    // 照确认的目的地真去拉：127.0.0.1:1 连不上，报错里不带认证信息；git 的命令行参数里也不带。
    const argvLog = join(root, `${name}-argv.log`);
    const fetched = await recordingArgv(argvLog, () => acceptTask(taskId, "human", { push: current }));
    assert.equal(fetched.accepted, false);
    if (!fetched.accepted) {
      assert.equal(fetched.reason, "push_fetch_failed", fetched.error);
      assert.ok(!fetched.error.includes("SECRET"), fetched.error);
    }
    const argv = readFileSync(argvLog, "utf8");
    assert.ok(argv.includes("fetch"), "确实去拉了");
    assert.ok(!argv.includes("SECRET"), "认证信息不进 git 的命令行参数");
  }
  const leaked = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? leaked(join(dir, entry.name)) : readFileSync(join(dir, entry.name), "utf8").includes("SECRET") ? [join(dir, entry.name)] : []) : [];
  assert.deepEqual(leaked(process.env.NAVI_RUNS_DIR!), [], "任务记录里没有明文");

  // 24. 实际联系的只有确认过的那一个地址（审查第 4 轮第 1 条）：仓库配置里给上一版借用的固定远程名配了 pushurl 指向
  //     另一个仓库，推的仍是确认的那一处；每一次借的远程名都不一样，配置里也就没有可继承的。
  {
    const { repo, remote } = makeStage("bound-remote");
    const decoy = join(root, "bound-remote-decoy.git");
    execFileSync("git", ["clone", "-q", "--bare", remote, decoy]);
    const before = git(decoy, "rev-parse", "main");
    git(repo, "config", "remote.navi-accept-push.pushurl", decoy);
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const source = git(wsOf.get(taskId)!, "rev-parse", "HEAD");
    const view = (await pushDestinationView(await rowOf(taskId), await projectOf(taskId)))!;
    const argvLog = join(root, "bound-remote-argv.log");
    const result = await recordingArgv(argvLog, () => acceptTask(taskId, "human", { push: view }));
    assert.equal(result.accepted, true, result.accepted ? "" : result.error);
    assert.equal(git(remote, "rev-parse", "main"), source, "确认的那个仓库收下了");
    assert.equal(git(decoy, "rev-parse", "main"), before, "另一个仓库一个字没收到");
    const names = [...readFileSync(argvLog, "utf8").matchAll(/(?:fetch|push) .*?(navi-accept-[0-9a-f]+)/g)].map((m) => m[1]);
    assert.ok(names.length >= 2, readFileSync(argvLog, "utf8"));
    assert.equal(new Set(names).size, names.length, "每一次借的远程名都不同");
  }

  // 25. 确认失效（更新之前打开的确认框发来的、没有指纹的那一份）：拒，什么都不动 —— 不当「没选推送」去合并、清理。
  {
    const { repo, remote } = makeStage("stale-confirm");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const before = git(repo, "rev-parse", "main");
    const result = await acceptTask(taskId, "human", { push: "stale" });
    assert.equal(result.accepted, false);
    if (!result.accepted) assert.equal(result.reason, "push_confirmation_stale", result.error);
    assert.equal(git(repo, "rev-parse", "main"), before, "本地没合");
    assert.equal(git(remote, "rev-parse", "main"), before, "远程没动");
    assert.ok(existsSync(wsOf.get(taskId)!), "任务工作区还在");
    assert.equal(await stageOf(taskId), "verified");
  }

  console.log("accept push destination: 推到哪 / 门禁续做带冻结目的地、存坏的算确认失效 / 目的地变了就拒 / 认证信息（两种写法）不出服务端 / 只联系确认过的地址 / 确认失效就拒 全部通过");
} finally {
  await releaseTmpDb();
}
process.exit(0);

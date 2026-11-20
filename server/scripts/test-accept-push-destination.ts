// 验收「推送到远程」的目的地这一面（task-accept-push.ts / accept-push-destination.ts / git-accept-remote.ts 的 network）：
// 推到哪照 git 的口径解析；确认层看到的就是执行时推的那一处（指纹核）；推送地址里的认证信息不出服务端（发给页面的、
// 报错、任务记录、git 命令行参数里都没有）；确认框显示的、实际接收的、回执写的是同一处；确认失效（旧版本、坏值）就拒，不当没选推送。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  // 22. 推送地址里内嵌认证信息（审查第 4 轮第 2 条）：`user:密码@`、直接把令牌写在用户名位置的 `令牌@`、密码里带引号。
  //     发给确认层的目的地只有抹掉整段认证信息的地址和指纹；目的地变了的报错、任务记录里都没有明文；指纹被改过就拒；
  //     真去拉推时认证信息不进 git 命令行参数，拉不到的报错里也没有明文。
  // 第三种：密码里带引号（URL 认证段的合法字符），脱敏不能在引号处就停下（审查第 5 轮第 2 条）。
  for (const [name, auth] of [["cred-userpass", "review-user:SECRET"], ["cred-token", "SECRET"], ["cred-quote", `review-user:SECRET'x"y`]] as const) {
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

  // 24. 确认框显示的地址就是实际接收推送的那一处，回执写的也是它（审查第 4 轮起 F1，熔断后选了「照 git push 的口径」）：
  //     · 改写规则串着（A → B，又有一条 B → C）：git 只改写一次，推给 B；不能把展开后的 B 再交给 git 改成 C；
  //     · pushInsteadOf 只改推送地址：确认框显示改写后的那一处，推也推给它，拉取地址那个不碰。
  //     两种情况下 git 的命令行参数里都只有远程名，没有地址。
  for (const kind of ["chain", "push-instead-of"] as const) {
    const { repo, remote } = makeStage(`dest-${kind}`);
    const receiver = join(root, `dest-${kind}-receiver.git`);
    const decoy = join(root, `dest-${kind}-decoy.git`);
    execFileSync("git", ["clone", "-q", "--bare", remote, receiver]);
    execFileSync("git", ["clone", "-q", "--bare", remote, decoy]);
    const decoyBefore = git(decoy, "rev-parse", "main");
    const fetchSide = git(remote, "rev-parse", "main");
    if (kind === "chain") {
      git(repo, "remote", "set-url", "origin", "navi-alias-a:");
      git(repo, "config", `url.${receiver}.insteadOf`, "navi-alias-a:");
      git(repo, "config", `url.${decoy}.insteadOf`, receiver);
    } else {
      git(repo, "config", `url.${receiver}.pushInsteadOf`, remote);
      git(repo, "config", `url.${decoy}.insteadOf`, receiver);
    }
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const source = git(wsOf.get(taskId)!, "rev-parse", "HEAD");
    const view = (await pushDestinationView(await rowOf(taskId), await projectOf(taskId)))!;
    assert.equal(view.url, receiver, `${kind}：确认框显示 git 算出的最终地址`);
    const argvLog = join(root, `dest-${kind}-argv.log`);
    const result = await recordingArgv(argvLog, () => acceptTask(taskId, "human", { push: view }));
    assert.equal(result.accepted, true, result.accepted ? "" : result.error);
    assert.equal(git(receiver, "rev-parse", "main"), source, `${kind}：确认的那一处收下了`);
    assert.equal(git(decoy, "rev-parse", "main"), decoyBefore, `${kind}：没有被再改写一遍推到别处`);
    if (kind === "push-instead-of") assert.equal(git(remote, "rev-parse", "main"), fetchSide, "拉取地址那个仓库不碰");
    assert.equal(result.push?.ok && result.push.to, receiver, `${kind}：回执写的是 git 实际推往的地址`);
    const argv = readFileSync(argvLog, "utf8").split("\n").filter((line) => / (?:fetch|push) /.test(line));
    assert.ok(argv.some((line) => line.includes("push")), readFileSync(argvLog, "utf8"));
    for (const line of argv) assert.ok(!line.includes(receiver) && !line.includes(decoy), `命令行里只有远程名：${line}`);
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

  // 26. 拉取那个仓库已经有成果、接收推送的那个仓库没有（自由审查第 1 轮）：拉到的状态不能当接收端收到了的证据。
  //     首次验收（同步进来就成了 already_merged）和停在 merged 只差收尾的重试两种：接收端拒收 → 如实失败，任务分支、
  //     工作区和阶段都留着；接收端恢复收推送后再点，真推上去了才验收完成。
  {
    const { db } = await import("../src/db/index.js");
    const { tasks } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    for (const mode of ["first", "resume-merged"] as const) {
      const { repo, remote } = makeStage(`recv-${mode}`);
      const receiver = join(root, `recv-${mode}-receiver.git`);
      execFileSync("git", ["clone", "-q", "--bare", remote, receiver]);
      git(repo, "remote", "set-url", "--push", "origin", receiver);
      const taskId = await seedTask(repo, "task.txt", "task\n");
      const ws = wsOf.get(taskId)!;
      const source = git(ws, "rev-parse", "HEAD");
      git(ws, "push", "-q", remote, "HEAD:main");
      if (mode === "resume-merged") {
        git(repo, "merge", "-q", "--ff-only", source);
        await db.update(tasks).set({ stage: "merged", acceptedTargetBranch: "main", acceptedMergeCommit: source, acceptedSourceCommit: source })
          .where(eq(tasks.id, taskId));
      }
      const receiverBefore = git(receiver, "rev-parse", "main");
      const hook = join(receiver, "hooks", "pre-receive");
      writeFileSync(hook, "#!/bin/sh\necho 'receiver says no' >&2\nexit 1\n", { mode: 0o755 });
      const view = (await pushDestinationView(await rowOf(taskId), await projectOf(taskId)))!;
      assert.equal(view.url, receiver);
      const refused = await acceptTask(taskId, "human", { push: view });
      assert.equal(refused.accepted, false, `${mode}：接收端拒收，不能算推上去了`);
      if (!refused.accepted) assert.equal(refused.reason, "push_failed", refused.error);
      assert.equal(git(receiver, "rev-parse", "main"), receiverBefore, `${mode}：接收端确实没有成果`);
      assert.ok(existsSync(ws), `${mode}：任务工作区还在`);
      assert.equal(git(repo, "rev-parse", `refs/heads/${git(ws, "rev-parse", "--abbrev-ref", "HEAD")}`), source, `${mode}：任务分支还在`);
      assert.equal(await stageOf(taskId), mode === "first" ? "verified" : "merged");
      rmSync(hook);
      const accepted = await acceptTask(taskId, "human", { push: view });
      assert.equal(accepted.accepted, true, accepted.accepted ? "" : `${accepted.reason}: ${accepted.error}`);
      assert.equal(git(receiver, "rev-parse", "main"), source, `${mode}：接收端真收下了才验收完成`);
      assert.equal(await stageOf(taskId), "accepted");
    }
  }

  console.log("accept push destination: 推到哪 / 门禁续做带冻结目的地、存坏的算确认失效 / 目的地变了就拒 / 认证信息（三种写法）不出服务端 / 显示的就是实际推往的地址 / 拉取端有、接收端没有不算推上去 / 确认失效就拒 全部通过");
} finally {
  await releaseTmpDb();
}
process.exit(0);

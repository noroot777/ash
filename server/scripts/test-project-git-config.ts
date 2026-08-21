// 项目级 git 配置的回归。钉住的是五件靠通读发现不了的事：
//
// ① **令牌绝不进 argv**（`gitNetInjection` 的 args 里不许出现秘密本身）；
// ② 那段 credential helper 在**真的 sh** 里跑出来的是什么——带空格/反斜杠的令牌是这段
//    代码唯一会静默出错的地方，`printf` 换成 `echo` 测试就该红；
// ③ 空字符串 = `--unset`（回去跟着全局走），跟「这次没动它」是两回事；
// ④ 删项目要把凭证一起删掉，不然换个同 id 的项目会捡到上一个的令牌；
// ⑤ **core.sshCommand 是被 shell 执行的**，私钥路径里能展开成命令的字符一律拒绝，而且
//    拼串出口和写侧各拦一道（第 1 轮审查真的用 `$(touch …)` 建出过文件）。
//
// 全局配置用 GIT_CONFIG_GLOBAL 指到临时文件，scope 判定才不受跑测试这台机器的影响。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-project-git-config-test-"));
process.env.ASH_DB = join(root, "ash.db");
const globalConfig = join(root, "gitconfig-global");
writeFileSync(globalConfig, "[user]\n\tname = Global Person\n\temail = global@example.com\n");
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";

const repo = join(root, "repo");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
/** 注入成功的话它会被建出来。全程不许出现。 */
const marker = join(root, "pwned");

try {
  execFileSync("git", ["init", "-q", repo]);
  git("remote", "add", "origin", "https://someone:ghp_secret@example.com/o/r.git");
  git("remote", "add", "ssh", "git@example.com:o/r.git");

  const identityMod = await import("../src/git-identity.js");
  const {
    checkSshKeyPath, readGitIdentity, readRemotes, redactRemoteUrl,
    sshCommandFor, sshKeyPath, writeGitIdentity,
  } = identityMod;
  const credMod = await import("../src/git-credentials.js");
  const {
    CREDENTIAL_HELPER_SNIPPET, deleteProjectGitCredential, gitNetInjection,
    readProjectGitCredential, saveProjectGitCredential,
  } = credMod;
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects } = await import("../src/db/schema.js");
  const { mountProjectGitRoutes } = await import("../src/project-git-routes.js");
  const { mountProjectRoutes } = await import("../src/project-routes.js");
  const { Hono } = await import("hono");
  await ensureSchema();

  // ── 脱敏与 sshCommand 的形状 ──
  {
    assert.equal(
      redactRemoteUrl("https://someone:ghp_secret@example.com/o/r.git"),
      "https://someone:***@example.com/o/r.git",
    );
    assert.equal(redactRemoteUrl("https://token@example.com/o/r.git"), "https://token@example.com/o/r.git");
    assert.equal(redactRemoteUrl("git@example.com:o/r.git"), "git@example.com:o/r.git");

    const remotes = await readRemotes(repo);
    assert.deepEqual(remotes.map((r) => r.name).sort(), ["origin", "ssh"], "同名远端 fetch/push 两行要去重");
    const origin = remotes.find((r) => r.name === "origin")!;
    assert.equal(origin.https, true);
    assert.ok(!origin.url.includes("ghp_secret"), "远端 URL 里的密码必须被抹掉");
    assert.equal(remotes.find((r) => r.name === "ssh")!.https, false);

    assert.equal(sshKeyPath(sshCommandFor("/home/x/.ssh/id_ed25519")), "/home/x/.ssh/id_ed25519");
    assert.match(sshCommandFor("/k"), /IdentitiesOnly=yes/, "不加它 ssh-agent 里的身份会抢先");
    assert.equal(sshKeyPath("ssh -i /no/quotes"), null, "认不出的形状要返回 null，不能瞎猜");
    assert.throws(() => checkSshKeyPath('/k/"evil'), /引号或换行/);
    assert.throws(() => checkSshKeyPath("/k\nevil"), /引号或换行/);

    // 私钥路径会被拼进 core.sshCommand，而 git 是**交给 shell** 执行它的：双引号里
    // `$(…)`、反引号、`!` 全是可执行代码，结尾的 `\` 则把我们加的右引号转义掉。
    // 第 1 轮审查实测过 `$(touch …)` 那条 —— marker 文件真的被建了出来。
    for (const evil of [`/k/$(touch ${marker})`, "/k/`touch /tmp/x`", "/k/x!!", "/k/trailing\\"]) {
      assert.throws(() => checkSshKeyPath(evil), /私钥路径/, `${evil}: 必须拒绝`);
      // 检查钉在**拼串这个出口**上，而不是只钉在路由那一个调用点上：将来多一个调用点也漏不掉。
      assert.throws(() => sshCommandFor(evil), /私钥路径/, `${evil}: sshCommandFor 自己也要拦`);
    }
    assert.equal(existsSync(marker), false, "拒绝发生在任何 shell 执行之前");
    // Windows 路径里的单个反斜杠是正常写法，不许误伤。
    assert.equal(checkSshKeyPath("C:\\Users\\me\\.ssh\\id_ed25519"), "C:\\Users\\me\\.ssh\\id_ed25519");
  }

  // ── 读：local vs inherited ──
  {
    const before = await readGitIdentity(repo);
    assert.equal(before.isRepo, true);
    assert.deepEqual(before.userName, { value: "Global Person", scope: "inherited" });

    await writeGitIdentity(repo, { "user.name": "Repo Person" });
    const after = await readGitIdentity(repo);
    assert.deepEqual(after.userName, { value: "Repo Person", scope: "local" });
    assert.equal(git("config", "--local", "--get", "user.name").trim(), "Repo Person",
      "身份必须落在仓库自己的 .git/config 里，agent 和用户的终端读的就是这一份");
  }

  // ── 写：空串 = unset，回去跟着全局走；本来就没设时 unset 不算失败 ──
  {
    await writeGitIdentity(repo, { "user.name": "" });
    assert.deepEqual((await readGitIdentity(repo)).userName, { value: "Global Person", scope: "inherited" });
    await writeGitIdentity(repo, { "user.name": "" }); // 幂等：--unset-all 退出码 5 不是错
    await writeGitIdentity(repo, { "core.sshCommand": sshCommandFor("/home/x/.ssh/id_ed25519") });
    assert.equal((await readGitIdentity(repo)).sshKeyPath, "/home/x/.ssh/id_ed25519");
    await writeGitIdentity(repo, { "core.sshCommand": "" });
    assert.equal((await readGitIdentity(repo)).sshKeyPath, null);

    // 写侧自己也认形状：不是 `sshCommandFor` 拼出来的那一种，一律拒绝。这样「往 config 里
    // 塞一条任意命令」在这一层就没有通道，而不是靠每个调用点都记得先过 checkSshKeyPath。
    await assert.rejects(
      () => writeGitIdentity(repo, { "core.sshCommand": `ssh -i /k -o IdentitiesOnly=yes; touch ${marker}` }),
      /只接受 ash 拼出来的形状/,
      "陌生形状的 core.sshCommand 必须拒绝",
    );
    assert.equal((await readGitIdentity(repo)).sshCommand.value, null, "被拒的写入不许落进 config");
    assert.equal(existsSync(marker), false, "被拒之后不许有任何东西被执行");

    const notRepo = await readGitIdentity(join(root, "nowhere"));
    assert.equal(notRepo.isRepo, false, "不是仓库要如实说，而不是抛");
    await assert.rejects(() => writeGitIdentity(join(root, "nowhere"), { "user.name": "x" }), /不是 Git 仓库/);
  }

  // ── 凭证：只写不读 + 绝不进 argv ──
  const SECRET = 'tok en\\with "quotes" $and `ticks`';
  {
    await saveProjectGitCredential("p1", "octocat", SECRET);
    const view = await readProjectGitCredential("p1");
    assert.equal(view?.username, "octocat");
    assert.equal(JSON.stringify(view).includes("tok en"), false, "读侧永远不许把令牌交出去");

    // 只改用户名：令牌留空 = 沿用已存的那个
    await saveProjectGitCredential("p1", "octodog", "");
    const injection = await gitNetInjection("p1");
    assert.equal(injection.env.ASH_GIT_USERNAME, "octodog");
    assert.equal(injection.env.ASH_GIT_PASSWORD, SECRET, "留空要沿用旧令牌，不能被清成空");
    assert.equal(injection.args.join(" ").includes(SECRET), false, "令牌绝不进 argv");
    assert.deepEqual(injection.args.slice(0, 2), ["-c", "credential.helper="],
      "先清空继承来的 helper，否则系统钥匙串里那份旧凭证会抢着答");

    await assert.rejects(() => saveProjectGitCredential("p2", "someone", ""), /还没存过令牌/);
    assert.deepEqual(await gitNetInjection("p2"), { args: [], env: {} }, "没配凭证就什么都不注入");
    assert.deepEqual(await gitNetInjection(null), { args: [], env: {} });
  }

  // ── 那段 helper 在真的 git 里跑出来是什么 ──
  //
  // 不模拟、不读代码：把 `gitNetInjection` 原样给的 `-c` 参数喂给 `git credential fill`，
  // 让 git 自己按它的规则调 helper。这是这条链上唯一能真正证明「凭证送到了」的一步，
  // 而且离线（credential fill 不联网）。
  {
    const injection = await gitNetInjection("p1");
    const out = execFileSync("git", [...injection.args, "credential", "fill"], {
      input: "protocol=https\nhost=example.com\n\n",
      encoding: "utf8",
      env: { ...process.env, ...injection.env },
    });
    assert.match(out, /^username=octodog$/m, "git 必须真的从 helper 里拿到用户名");
    assert.ok(out.includes(`password=${SECRET}`),
      "带空格/反斜杠/引号的令牌必须原样送到 git（这是 printf 而不是 echo 的理由）");

    const body = CREDENTIAL_HELPER_SNIPPET.replace(/^!/, "");
    const other = execFileSync("sh", ["-c", `${body} store`], {
      encoding: "utf8",
      env: { ...process.env, ...injection.env },
    });
    assert.equal(other, "", "store/erase 什么都不做且退出 0，否则 git 会当成一次真失败");
  }

  // ── 端点 ──
  {
    const api = new Hono();
    mountProjectRoutes(api);
    mountProjectGitRoutes(api);
    const send = (path: string, method: string, body?: unknown) => api.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const created = await (await send("/projects", "POST", { name: "git-cfg", repoPath: repo })).json() as { id: string };
    const pid = created.id;

    const read = await send(`/projects/${pid}/git-config`, "GET");
    assert.equal(read.status, 200);
    const view = await read.json() as { identity: { userName: { scope: string } }; credential: null };
    assert.equal(view.identity.userName.scope, "inherited");
    assert.equal(view.credential, null);

    const saved = await send(`/projects/${pid}/git-config`, "PUT", {
      userName: "Route Person", userEmail: "route@example.com", sshKeyPath: "/tmp/key",
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { identity: { userEmail: { value: string }; sshKeyPath: string } };
    assert.equal(savedBody.identity.userEmail.value, "route@example.com");
    assert.equal(savedBody.identity.sshKeyPath, "/tmp/key");

    const bad = await send(`/projects/${pid}/git-config`, "PUT", { sshKeyPath: '/tmp/"k' });
    assert.equal(bad.status, 400, "带引号的私钥路径要在写进 config 之前就被拒");

    const rce = await send(`/projects/${pid}/git-config`, "PUT", { sshKeyPath: `/tmp/$(touch ${marker})` });
    assert.equal(rce.status, 400, "会被 shell 展开的私钥路径同样要在写进 config 之前就被拒");
    assert.equal(existsSync(marker), false, "从端点进来也不许执行到任何东西");
    assert.equal((await readGitIdentity(repo)).sshKeyPath, "/tmp/key", "被拒的写入不许动已有的配置");

    const cred = await send(`/projects/${pid}/git-credential`, "PUT", { username: "octocat", secret: "s3cret" });
    assert.equal(cred.status, 200);
    const credBody = await cred.text();
    assert.equal(credBody.includes("s3cret"), false, "端点回包里不许带令牌");
    assert.equal((await gitNetInjection(pid)).env.ASH_GIT_PASSWORD, "s3cret");

    // 删项目要连凭证一起删：id 是可以被复用的，捡到上一个项目的令牌会静默推错地方。
    const gone = await send(`/projects/${pid}`, "DELETE");
    assert.equal(gone.status, 200);
    assert.equal(await readProjectGitCredential(pid), null, "删项目要把凭证一起删掉");
    assert.equal((await db.select().from(projects)).length, 0);

    const missing = await send("/projects/nope/git-config", "GET");
    assert.equal(missing.status, 404);
  }

  await deleteProjectGitCredential("p1");
  console.log("project git config ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

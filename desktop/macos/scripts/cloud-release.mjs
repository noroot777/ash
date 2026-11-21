import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "./appcast.mjs";
import { GitHub, resolveToken } from "./github.mjs";
import { WORKFLOW, assertVersion, downloadPage, itemDetails, latestItem, readConfig, runName, sourceVersion } from "./release-state.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VERSION_FILE = "desktop/macos/build.sh";

function git(cwd, args, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`git ${args[0]} 失败：${result.stderr || result.stdout || result.signal}`);
  return result.stdout.trim();
}

function githubRemote(url, repo) {
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)\/?$/);
  return match?.[1].replace(/\.git$/, "").toLowerCase() === repo.toLowerCase();
}

async function previousRun(github, repo, version, commit) {
  for (let page = 1; ; page++) {
    const { json } = await github.call("GET", `/repos/${repo}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`);
    const runs = json.workflow_runs ?? [];
    const existing = runs.find((run) => run.display_title === runName(version, commit));
    if (existing) return existing;
    if (runs.length < 100) return null;
  }
}

export async function releaseCloud(version, { cwd = ROOT, github, say = console.log } = {}) {
  assertVersion(version);
  if (git(cwd, ["branch", "--show-current"]) !== "main") throw new Error("只从本地 main 发布；先整理并合入需要发布的代码。");
  if (git(cwd, ["status", "--porcelain"])) throw new Error("工作区有没提交的改动：先整理提交，再发版（不会替你提交开发改动）。");
  const config = readConfig(join(cwd, "desktop/macos/release.json"));
  const origin = git(cwd, ["config", "--get", "remote.origin.url"]);
  if (!githubRemote(origin, config.releaseRepo)) throw new Error(`origin 不指向 GitHub ${config.releaseRepo}，没有推送或修改版本。`);
  const pushUrls = spawnSync("git", ["config", "--get-all", "remote.origin.pushurl"], { cwd, encoding: "utf8" });
  if (pushUrls.status === 0 && pushUrls.stdout.trim().split("\n").some((url) => !githubRemote(url, config.releaseRepo))) {
    throw new Error("origin 的 pushurl 指向别处，没有推送或修改版本。");
  }
  const path = join(cwd, VERSION_FILE);
  const original = readFileSync(path, "utf8");
  const currentVersion = sourceVersion(original);
  if (compareVersions(version, currentVersion) < 0) throw new Error(`不能把源码版本从 ${currentVersion} 倒退到 ${version}`);
  if (!github) {
    const auth = resolveToken();
    if (!auth) throw new Error("没有 GitHub 凭证：设置 GH_TOKEN，或登录 gh；本地凭证需要 navi 的 Actions 读写权限。");
    github = new GitHub(auth.token);
  }
  const repo = (await github.call("GET", `/repos/${config.releaseRepo}`)).json;
  if (repo.default_branch !== "main") throw new Error("发布仓库默认分支不是 main，停止发布。");
  const workflow = (await github.call("GET", `/repos/${config.releaseRepo}/actions/workflows/${WORKFLOW}`)).json;
  if (workflow.state !== "active") throw new Error("Mac 发布工作流未启用：先将工作流合入 main 并启用 Actions。");
  await previousRun(github, config.releaseRepo, version, git(cwd, ["rev-parse", "HEAD"]));
  const feed = await github.readFile(config.feedRepo, config.appcastPath, config.feedBranch);
  const latest = itemDetails(latestItem(feed?.text));
  if (latest?.shortVersion && compareVersions(version, latest.shortVersion) < 0) {
    throw new Error(`更新源已经是 ${latest.shortVersion}，不能发布更旧的 ${version}`);
  }
  say("▶ 核对 origin/main（不自动合并、不强推）");
  git(cwd, ["fetch", "--no-tags", "origin", "main"]);
  const remote = git(cwd, ["rev-parse", "FETCH_HEAD"]);
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", remote, "HEAD"], { cwd });
  if (ancestor.status !== 0) throw new Error("远端 main 有本地尚未包含的提交：先自行同步、处理分叉，再发布。没有修改版本或推送。");
  const head = git(cwd, ["rev-parse", "HEAD"]);
  if (latest?.shortVersion === version && latest.commit && !head.startsWith(latest.commit)) {
    throw new Error(`${version} 已从另一个提交发布；改用新的版本号。没有修改版本或推送。`);
  }
  if (git(cwd, ["status", "--porcelain"]) || readFileSync(path, "utf8") !== original) {
    throw new Error("预检期间工作区被别处修改了，停止发布。");
  }
  if (currentVersion !== version) {
    const next = original.replace(/^VERSION="[^"]+"$/m, `VERSION="${version}"`);
    writeFileSync(path, next);
    try {
      git(cwd, ["commit", "--only", "-m", `chore(mac): 版本号 ${version}`, "--", VERSION_FILE]);
    } catch (error) {
      if (git(cwd, ["rev-parse", "HEAD"]) === head && readFileSync(path, "utf8") === next) writeFileSync(path, original);
      throw error;
    }
  }
  const commit = git(cwd, ["rev-parse", "HEAD"]);
  if (git(cwd, ["status", "--porcelain"])) throw new Error("提交期间出现额外改动：版本提交保留，没有推送；检查工作区后重试。");
  say(`▶ 推送 main：${commit}`);
  git(cwd, ["push", "origin", `${commit}:refs/heads/main`]);
  const existing = await previousRun(github, config.releaseRepo, version, commit);
  if (existing) {
    if (existing.status === "completed" && existing.conclusion !== "success") {
      await github.call("POST", `/repos/${config.releaseRepo}/actions/runs/${existing.id}/rerun`, { body: {} });
      say("▶ 重跑原工作流，沿用已保存的构建产物");
    }
    say(`${existing.conclusion === "success" ? "✓ 已成功发布" : "✓ 已有发布任务"}：${existing.html_url}`);
    say(`Mac 下载页：${downloadPage(config)}`);
    return existing;
  }
  if (latest?.shortVersion === version) {
    say(`✓ 这一版已在更新源中：${downloadPage(config)}（没有重新发包）`);
    return null;
  }
  let run;
  try {
    run = (await github.call("POST", `/repos/${config.releaseRepo}/actions/workflows/${WORKFLOW}/dispatches`, {
      body: { ref: "main", inputs: { version, source_sha: commit, publish: "true" } },
      headers: { "x-github-api-version": "2026-03-10" },
    })).json;
  } catch (error) {
    throw new Error(`代码已推送（${commit}），但云端触发未确认：${error.message}\n检查 Actions 写权限后，重新执行同一命令；不会再创建版本提交。`);
  }
  const url = run?.html_url || `https://github.com/${config.releaseRepo}/actions/workflows/${WORKFLOW}`;
  say(`✓ 云端已接单：${url}`);
  say("可以退出终端或关电脑；这不是发布完成通知，构建与发布结果以 Actions 为准。");
  return run;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--help") {
    console.log("用法：npm run release:mac -- 0.3.2\n从干净的 main 自动提交版本、push，并触发云端发布。\n本机备用：npm run release:mac:local（选项见 desktop/macos/README.md）");
  } else if (process.argv.length !== 3) {
    console.error("用法：npm run release:mac -- 0.3.2（本机发布与密钥管理改用 release:mac:local）");
    process.exitCode = 1;
  } else {
    releaseCloud(process.argv[2]).catch((error) => { console.error(`✕ ${error.message}`); process.exitCode = 1; });
  }
}

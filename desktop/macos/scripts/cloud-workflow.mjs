import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions } from "./appcast.mjs";
import { appDigest, appInfo, packApp } from "./release-artifacts.mjs";
import { GitHub } from "./github.mjs";
import { assertVersion, itemDetails, latestItem, nextBuildNumber, readConfig, runName, sourceVersion } from "./release-state.mjs";
import { architectureConfig, assertArchitecture, distributionName, recoveryName } from "./architecture.mjs";
import { verifyNativeArchitecture } from "./smoke-distribution.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MAC = join(ROOT, "desktop/macos");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args[0]} 失败（${result.status ?? result.signal}）\n${result.stderr ?? ""}${result.stdout ?? ""}`);
  return result.stdout?.trim();
}

export function workflowRequest(env) {
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch", "只接受显式 workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main", "只允许从 main 运行发布工作流");
  assert.match(env.NAVI_MAC_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/, "需要完整源码提交 SHA");
  assert.match(env.GITHUB_RUN_ID ?? "", /^\d+$/, "需要工作流运行 ID");
  assert.match(env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/, "需要工作流尝试编号");
  assert.ok(["true", "false"].includes(env.NAVI_MAC_PUBLISH), "publish 只能是 true 或 false");
  return { version: assertVersion(env.NAVI_MAC_VERSION), source: env.NAVI_MAC_SOURCE_SHA,
    architecture: assertArchitecture(env.NAVI_MAC_ARCH || "arm64"), runId: env.GITHUB_RUN_ID, publish: env.NAVI_MAC_PUBLISH === "true" };
}

export async function prepareWorkflow({ env = process.env, root = ROOT, github, publicGithub } = {}) {
  const request = workflowRequest(env);
  const config = architectureConfig(readConfig(join(root, "desktop/macos/release.json")), request.architecture);
  assert.equal(env.GITHUB_REPOSITORY, config.releaseRepo, "工作流仓库与发版配置不同");
  assert.equal(run("git", ["merge-base", "--is-ancestor", request.source, "origin/main"], { cwd: root }), "");
  const buildScript = run("git", ["show", `${request.source}:desktop/macos/build.sh`], { cwd: root });
  assert.equal(sourceVersion(buildScript), request.version, "源码里的版本与发布参数不同");
  github ??= new GitHub(env.GH_TOKEN);
  publicGithub ??= new GitHub(null);
  const base = `/repos/${config.releaseRepo}/actions/runs/${request.runId}`;
  const metadata = (await github.call("GET", base)).json;
  assert.equal(metadata.event, "workflow_dispatch");
  assert.equal(metadata.head_branch, "main");
  assert.equal(metadata.display_title, runName(request.version, request.source, request.publish), "工作流名称与发布参数不符");
  const artifacts = (await github.call("GET", `${base}/artifacts?per_page=100`)).json.artifacts ?? [];
  const artifact = artifacts.find((entry) => entry.name === recoveryName(request.runId, request.architecture))
    ?? (request.architecture === "arm64" ? artifacts.find((entry) => entry.name === `mac-release-${request.runId}`) : null);
  if (artifact?.expired) throw new Error("原始恢复产物已经过期，停止发布；请发一个新版本，不能同号覆盖或重封旧包。");
  const feed = await publicGithub.readFile(config.feedRepo, config.appcastPath, config.feedBranch);
  const latest = itemDetails(latestItem(feed?.text));
  if (!artifact && latest?.shortVersion && compareVersions(request.version, latest.shortVersion) <= 0 && request.publish) {
    throw new Error(`更新源已经是 ${latest.shortVersion}：补收尾请重跑保留原始产物的工作流，否则使用新版本。`);
  }
  if (!artifact && Number(env.GITHUB_RUN_ATTEMPT) > 1) {
    for (let page = 1; ; page++) {
      const releases = (await github.call("GET", `/repos/${config.releaseRepo}/releases?per_page=100&page=${page}`)).json;
      if (releases.some((entry) => entry.tag_name.startsWith(`${config.tagPrefix}${request.version}-`))) {
        throw new Error("已存在这一版的 Release，但没有原始恢复产物；停止重封，改发新版本。");
      }
      if (releases.length < 100) break;
    }
  }
  request.buildNumber = artifact ? null : nextBuildNumber(latest?.version, new Date(metadata.created_at));
  const directory = join(env.RUNNER_TEMP, "navi-mac-release");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "request.json"), `${JSON.stringify(request, null, 2)}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `restore=${artifact ? "true" : "false"}\nartifact_id=${artifact?.id ?? ""}\n`);
  return request;
}

export function verifyBundle(directory, expected) {
  const payload = join(directory, "payload");
  const manifest = JSON.parse(readFileSync(join(payload, "manifest.json"), "utf8"));
  for (const field of ["version", "source", "runId", "publish"]) assert.equal(manifest[field], expected[field], `恢复产物 ${field} 不符`);
  const architecture = assertArchitecture(manifest.architecture ?? "arm64");
  assert.equal(architecture, expected.architecture ?? "arm64", "恢复产物 architecture 不符");
  if (expected.buildNumber) assert.equal(manifest.buildNumber, expected.buildNumber, "恢复产物 buildNumber 不符");
  assert.match(manifest.buildNumber, /^\d{8}\.\d{6,}$/);
  const app = join(payload, "Navi.app");
  const info = appInfo(app);
  assert.equal(info.CFBundleShortVersionString, manifest.version);
  assert.equal(info.CFBundleVersion, manifest.buildNumber);
  assert.equal(info.NaviArchitecture ?? "arm64", architecture, "app 架构与恢复清单不符");
  assert.ok(manifest.source.startsWith(info.NaviSourceCommit) && /^[a-f0-9]{7,40}$/.test(info.NaviSourceCommit));
  assert.equal(appDigest(app), manifest.appDigest, "app 内容与恢复清单不符");
  assert.match(manifest.tag, /^[\w.-]+$/);
  const name = distributionName(manifest.version, manifest.buildNumber, architecture);
  const dmg = join(payload, "artifacts", manifest.tag, name);
  assert.equal(sha256(dmg), manifest.dmgSha256, "dmg 与保存的原包不同");
  assert.equal(readFileSync(`${dmg}.source`, "utf8").trim(), manifest.appDigest);
  return { manifest, app, dmg, artifacts: join(payload, "artifacts") };
}

export function buildBundle(directory, request, { root = ROOT, build = true } = {}) {
  const config = architectureConfig(readConfig(join(root, "desktop/macos/release.json")), request.architecture ?? "arm64");
  assert.ok(request.buildNumber, "首次构建必须已经分配构建号");
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: root }), request.source, "未检出要求的源码提交");
  assert.equal(sourceVersion(readFileSync(join(root, "desktop/macos/build.sh"), "utf8")), request.version);
  if (build) run("bash", [join(root, "desktop/macos/build.sh")], {
    cwd: root, stdio: "inherit", env: { ...process.env, NAVI_MAC_BUILD_NUMBER: request.buildNumber, NAVI_MAC_ARCH: config.architecture },
  });
  const payload = join(directory, "payload");
  if (existsSync(payload)) throw new Error("恢复产物目录已存在，不能覆盖后重新封包");
  mkdirSync(payload, { recursive: true });
  const app = join(payload, "Navi.app");
  cpSync(join(root, "desktop/macos/build/Navi.app"), app, { recursive: true, verbatimSymlinks: true });
  const tag = `${config.tagPrefix}${request.version}-${request.buildNumber}`;
  const dmg = packApp(app, join(payload, "artifacts", tag), distributionName(request.version, request.buildNumber, config.architecture));
  const manifest = { ...request, tag, appDigest: appDigest(app), dmgSha256: sha256(dmg) };
  writeFileSync(join(payload, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  verifyBundle(directory, request);
  run("tar", ["-cpf", join(directory, "bundle.tar"), "-C", directory, "payload"]);
  return manifest;
}

export function restoreBundle(directory, request) {
  if (existsSync(join(directory, "payload"))) throw new Error("恢复目录已存在，不覆盖现场");
  run("tar", ["-xpf", join(directory, "bundle.tar"), "-C", directory]);
  return verifyBundle(directory, request);
}

export function verifyDistribution(directory, request) {
  const bundle = verifyBundle(directory, request);
  run("codesign", ["--verify", "--deep", "--strict", bundle.app], { stdio: "inherit" });
  run("hdiutil", ["verify", bundle.dmg], { stdio: "inherit" });
  verifyNativeArchitecture(bundle.app, request.architecture ?? "arm64");
  return bundle;
}

export function withSigningKey(env, operation) {
  if (!env.GH_TOKEN?.trim()) throw new Error("缺少 MAC_RELEASE_TOKEN Secret");
  if (!env.MAC_SPARKLE_PRIVATE_KEY?.trim()) throw new Error("缺少 MAC_SPARKLE_PRIVATE_KEY Secret");
  const keyDirectory = join(env.RUNNER_TEMP, "navi-mac-signing");
  mkdirSync(keyDirectory, { recursive: true, mode: 0o700 });
  const key = join(keyDirectory, "sparkle.key");
  try {
    writeFileSync(key, env.MAC_SPARKLE_PRIVATE_KEY.trim(), { mode: 0o600, flag: "wx" });
    const childEnv = { ...env };
    delete childEnv.MAC_SPARKLE_PRIVATE_KEY;
    return operation(key, childEnv);
  } finally {
    rmSync(keyDirectory, { recursive: true, force: true });
  }
}

export function publishBundle(directory, request, { env = process.env } = {}) {
  assert.equal(request.publish, true, "演练不执行公开发布");
  const bundle = verifyDistribution(directory, request);
  return withSigningKey(env, (key, childEnv) => run(process.execPath,
    [join(MAC, "scripts/release.mjs"), "--app", bundle.app, "--ed-key-file", key], {
      env: { ...childEnv, NAVI_MAC_RELEASE_ARTIFACTS: bundle.artifacts }, stdio: "inherit",
    }));
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") return prepareWorkflow();
  const directory = join(process.env.RUNNER_TEMP, "navi-mac-release");
  const request = JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
  if (command === "build") return buildBundle(directory, request);
  if (command === "restore") return restoreBundle(directory, request);
  if (command === "verify") return verifyDistribution(directory, request);
  if (command === "publish") return publishBundle(directory, request);
  throw new Error("需要 validate / build / restore / verify / publish 子命令");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`✕ ${error.message}`); process.exitCode = 1; });
}

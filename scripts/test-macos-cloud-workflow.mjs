import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAppcast, renderItem } from "../desktop/macos/scripts/appcast.mjs";
import { buildBundle, prepareWorkflow, restoreBundle, verifyBundle, withSigningKey, workflowRequest } from "../desktop/macos/scripts/cloud-workflow.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS cloud artifact regression");
  process.exit(0);
}

const temporary = mkdtempSync(join(tmpdir(), "navi-cloud-workflow-"));
const root = join(temporary, "source");
const runner = join(temporary, "runner");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const config = { releaseRepo: "o/app", feedRepo: "o/feed", feedBranch: "main", appcastPath: "navi/mac/appcast.xml", tagPrefix: "navi-mac-v" };
function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: cleanEnv });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  mkdirSync(join(root, "desktop/macos"), { recursive: true });
  mkdirSync(runner);
  writeFileSync(join(root, "desktop/macos/build.sh"), 'VERSION="0.3.2"\n');
  writeFileSync(join(root, "desktop/macos/release.json"), JSON.stringify(config));
  git("init", "-qb", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.hooksPath", "/dev/null");
  git("add", ".");
  git("commit", "-qm", "source");
  const source = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", source);
  const env = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "o/app",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", NAVI_MAC_VERSION: "0.3.2", NAVI_MAC_SOURCE_SHA: source,
    NAVI_MAC_PUBLISH: "true", RUNNER_TEMP: runner, GITHUB_OUTPUT: join(runner, "outputs") };
  for (const changed of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/heads/feature" },
    { NAVI_MAC_SOURCE_SHA: "main; touch /tmp/never" }, { NAVI_MAC_VERSION: "0.3.2-beta" }, { NAVI_MAC_PUBLISH: "yes" }]) {
    assert.throws(() => workflowRequest({ ...env, ...changed }));
  }
  const state = { artifacts: [], releases: [], calls: [], feed: renderAppcast({ title: "test", link: "https://github.com/o/app", items: [renderItem({
    version: "20261120.000001", shortVersion: "0.3.1", url: "https://example.invalid/old.dmg", length: 1, signature: "unused", pubDate: new Date(),
  })] }) };
  const github = {
    async call(method, path) {
      state.calls.push(`${method} ${path}`);
      if (path.includes("/artifacts")) return { json: { artifacts: state.artifacts } };
      if (path.includes("/releases")) {
        const page = Number(new URL(path, "https://api.github.com").searchParams.get("page") ?? 1);
        return { json: state.releases.slice((page - 1) * 100, page * 100) };
      }
      return { json: { event: "workflow_dispatch", head_branch: "main", display_title: `mac 0.3.2 ${source} publish`, created_at: "2026-11-21T04:05:06Z" } };
    },
    async readFile() { return { text: state.feed }; },
  };
  const request = await prepareWorkflow({ env, root, github, publicGithub: github });
  const directory = join(runner, "navi-mac-release");
  assert.equal(request.buildNumber, "20261121.040506");
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "restore=false\nartifact_id=\n");
  await assert.rejects(prepareWorkflow({ env: { ...env, NAVI_MAC_VERSION: "0.3.3" }, root, github, publicGithub: github }), /版本与发布参数不同/);
  await assert.rejects(prepareWorkflow({ env: { ...env, NAVI_MAC_SOURCE_SHA: "f".repeat(40) }, root, github, publicGithub: github }), /git merge-base 失败/);

  const app = join(root, "desktop/macos/build/Navi.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Resources"));
  const fields = { CFBundleShortVersionString: request.version, CFBundleVersion: request.buildNumber, NaviSourceCommit: source.slice(0, 9) };
  writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(fields)
    .map(([name, value]) => `<key>${name}</key><string>${value}</string>`).join("")}</dict></plist>`);
  writeFileSync(join(app, "Contents/MacOS/Navi"), "fake app\n", { mode: 0o755 });
  writeFileSync(join(app, "Contents/Resources/data"), "immutable resource");
  symlinkSync("data", join(app, "Contents/Resources/alias"));
  const manifest = buildBundle(directory, request, { root, build: false });
  assert.equal(manifest.buildNumber, request.buildNumber);
  assert.equal(readlinkSync(join(directory, "payload/Navi.app/Contents/Resources/alias")), "data");
  assert.ok(statSync(join(directory, "payload/Navi.app/Contents/MacOS/Navi")).mode & 0o111);
  const first = verifyBundle(directory, request);
  const original = readFileSync(first.dmg);
  const changed = Buffer.from(original);
  changed[changed.length - 1] ^= 1;
  writeFileSync(first.dmg, changed);
  assert.throws(() => verifyBundle(directory, request), /dmg 与保存的原包不同/);
  writeFileSync(first.dmg, original);
  assert.throws(() => verifyBundle(directory, { ...request, source: "e".repeat(40) }), /source 不符/);
  assert.throws(() => verifyBundle(directory, { ...request, runId: "999" }), /runId 不符/);

  state.artifacts = [{ name: "mac-release-123", id: 42, expired: false }];
  const retry = await prepareWorkflow({ env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, root, github, publicGithub: github });
  assert.equal(retry.buildNumber, null, "a retry must restore the original build number instead of allocating another");
  assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /restore=true\nartifact_id=42/);
  rmSync(join(directory, "payload"), { recursive: true });
  const restored = restoreBundle(directory, retry);
  assert.equal(restored.manifest.buildNumber, manifest.buildNumber);
  assert.deepEqual(readFileSync(restored.dmg), original, "a retry uses the exact original dmg bytes");
  assert.equal(readlinkSync(join(restored.app, "Contents/Resources/alias")), "data");
  assert.throws(() => buildBundle(directory, request, { root, build: false }), /不能覆盖后重新封包/);
  state.artifacts[0].expired = true;
  await assert.rejects(prepareWorkflow({ env, root, github, publicGithub: github }), /恢复产物已经过期/);
  state.artifacts = [];
  state.releases = [{ tag_name: "navi-mac-v0.3.2-20261121.040506" }];
  await assert.rejects(prepareWorkflow({ env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, root, github, publicGithub: github }), /没有原始恢复产物/);
  state.releases.unshift(...Array.from({ length: 100 }, (_, index) => ({ tag_name: `web-v${index}` })));
  await assert.rejects(prepareWorkflow({ env: { ...env, GITHUB_RUN_ATTEMPT: "2" }, root, github, publicGithub: github }), /没有原始恢复产物/);
  assert.ok(state.calls.some((call) => call.endsWith("/releases?per_page=100&page=2")));
  console.log("PASS: cloud inputs and pinned source are checked; artifact restore preserves app symlinks/modes, build number and exact dmg; tampering/expired recovery is rejected");

  const signing = { RUNNER_TEMP: runner, GH_TOKEN: "only-publish", MAC_SPARKLE_PRIVATE_KEY: "secret-key-material" };
  assert.throws(() => withSigningKey({ ...signing, GH_TOKEN: "" }, () => {}), /MAC_RELEASE_TOKEN/);
  let keyPath;
  assert.throws(() => withSigningKey(signing, (path, childEnv) => {
    keyPath = path;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), signing.MAC_SPARKLE_PRIVATE_KEY);
    assert.equal(childEnv.MAC_SPARKLE_PRIVATE_KEY, undefined);
    assert.equal(childEnv.GH_TOKEN, signing.GH_TOKEN);
    throw new Error("signing failed");
  }), /signing failed/);
  assert.equal(existsSync(keyPath), false, "failed signing always removes the private key");
  assert.equal(readFileSync(join(directory, "bundle.tar")).includes(Buffer.from(signing.MAC_SPARKLE_PRIVATE_KEY)), false);
  const project = fileURLToPath(new URL("..", import.meta.url));
  const workflow = readFileSync(join(project, ".github/workflows/release-mac.yml"), "utf8");
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /retention-days: 1/);
  assert.match(workflow, /node-version: '26\.13\.1'\n          package-manager-cache: false/);
  for (const block of workflow.matchAll(/        run: \|\n((?:          .*(?:\n|$))*)/g)) {
    assert.doesNotMatch(block[1], /package-manager-cache:/);
    const shell = spawnSync("bash", ["-n"], { input: block[1], encoding: "utf8" });
    assert.equal(shell.status, 0, shell.stderr);
  }
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|pull_request_target):/m);
  assert.ok(workflow.indexOf("Save original distribution") < workflow.indexOf("MAC_SPARKLE_PRIVATE_KEY: ${{ secrets."));
  assert.equal([...workflow.matchAll(/uses: actions\/[^@]+@([a-f0-9]{40})/g)].length, 5);
  console.log("PASS: signing key is private, excluded from child environment/artifacts, and cleaned on failure; workflow pins actions and saves recovery before injecting secrets");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

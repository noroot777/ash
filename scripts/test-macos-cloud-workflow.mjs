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
const config = { releaseRepo: "o/app", feedRepo: "o/feed", feedBranch: "main", appcastPath: "navi/mac/appcast.xml", tagPrefix: "navi-mac-v",
  architectures: { x64: { appcastPath: "navi/mac/appcast-intel.xml", tagPrefix: "navi-mac-intel-v", legacyAppcastPath: null } } };
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
    { NAVI_MAC_SOURCE_SHA: "main; touch /tmp/never" }, { NAVI_MAC_VERSION: "0.3.2-beta" }, { NAVI_MAC_PUBLISH: "yes" }, { NAVI_MAC_ARCH: "riscv64" }]) {
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
  const originalFetch = globalThis.fetch;
  let feedRequests = 0;
  globalThis.fetch = async (url, options) => {
    feedRequests++;
    assert.equal(url, "https://raw.githubusercontent.com/o/feed/main/navi/mac/appcast.xml");
    assert.equal(options.headers?.authorization, undefined, "public feed reads never receive release credentials");
    return new Response(state.feed);
  };
  try {
    assert.equal((await prepareWorkflow({ env, root, github })).buildNumber, request.buildNumber);
    assert.equal(feedRequests, 1, "a first build reads the public raw feed, not the unauthenticated Contents API");
    state.artifacts = [{ name: "mac-release-123-arm64", id: 43, expired: false }];
    globalThis.fetch = () => { throw new Error("API rate limit exceeded for shared runner IP"); };
    const recovery = await prepareWorkflow({ env, root, github });
    assert.equal(recovery.buildNumber, null, "publish recovery does not need the feed to allocate a build number");
    assert.match(readFileSync(env.GITHUB_OUTPUT, "utf8"), /restore=true\nartifact_id=43/);
  } finally {
    globalThis.fetch = originalFetch;
    state.artifacts = [];
  }
  console.log("PASS: fresh builds read credential-free raw feeds; recovery succeeds without any feed request even when shared IPs are rate limited");
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
  assert.throws(() => verifyBundle(directory, { ...request, architecture: "x64" }), /architecture 不符/);
  assert.throws(() => verifyBundle(directory, { ...request, buildNumber: "20261121.040507" }), /buildNumber 不符/);

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

  state.feed = "";
  state.releases = [];
  state.artifacts = [{ name: "mac-release-123-arm64", id: 43, expired: false }];
  const intelEnv = { ...env, NAVI_MAC_ARCH: "x64", GITHUB_OUTPUT: join(runner, "intel-outputs") };
  const intelRequest = await prepareWorkflow({ env: intelEnv, root, github, publicGithub: github });
  assert.equal(intelRequest.architecture, "x64");
  assert.equal(intelRequest.buildNumber, "20261121.040506", "an ARM artifact cannot be restored for Intel");
  const intelPlist = readFileSync(join(app, "Contents/Info.plist"), "utf8").replace("</dict>", "<key>NaviArchitecture</key><string>x64</string></dict>");
  writeFileSync(join(app, "Contents/Info.plist"), intelPlist);
  const intelDirectory = join(runner, "intel-bundle");
  const intelManifest = buildBundle(intelDirectory, intelRequest, { root, build: false });
  assert.equal(intelManifest.tag, "navi-mac-intel-v0.3.2-20261121.040506");
  const intelBundle = verifyBundle(intelDirectory, intelRequest);
  assert.ok(intelBundle.dmg.endsWith("Navi-0.3.2-20261121.040506-intel.dmg"));
  state.artifacts.push({ name: "mac-release-123-x64", id: 44, expired: false });
  const intelRetry = await prepareWorkflow({ env: { ...intelEnv, GITHUB_RUN_ATTEMPT: "2" }, root, github, publicGithub: github });
  assert.equal(intelRetry.buildNumber, null);
  assert.match(readFileSync(intelEnv.GITHUB_OUTPUT, "utf8"), /restore=true\nartifact_id=44/);
  rmSync(join(intelDirectory, "payload"), { recursive: true });
  assert.equal(restoreBundle(intelDirectory, intelRetry).manifest.architecture, "x64");
  assert.throws(() => verifyBundle(intelDirectory, request), /architecture 不符/);
  console.log("PASS: Intel artifacts, app metadata, dmg names and release tags are isolated from ARM; recovery never crosses architectures");

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
  assert.match(workflow, /architecture: arm64\n            runner: macos-15\n/);
  assert.match(workflow, /architecture: x64\n            runner: macos-15-intel\n/);
  assert.match(workflow, /runs-on: \$\{\{ matrix.runner \}\}/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /name: mac-release-\$\{\{ github.run_id \}\}-\$\{\{ matrix.architecture \}\}/);
  const buildJob = workflow.split(/^  publish:\n/m)[0];
  assert.doesNotMatch(buildJob, /MAC_SPARKLE_PRIVATE_KEY: \$\{\{ secrets\./);
  assert.match(buildJob, /smoke-distribution\.mjs/);
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
  assert.equal([...workflow.matchAll(/uses: actions\/[^@]+@([a-f0-9]{40})/g)].length, 9);
  console.log("PASS: signing key is private, excluded from child environment/artifacts, and cleaned on failure; workflow pins actions and saves recovery before injecting secrets");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

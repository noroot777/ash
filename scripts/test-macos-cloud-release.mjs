import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseCloud } from "../desktop/macos/scripts/cloud-release.mjs";
import { GitHub } from "../desktop/macos/scripts/github.mjs";
import { assertVersion, nextBuildNumber, sourceVersion } from "../desktop/macos/scripts/release-state.mjs";

const temporary = mkdtempSync(join(tmpdir(), "navi-cloud-release-"));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const config = { releaseRepo: "o/app", feedRepo: "o/feed", feedBranch: "main", appcastPath: "navi/mac/appcast.xml", tagPrefix: "navi-mac-v" };
const state = { active: true, runs: [], calls: [], dispatches: 0, dispatchStatus: 200, denyRuns: false, feeds: {} };
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer test-token");
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : null;
    const url = new URL(request.url, "http://localhost");
    const path = url.pathname;
    state.calls.push(`${request.method} ${path}`);
    const send = (status, data) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
    if (path === "/repos/o/app") return send(200, { default_branch: "main" });
    if (path === "/repos/o/app/actions/workflows/release-mac.yml") return send(200, { state: state.active ? "active" : "disabled_manually" });
    if (path === "/repos/o/app/actions/workflows/release-mac.yml/runs") {
      const page = Number(url.searchParams.get("page") ?? 1);
      return send(state.denyRuns ? 403 : 200, { workflow_runs: state.runs.slice((page - 1) * 100, page * 100) });
    }
    if (path.startsWith("/repos/o/feed/contents/")) {
      const feed = state.feeds[path.slice("/repos/o/feed/contents/".length)];
      return feed ? send(200, { content: Buffer.from(feed).toString("base64"), encoding: "base64", sha: "feed-sha" }) : send(404, {});
    }
    if (path.endsWith("/dispatches")) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers["x-github-api-version"], "2026-03-10");
      assert.equal(body.ref, "main");
      assert.equal(body.inputs.publish, "true");
      if (state.dispatchStatus !== 200) return send(state.dispatchStatus, { message: "Actions write denied" });
      const id = ++state.dispatches;
      const run = { id, display_title: `mac ${body.inputs.version} ${body.inputs.source_sha} publish`, status: "queued", conclusion: null,
        html_url: `https://github.com/o/app/actions/runs/${id}` };
      state.runs.unshift(run);
      return send(200, { workflow_run_id: id, html_url: run.html_url });
    }
    const rerun = path.match(/^\/repos\/o\/app\/actions\/runs\/(\d+)\/rerun$/);
    if (rerun) {
      state.runs.find((entry) => entry.id === Number(rerun[1])).status = "queued";
      return send(201, {});
    }
    send(404, {});
  } catch (error) {
    response.writeHead(500);
    response.end(error.stack);
  }
});

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function fixture(name, releaseConfig = config) {
  const directory = join(temporary, name);
  const bare = join(temporary, `${name}.git`);
  mkdirSync(join(directory, "desktop/macos"), { recursive: true });
  git(temporary, "init", "--bare", "-q", bare);
  git(directory, "init", "-q", "-b", "main");
  git(directory, "config", "user.name", "release test");
  git(directory, "config", "user.email", "release@example.invalid");
  git(directory, "config", "core.hooksPath", "/dev/null");
  git(directory, "config", `url.file://${bare}.insteadOf`, "https://github.com/o/app.git");
  git(directory, "remote", "add", "origin", "https://github.com/o/app.git");
  writeFileSync(join(directory, "desktop/macos/build.sh"), '#!/bin/bash\nVERSION="0.3.1"\n');
  writeFileSync(join(directory, "desktop/macos/release.json"), JSON.stringify(releaseConfig));
  writeFileSync(join(directory, "business.txt"), "already reviewed\n");
  git(directory, "add", ".");
  git(directory, "commit", "-qm", "initial");
  git(directory, "push", "-q", "origin", "HEAD:main");
  return { directory, bare, build: join(directory, "desktop/macos/build.sh"), head: () => git(directory, "rev-parse", "HEAD") };
}

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const github = new GitHub("test-token", { api: `http://127.0.0.1:${server.address().port}` });
  const output = [];
  const publish = (item, version = "0.3.2") => releaseCloud(version, { cwd: item.directory, github, say: (line) => output.push(line) });
  for (const version of ["", "v0.3.2", "0.3", "01.3.2", "0.3.2-beta", "0.3.2\n", "1.2.9007199254740992"]) {
    assert.throws(() => assertVersion(version), /版本号/);
  }
  assert.equal(nextBuildNumber(null, new Date("2026-11-21T04:05:06Z")), "20261121.040506");
  assert.equal(nextBuildNumber("20261121.040506", new Date("2026-11-21T04:05:06Z")), "20261121.040507");
  assert.equal(nextBuildNumber("20261122.000099", new Date("2026-11-21T04:05:06Z")), "20261122.000100");
  assert.throws(() => sourceVersion('VERSION="0.3.1"\nVERSION="0.3.2"'), /唯一/);

  const happy = fixture("happy");
  const initial = happy.head();
  writeFileSync(join(happy.directory, "uncommitted.txt"), "not for release");
  await assert.rejects(publish(happy), /没提交/);
  rmSync(join(happy.directory, "uncommitted.txt"));
  git(happy.directory, "switch", "-qc", "feature");
  await assert.rejects(publish(happy), /本地 main/);
  git(happy.directory, "switch", "-q", "main");
  await assert.rejects(publish(happy, "0.3.0"), /倒退/);
  state.active = false;
  await assert.rejects(publish(happy), /工作流未启用/);
  state.active = true;
  state.denyRuns = true;
  await assert.rejects(publish(happy), /HTTP 403/);
  state.denyRuns = false;
  assert.equal(happy.head(), initial, "preflight failures never create version commits");

  writeFileSync(join(happy.directory, "business.txt"), "a reviewed local commit\n");
  git(happy.directory, "commit", "-qam", "reviewed development");
  await publish(happy);
  const released = happy.head();
  assert.equal(git(happy.directory, "show", "--format=", "--name-only", "HEAD"), "desktop/macos/build.sh");
  assert.equal(git(happy.directory, "log", "-1", "--format=%s"), "chore(mac): 版本号 0.3.2");
  assert.equal(git(happy.directory, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0], released);
  assert.equal(sourceVersion(readFileSync(happy.build, "utf8")), "0.3.2");
  assert.equal(git(happy.directory, "status", "--porcelain"), "");
  assert.ok(state.runs[0].display_title.includes(`${released} publish`));
  await publish(happy);
  assert.equal(happy.head(), released);
  assert.equal(state.dispatches, 1, "an in-flight run is reused");
  state.runs[0].status = "completed";
  state.runs[0].conclusion = "failure";
  await publish(happy);
  assert.ok(state.calls.includes("POST /repos/o/app/actions/runs/1/rerun"));
  state.runs[0].status = "completed";
  state.runs[0].conclusion = "success";
  await publish(happy);
  assert.equal(state.dispatches, 1, "a successful version is never dispatched again");
  const unrelatedRuns = Array.from({ length: 100 }, (_, index) => ({ display_title: `unrelated build ${index}` }));
  state.runs.unshift(...unrelatedRuns);
  await publish(happy);
  assert.equal(state.dispatches, 1, "deduplication also checks older pages");
  state.runs.splice(0, unrelatedRuns.length);

  state.dispatchStatus = 403;
  await assert.rejects(publish(happy, "0.3.3"), /代码已推送[\s\S]*Actions write denied/);
  const afterFailure = happy.head();
  state.dispatchStatus = 200;
  await publish(happy, "0.3.3");
  assert.equal(happy.head(), afterFailure, "retry after dispatch failure creates no duplicate version commit");
  assert.equal(state.dispatches, 2);
  assert.ok(output.some((line) => line.includes("https://github.com/o/app/actions/runs/")));
  console.log("PASS: dirty/non-main/version/auth checks, version-only commit, normal push, exact SHA dispatch, deduplication and rerun");

  const ahead = fixture("ahead");
  const tree = git(ahead.directory, "rev-parse", "HEAD^{tree}");
  const commit = spawnSync("git", ["-c", "user.name=remote", "-c", "user.email=remote@example.invalid", "--git-dir", ahead.bare,
    "commit-tree", tree, "-p", ahead.head()], { input: "remote change\n", encoding: "utf8", env: cleanEnv });
  assert.equal(commit.status, 0, commit.stderr);
  git(temporary, "--git-dir", ahead.bare, "update-ref", "refs/heads/main", commit.stdout.trim());
  await assert.rejects(publish(ahead), /远端 main 有本地尚未包含/);
  assert.equal(sourceVersion(readFileSync(ahead.build, "utf8")), "0.3.1");

  const rejected = fixture("rejected");
  writeFileSync(join(rejected.bare, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const count = state.dispatches;
  await assert.rejects(publish(rejected), /git push 失败/);
  assert.equal(state.dispatches, count);
  assert.equal(sourceVersion(readFileSync(rejected.build, "utf8")), "0.3.2", "a failed push preserves the local version commit");

  const hooks = fixture("hooks");
  mkdirSync(join(hooks.directory, "hooks"));
  writeFileSync(join(hooks.directory, "hooks/pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(hooks.directory, "config", "core.hooksPath", "hooks");
  git(hooks.directory, "add", "hooks");
  git(hooks.directory, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "add failing hook");
  await assert.rejects(publish(hooks), /git commit 失败/);
  assert.equal(sourceVersion(readFileSync(hooks.build, "utf8")), "0.3.1");
  assert.equal(git(hooks.directory, "status", "--porcelain"), "");
  console.log("PASS: remote-ahead and push rejection never dispatch; commit rejection restores only the version edit");

  const dualConfig = { ...config, architectures: { x64: { appcastPath: "navi/mac/appcast-intel.xml", tagPrefix: "navi-mac-intel-v", legacyAppcastPath: null } } };
  const dual = fixture("dual", dualConfig);
  const feed = (version, commit) => `<rss><channel><item><sparkle:version>20261121.010203</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><navi:commit>${commit}</navi:commit></item></channel></rss>`;
  state.feeds[config.appcastPath] = feed("0.3.0", dual.head());
  state.feeds[dualConfig.architectures.x64.appcastPath] = feed("0.3.3", dual.head());
  const dualHead = dual.head();
  const dualDispatches = state.dispatches;
  await assert.rejects(publish(dual), /更新源已经是 0.3.3/);
  assert.equal(dual.head(), dualHead, "Intel downgrade preflight never changes source version");
  assert.ok(state.calls.includes("GET /repos/o/feed/contents/navi/mac/appcast-intel.xml"));
  state.feeds[dualConfig.architectures.x64.appcastPath] = feed("0.3.1", "f".repeat(40));
  await assert.rejects(publish(dual, "0.3.1"), /已从另一个提交发布/);
  state.feeds[dualConfig.architectures.x64.appcastPath] = feed("0.3.1", dualHead);
  await assert.rejects(publish(dual, "0.3.1"), /只有部分架构已经发布/);
  assert.equal(state.dispatches, dualDispatches, "partial publication without an original run never dispatches new bytes");
  state.feeds[config.appcastPath] = feed("0.3.1", dualHead);
  assert.equal(await publish(dual, "0.3.1"), null);
  assert.equal(state.dispatches, dualDispatches, "both published channels are a no-op even without workflow history");
  delete state.feeds[dualConfig.architectures.x64.appcastPath];
  state.feeds[config.appcastPath] = feed("0.3.0", dualHead);
  await publish(dual);
  assert.equal(state.dispatches, dualDispatches + 1, "a first Intel release can accompany a newer Apple release");
  console.log("PASS: dual-channel preflight, Intel source/downgrade checks, partial publication refusal and first Intel dispatch");
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  rmSync(temporary, { recursive: true, force: true });
}

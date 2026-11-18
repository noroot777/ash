// mac app 改名接班（Ash.app / dev.ash.mac → Navi.app / dev.navi.mac）的定点回归（仅 macOS）。
// 编进驱动的是真的 LegacyIdentity；路径全在临时目录、defaults 全在带 pid 的临时域，日常那一份 app 一概不碰。
//
// 覆盖：设置——旧域每一项抄进新域、改了名的键（AshURL / AshDataDir / 窗口位置）换成新名、新域已有的不盖、只接一次；
// 数据根——全新机器用新目录，升级上来的机器原地用旧目录并记下来（之后新目录被谁建出来也不换成空数据根），
// 演练包标识不认旧的；网页数据——WebKit 与 cookie 目录整份复制（不挪）、写不进去时不留半截且下次再来、
// 只接一次；旧包让位——只认包标识对得上的真目录（软链、别的包不算）、有进程拿着代码锁 / 命令行里带着它
// （更早的无锁版本）时不动、没人用时移到废纸篓并原地留一个指向新包的软链。
// 再用真 WebKit 走一遍：旧身份的空壳 app 往本机页面的 localStorage 和 cookie 里各存一样，新身份的空壳 app
// 走 adoptWebData 之后打开同一个源读得出来；不接班的第三个身份读不到（证明是复制带过去的）。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "macOS-only regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const mac = join(root, "desktop/macos");
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "navi-macos-identity-")));
const driver = join(temporary, "identity-tests");
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const cleanups = [];
const children = new Set();
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

const sources = ["AshConfig", "AshHealth", "LegacyIdentity", "LoginService"].map((name) => join(mac, `Sources/${name}.swift`));
const build = spawnSync("swiftc", ["-swift-version", "5", ...sources, join(mac, "Tests/Identity/main.swift"), "-o", driver], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);

function run(...args) {
  const result = spawnSync(driver, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

function forgetDomain(name) {
  spawnSync("defaults", ["delete", name], { stdio: "ignore" });
  rmSync(join(homedir(), "Library/Preferences", `${name}.plist`), { force: true });
}

/** 一个最小的 .app：Info.plist 里的包标识、要不要带代码锁。 */
function fakeBundle(path, id, { lock = true } = {}) {
  mkdirSync(join(path, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(path, "Contents/Resources/app"), { recursive: true });
  writeFileSync(join(path, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${id}</string>
  <key>CFBundleExecutable</key><string>Ash</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  if (lock) writeFileSync(join(path, "Contents/Resources/app/.in-use"), "");
  return path;
}

function hold(command, args) {
  const child = spawn(command, args, { stdio: "ignore" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

try {
  // ── 设置、数据根、网页数据 ──
  const domain = `dev.navi.identity-test.${process.pid}`;
  cleanups.push(() => ["", ".empty", ".support", ".support.fresh", ".web"].forEach((suffix) => forgetDomain(domain + suffix)));
  assert.equal(run("defaults", domain), "OK defaults");
  console.log("PASS: defaults are adopted once, renamed keys get their new names, nothing the new domain has is overwritten");

  const support = join(temporary, "Application Support");
  mkdirSync(support);
  assert.equal(run("support", support, `${domain}.support`), "OK support");
  console.log("PASS: data root — new place on a fresh machine, the Ash one in place (and pinned) on an upgraded machine, rehearsal ids never adopt it");

  const library = join(temporary, "Library");
  for (const [rel, text] of [
    ["WebKit/old.id/WebsiteData/LocalStorage/origin.sqlite3", "local-storage"],
    ["HTTPStorages/old.id/httpstorages.sqlite", "cookies"],
    ["HTTPStorages/old.id.binarycookies", "binary-cookies"],
  ]) {
    mkdirSync(join(library, rel, ".."), { recursive: true });
    writeFileSync(join(library, rel), text);
  }
  assert.equal(run("webdata", library, `${domain}.web`), "OK webdata");
  console.log("PASS: web data is copied (not moved) once; a failed copy leaves nothing half-done and is retried next launch");

  // ── 旧包让位 ──
  const apps = join(temporary, "Applications");
  const successor = fakeBundle(join(apps, "Navi.app"), "dev.navi.mac");
  const legacy = fakeBundle(join(apps, "Ash.app"), "dev.ash.mac");
  const other = fakeBundle(join(temporary, "elsewhere", "Ash.app"), "com.example.ash");
  run("is-legacy", legacy, "yes");
  run("is-legacy", other, "no");
  run("is-legacy", successor, "no");

  // 旧版服务 / MCP 以共享锁拿着代码锁（shared/src/code-lock.ts）：拿着的时候不动。
  const holder = hold("/usr/bin/lockf", ["-s", join(legacy, "Contents/Resources/app/.in-use"), "/bin/sleep", "60"]);
  await delay(500);
  let outcome = run("retire", legacy, successor);
  assert.match(outcome, /^BUSY .*\.in-use/, outcome);
  assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink(), "a bundle in use stays where it is");
  await stop(holder);
  outcome = run("retire", legacy, successor);
  assert.match(outcome, /^RETIRED \//, outcome);
  const trashed = outcome.slice("RETIRED ".length);
  cleanups.push(() => rmSync(trashed, { recursive: true, force: true }));
  assert.ok(existsSync(join(trashed, "Contents/Info.plist")), "the old bundle went to the Trash, recoverable");
  assert.ok(lstatSync(legacy).isSymbolicLink(), "its old path is now a link …");
  assert.equal(readlinkSync(legacy), successor, "… to the new app, so absolute paths into Ash.app keep working");
  assert.equal(realpathSync(join(legacy, "Contents/Resources/app/.in-use")), realpathSync(join(successor, "Contents/Resources/app/.in-use")));
  run("is-legacy", legacy, "no");
  console.log("PASS: the old bundle waits while its code lock is held, then goes to the Trash and leaves a link to Navi.app behind");

  // 更早的、没有代码锁的旧版：只能按命令行认。
  const lockless = fakeBundle(join(temporary, "Applications-2", "Ash.app"), "dev.ash.mac", { lock: false });
  const runner = hold(process.execPath, ["-e", "setTimeout(() => {}, 60000)", join(lockless, "Contents/Resources/app/server/dist/index.js")]);
  await delay(300);
  outcome = run("retire", lockless, successor);
  assert.match(outcome, /^BUSY .*Ash\.app/, outcome);
  await stop(runner);
  outcome = run("retire", lockless, successor);
  assert.match(outcome, /^RETIRED \//, outcome);
  cleanups.push(() => rmSync(outcome.slice("RETIRED ".length), { recursive: true, force: true }));
  assert.ok(lstatSync(lockless).isSymbolicLink());
  console.log("PASS: a lockless older bundle is recognised as busy by the command lines that mention it");

  // ── 真 WebKit：复制过来的网站数据在新身份下读得出来 ──
  const sparkleFree = ["AshConfig", "AshHealth", "LegacyIdentity", "LoginService"].map((name) => join(mac, `Sources/${name}.swift`));
  const probeBinary = join(temporary, "probe");
  const probeBuild = spawnSync("swiftc", ["-swift-version", "5", "-target", "arm64-apple-macos14.0", "-framework", "AppKit", "-framework", "WebKit",
    ...sparkleFree, join(mac, "Tests/IdentityProbe/main.swift"), "-o", probeBinary], { encoding: "utf8" });
  assert.equal(probeBuild.status, 0, probeBuild.stderr);

  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>probe</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const page = `http://127.0.0.1:${server.address().port}/`;
  const log = join(temporary, "probe.log");
  const ids = { old: `dev.ash.identity-probe.${process.pid}`, next: `dev.navi.identity-probe.${process.pid}`, stranger: `dev.navi.identity-stranger.${process.pid}` };
  cleanups.push(() => {
    for (const id of Object.values(ids)) {
      forgetDomain(id);
      for (const dir of ["Library/Caches", "Library/HTTPStorages", "Library/WebKit"]) rmSync(join(homedir(), dir, id), { recursive: true, force: true });
      rmSync(join(homedir(), "Library/HTTPStorages", `${id}.binarycookies`), { force: true });
    }
  });

  const probeApp = (name, id, mode, legacyId) => {
    const app = join(temporary, "probes", `${name}.app`);
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
    spawnSync("cp", [probeBinary, join(app, "Contents/MacOS/probe")]);
    writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${id}</string>
  <key>CFBundleExecutable</key><string>probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>ProbeLog</key><string>${log}</string>
  <key>ProbeURL</key><string>${page}</string>
  <key>ProbeMode</key><string>${mode}</string>
  ${legacyId ? `<key>LegacyID</key><string>${legacyId}</string>` : ""}
</dict></plist>`);
    assert.equal(spawnSync("codesign", ["--force", "--sign", "-", app]).status, 0);
    cleanups.push(() => spawnSync(lsregister, ["-u", app]));
    return app;
  };
  const launchProbe = async (app) => {
    rmSync(log, { force: true });
    const child = hold(join(app, "Contents/MacOS/probe"), []);
    const deadline = Date.now() + 90_000;
    while (child.exitCode === null && !child.signalCode && Date.now() < deadline) await delay(100);
    await stop(child);
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  };

  let lines = await launchProbe(probeApp("Old", ids.old, "write"));
  assert.deepEqual(lines, ["WRITE written"], lines.join("\n"));
  lines = await launchProbe(probeApp("Stranger", ids.stranger, "read"));
  assert.deepEqual(lines, [`READ ${JSON.stringify({ localStorage: null, cookie: "" })}`], `control: another identity sees nothing\n${lines.join("\n")}`);
  lines = await launchProbe(probeApp("Next", ids.next, "read", ids.old));
  assert.match(lines[0] ?? "", /^COPIED [1-9]/, lines.join("\n"));
  assert.deepEqual(lines.slice(1), [`READ ${JSON.stringify({ localStorage: "kept", cookie: "probe=kept" })}`], lines.join("\n"));
  console.log("PASS: real WebKit — after adoptWebData the new identity reads the old identity's localStorage and cookie for the same origin");
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(temporary, { recursive: true, force: true });
}

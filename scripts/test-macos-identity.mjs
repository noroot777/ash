// mac app 改名接班（Ash.app / dev.ash.mac → Navi.app / dev.navi.mac）的定点回归（仅 macOS）。
// 编进驱动的是真的 LegacyIdentity；路径全在临时目录、defaults 全在带 pid 的临时域，日常那一份 app 一概不碰。
//
// 覆盖：设置——旧域每一项抄进新域、改了名的键（AshURL / AshDataDir / 窗口位置）换成新名、新域已有的不盖、只接一次；
// 数据根——全新机器用新目录，升级上来的机器原地用旧目录并记下来（之后新目录被谁建出来也不换成空数据根），
// 演练包标识不认旧的；网页数据——WebKit 与 cookie 目录整份复制（不挪）、每项先拷到本进程自己的暂存位置再一次
// 放上去，写不进去时报错、不留半截、不记已接且下次再来（上次拷到一半留下的暂存也清掉），只接一次；几份 Navi
// 同时第一次打开时只有一份在复制，别的等它接完才放行，放行时看到的一定是完整的一份；复制到一半被杀掉，重开补齐；
// 持锁那一份卡住时等满时限交出原因；登录自启——旧登录项换成新的只做一次，用户关掉之后后台重试只清理、不再打开，
// 关掉时旧登录项删不掉要报错，新的装不上下一轮再来；建窗口之前那道闸——
// 旧 app 不肯退、复制失败都挡着不放（什么都不复制、不记已接），没有可接的、用户选了不接就放行；旧包让位——
// 只认包标识对得上的真目录（软链、别的包不算），旧登录项还没换成 Navi 的时不动（它跑的是旧包里的可执行文件），
// 判「有没有人在用」走安装器同一份 bundle-users.sh：有进程拿着
// 代码锁、代码锁之外有进程拿包里的可执行文件跑且工作目录在包里、命令行里带着它（更早的无锁版本）时都不动；
// 没人用时移到废纸篓并原地留一个指向新包的软链，放软链失败就把旧包放回原处。
// 再用真 WebKit 走一遍：旧身份的空壳 app 往本机页面的 localStorage 和 cookie 里各存一样，新身份的空壳 app
// 走 adoptWebData 之后打开同一个源读得出来；不接班的第三个身份读不到（证明是复制带过去的）。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const usersScript = join(root, "desktop/macos/scripts/bundle-users.sh");

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

function hold(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "ignore", ...options });
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
  console.log("PASS: web data is copied (not moved) once, each part published whole; a failed copy is reported, leaves nothing half-done and is retried next launch");

  const gateLibrary = join(temporary, "GateLibrary");
  mkdirSync(join(gateLibrary, "WebKit/old.id/WebsiteData"), { recursive: true });
  writeFileSync(join(gateLibrary, "WebKit/old.id/WebsiteData/data"), "x");
  cleanups.push(() => ["", ".busy", ".skip"].forEach((suffix) => forgetDomain(`${domain}.gate${suffix}`)));
  assert.equal(run("gate", gateLibrary, `${domain}.gate`), "OK gate");
  console.log("PASS: no window before the web data is in — an old app that will not quit or a failed copy blocks with a reason; nothing to adopt or a skip lets it open");

  // 几份 Navi 同时第一次打开：同一时刻只有一份在复制；每一份放行（要建窗口）时，目标都已经是完整的。
  const raceLibrary = join(temporary, "RaceLibrary");
  const raceSource = join(raceLibrary, "WebKit/old.race/WebsiteData");
  mkdirSync(raceSource, { recursive: true });
  for (let i = 0; i < 20000; i++) writeFileSync(join(raceSource, `f${i}`), "x");
  const expected = readdirSync(join(raceLibrary, "WebKit/old.race"), { recursive: true }).length;
  const raceDomain = `${domain}.race`;
  cleanups.push(() => forgetDomain(raceDomain));
  const race = () => new Promise((done) => {
    const child = spawn(driver, ["race", raceLibrary, "old.race", "new.race", raceDomain], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("exit", (code, signal) => done({ code, signal, out: out.trim(), child }));
    children.add(child);
  });
  const staging = () => readdirSync(join(raceLibrary, "WebKit")).filter((name) => name.includes(".new.race.adopting-"));
  // 先来的那份复制到一半被杀掉（进程没了）：重开那份清掉它的半截、补齐。
  const doomed = spawn(driver, ["race", raceLibrary, "old.race", "new.race", raceDomain], { stdio: "ignore" });
  children.add(doomed);
  const deadline = Date.now() + 20_000;
  while (staging().length === 0 && Date.now() < deadline) await delay(5);
  assert.ok(staging().length > 0, "the first one started copying");
  doomed.kill("SIGKILL");
  await once(doomed, "exit");
  assert.ok(!existsSync(join(raceLibrary, "WebKit/new.race")), "killed mid-copy: nothing published");
  const opened = await Promise.all([race(), race(), race()]);
  for (const { code, out } of opened) {
    assert.equal(code, 0, out);
    assert.equal(out, `OPEN blocked=nil files=${expected}`, "every instance opens only once the copy is whole");
  }
  assert.deepEqual(staging(), [], "no staging left behind");
  assert.equal(readdirSync(join(raceLibrary, "WebKit/new.race"), { recursive: true }).length, expected);
  console.log("PASS: several first launches at once — one copies under the adoption lock, the others wait and open on the whole copy; one killed mid-copy is completed by the next");

  // 持锁那一份卡住了：这一份等满时限就交出原因（走「重试 / 不接了 / 退出」），不无限僵在启动上。
  const stuckHolder = hold("/usr/bin/lockf", ["-k", join(raceLibrary, "WebKit/.stuck.id.adopting.lock"), "/bin/sleep", "60"]);
  await delay(500);
  cleanups.push(() => forgetDomain(`${domain}.lockwait`));
  assert.equal(run("lock-wait", raceLibrary, "old.race", "stuck.id", `${domain}.lockwait`), "OK lock-wait");
  await stop(stuckHolder);
  assert.ok(!existsSync(join(raceLibrary, "WebKit/stuck.id")), "nothing copied without the lock");
  console.log("PASS: a stuck holder of the adoption lock makes the waiting launch give up with a reason after the time limit");

  // ── 登录自启：用户的决定压过残留的旧登录项 ──
  const loginPolicyPlist = join(temporary, "LoginPolicy", "dev.ash.server.plist");
  mkdirSync(join(loginPolicyPlist, ".."), { recursive: true });
  cleanups.push(() => {
    spawnSync("chflags", ["nouchg", loginPolicyPlist]);
    ["", ".retry"].forEach((suffix) => forgetDomain(`${domain}.login${suffix}`));
  });
  assert.equal(run("login", loginPolicyPlist, `${domain}.login`), "OK login");
  console.log("PASS: login item — the old one is replaced once; after the user turns it off, retries only clean up and never turn it back on; a failed enable is retried");

  // ── 旧包让位 ──
  const apps = join(temporary, "Applications");
  const successor = fakeBundle(join(apps, "Navi.app"), "dev.navi.mac");
  const legacy = fakeBundle(join(apps, "Ash.app"), "dev.ash.mac");
  const other = fakeBundle(join(temporary, "elsewhere", "Ash.app"), "com.example.ash");
  const loginPlist = join(temporary, "LaunchAgents", "dev.ash.server.plist"); // 默认那份是这台机器上真的，测试一律给临时路径
  mkdirSync(join(loginPlist, ".."), { recursive: true });
  run("is-legacy", legacy, "yes");
  run("is-legacy", other, "no");
  run("is-legacy", successor, "no");

  // 旧版服务 / MCP 以共享锁拿着代码锁（shared/src/code-lock.ts）：拿着的时候不动。
  const holder = hold("/usr/bin/lockf", ["-s", join(legacy, "Contents/Resources/app/.in-use"), "/bin/sleep", "60"]);
  await delay(500);
  let outcome = run("retire", legacy, successor, usersScript, loginPlist);
  assert.match(outcome, /^BUSY .*\.in-use/, outcome);
  assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink(), "a bundle in use stays where it is");
  await stop(holder);

  // 代码锁只管得到参加它的入口：别的进程拿包里的可执行文件跑、工作目录在包里（命令行里只有相对路径），照样算在用。
  const appDir = join(legacy, "Contents/Resources/app");
  spawnSync("cp", ["/bin/sleep", join(appDir, "node")]);
  const outsider = hold("./node", ["60"], { cwd: appDir });
  await delay(500);
  outcome = run("retire", legacy, successor, usersScript, loginPlist);
  assert.match(outcome, new RegExp(`^BUSY .*${outsider.pid}`), outcome);
  assert.ok(!lstatSync(legacy).isSymbolicLink(), "a bundle something runs from stays where it is, code lock or not");
  await stop(outsider);
  rmSync(join(appDir, "node"));

  // 原地放软链失败：旧包放回原处，写死旧路径的命令不会落空，下次启动再来。
  // 旧登录项还没换成 Navi 的：它写死的是旧包里的 MacOS/Ash，留下的软链那头只有 MacOS/Navi —— 不让位。
  writeFileSync(loginPlist, "<plist/>");
  outcome = run("retire", legacy, successor, usersScript, loginPlist);
  assert.match(outcome, /^BUSY .*登录项/, outcome);
  assert.ok(!lstatSync(legacy).isSymbolicLink(), "the old executable the login item runs stays in place");
  rmSync(loginPlist);

  outcome = run("retire-link-fails", legacy, successor, usersScript, loginPlist);
  assert.match(outcome, /^FAILED .*放回原处/, outcome);
  assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink() && existsSync(join(legacy, "Contents/Info.plist")), "put back in place");
  run("is-legacy", legacy, "yes");

  outcome = run("retire", legacy, successor, usersScript, loginPlist);
  assert.match(outcome, /^RETIRED \//, outcome);
  const trashed = outcome.slice("RETIRED ".length);
  cleanups.push(() => rmSync(trashed, { recursive: true, force: true }));
  assert.ok(existsSync(join(trashed, "Contents/Info.plist")), "the old bundle went to the Trash, recoverable");
  assert.ok(lstatSync(legacy).isSymbolicLink(), "its old path is now a link …");
  assert.equal(readlinkSync(legacy), successor, "… to the new app, so absolute paths into Ash.app keep working");
  assert.equal(realpathSync(join(legacy, "Contents/Resources/app/.in-use")), realpathSync(join(successor, "Contents/Resources/app/.in-use")));
  run("is-legacy", legacy, "no");
  console.log("PASS: the old bundle waits while its code lock is held, anything runs from it by real file identity or the old login item still points into it, goes back in place if the link cannot be made, then goes to the Trash and leaves a link to Navi.app behind");

  // 更早的、没有代码锁的旧版：只能按命令行认。
  const lockless = fakeBundle(join(temporary, "Applications-2", "Ash.app"), "dev.ash.mac", { lock: false });
  const runner = hold(process.execPath, ["-e", "setTimeout(() => {}, 60000)", join(lockless, "Contents/Resources/app/server/dist/index.js")]);
  await delay(300);
  outcome = run("retire", lockless, successor, usersScript, loginPlist);
  assert.match(outcome, /^BUSY .*Ash\.app/, outcome);
  await stop(runner);
  outcome = run("retire", lockless, successor, usersScript, loginPlist);
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

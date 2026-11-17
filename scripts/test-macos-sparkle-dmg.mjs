// 真的 Sparkle 从 dmg 装新版（仅 macOS）：旧版 app 查到更新 → 下载 dmg → 先验 EdDSA 再挂载 → 换上新版 →
// 重开，全程不碰 GitHub、钥匙串和「应用程序」里的 app。
//
// 宿主是 desktop/macos/Tests/SparkleDmg 编出来的空壳 Ash.app：带真的 Sparkle.framework（与 build.sh 同一份），
// Info.plist 里的更新配置与 build.sh 写的同一套，界面换成照单全收的 SPUUserDriver。新版用发版脚本的
// `--local` 演练出 dmg 和签过的 appcast（make-dmg.sh 封的就是正式发版那个格式），由本机 http 托着。
// 覆盖：dmg 被（长度不变地）改了一个字节 → 下载了但验签不过、不挂载不安装，装着的还是旧版；appcast 被改过
// → 连 dmg 都不下，装着的还是旧版；都对 → 装上新版、Sparkle 把它重开。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "macOS-only regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const mac = join(root, "desktop/macos");
const temporary = realpathSync(mkdtempSync(join(tmpdir(), "ash-sparkle-dmg-")));
const bundleId = `dev.ash.sparkle-dmg-probe.${process.pid}`;
const log = join(temporary, "probe.log");
const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const children = new Set();
const bundles = [];

const sparkleOut = spawnSync(process.execPath, [join(mac, "scripts/sparkle.mjs")], { encoding: "utf8" });
assert.equal(sparkleOut.status, 0, sparkleOut.stderr);
const sparkle = sparkleOut.stdout.trim();

const { privateKey } = generateKeyPairSync("ed25519");
const jwk = privateKey.export({ format: "jwk" });
const keyFile = join(temporary, "rehearsal.key");
writeFileSync(keyFile, Buffer.from(jwk.d, "base64url").toString("base64"));
const publicKey = Buffer.from(jwk.x, "base64url").toString("base64");

// 本机的更新源：哪个目录在「线上」由 served 决定；dmg 照 GitHub 附件那样以 attachment 下发。
let served = null;
const requests = [];
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  requests.push(name);
  const file = served && !name.includes("..") ? join(served, name) : null;
  if (!file || !existsSync(file)) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader("content-type", name.endsWith(".xml") ? "application/xml" : "application/octet-stream");
  if (name.endsWith(".dmg")) res.setHeader("content-disposition", `attachment; filename=${name}`);
  res.end(readFileSync(file));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const feedURL = `http://127.0.0.1:${server.address().port}/appcast.xml`;

const binary = join(temporary, "probe");
const build = spawnSync("swiftc", ["-swift-version", "5", "-target", "arm64-apple-macos14.0", "-framework", "AppKit",
  "-F", sparkle, "-framework", "Sparkle", "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
  join(mac, "Tests/SparkleDmg/main.swift"), "-o", binary], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);

/** 一份空壳 Ash.app：版本、要不要一打开就查更新；更新配置同 build.sh。 */
function makeApp(dir, version, { check }) {
  const app = join(dir, "Ash.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Frameworks"), { recursive: true });
  cpSync(binary, join(app, "Contents/MacOS/Ash"));
  assert.equal(spawnSync("ditto", [join(sparkle, "Sparkle.framework"), join(app, "Contents/Frameworks/Sparkle.framework")]).status, 0);
  writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${bundleId}</string>
  <key>CFBundleName</key><string>ash</string>
  <key>CFBundleExecutable</key><string>Ash</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>SUFeedURL</key><string>${feedURL}</string>
  <key>SUPublicEDKey</key><string>${publicKey}</string>
  <key>SURequireSignedFeed</key><true/>
  <key>SUVerifyUpdateBeforeExtraction</key><true/>
  <key>SUEnableAutomaticChecks</key><false/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>ProbeLog</key><string>${log}</string>
  ${check ? "<key>ProbeCheck</key><true/>" : ""}
</dict></plist>`);
  assert.equal(spawnSync("codesign", ["--force", "--sign", "-", app]).status, 0);
  bundles.push(app);
  return app;
}

const versionOf = (app) => spawnSync("plutil", ["-extract", "CFBundleVersion", "raw", join(app, "Contents/Info.plist")], { encoding: "utf8" }).stdout.trim();
const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const tag = temporary.split("/").pop();
const leftovers = () => spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout.split("\n").filter((line) => line.includes(tag));

/** 让装着的旧版打开一次、查一次更新，等到有结局（出错 / 新版被重开）。 */
async function runOnce(installed, feed, { until }) {
  served = feed;
  requests.length = 0;
  rmSync(log, { force: true });
  const child = spawn(join(installed, "Contents/MacOS/Ash"), [], { stdio: "ignore", env: cleanEnv });
  children.add(child);
  child.once("exit", () => children.delete(child));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !lines().some((line) => until.test(line))) await delay(250);
  // 旧版自己会退（出错后、或被 Sparkle 退掉装新版）；等它退干净再看装着的是哪一版。
  while (Date.now() < deadline && children.has(child)) await delay(100);
  const seen = lines();
  assert.ok(seen.some((line) => until.test(line)), `no ${until} within 120 s:\n${seen.join("\n")}`);
  // Sparkle 的安装器和进度 app（Updater.app）比旧版多活几秒；它们还在时下一次检查会去「续装」上一次那个，
  // 而不是重新拉 appcast。等到这次临时目录下拉起的进程全退了再往下走。
  while (Date.now() < deadline && leftovers().length) await delay(250);
  assert.deepEqual(leftovers(), [], "Sparkle's helpers exit on their own");
  return { seen, requests: [...requests] };
}

try {
  const staging = join(temporary, "new");
  const fresh = makeApp(staging, "20000101.0002", { check: false });
  const good = join(temporary, "feed-good");
  const release = spawnSync(process.execPath, [join(mac, "scripts/release.mjs"), "--local", good, "--app", fresh, "--ed-key-file", keyFile, "--notes", "新版"],
    { encoding: "utf8", env: { ...cleanEnv, ASH_MAC_RELEASE_ARTIFACTS: join(temporary, "artifacts") } });
  assert.equal(release.status, 0, `${release.stdout}${release.stderr}`);
  const dmgName = "Ash-0.2.0-20000101.0002.dmg";
  assert.ok(existsSync(join(good, dmgName)));

  const badDmg = join(temporary, "feed-bad-dmg");
  cpSync(good, badDmg, { recursive: true });
  const bytes = readFileSync(join(badDmg, dmgName));
  bytes[bytes.length >> 1] ^= 0xff;
  writeFileSync(join(badDmg, dmgName), bytes);
  const badFeed = join(temporary, "feed-bad-appcast");
  cpSync(good, badFeed, { recursive: true });
  const appcast = readFileSync(join(badFeed, "appcast.xml"), "utf8");
  assert.ok(appcast.includes("新版"));
  writeFileSync(join(badFeed, "appcast.xml"), appcast.replace("新版", "改过的说明"));

  const installed = makeApp(join(temporary, "Applications"), "20000101.0001", { check: true });

  let result = await runOnce(installed, badDmg, { until: /^ERROR / });
  assert.ok(result.seen.includes("FOUND 20000101.0002"), result.seen.join("\n"));
  assert.ok(result.requests.includes(dmgName), "the tampered dmg was downloaded …");
  assert.match(result.seen.find((line) => line.startsWith("ERROR ")), /EdDSA|signature/i, "… and rejected by its signature");
  assert.ok(!result.seen.includes("READY") && !result.seen.includes("INSTALLING"), result.seen.join("\n"));
  assert.equal(versionOf(installed), "20000101.0001", "a tampered dmg is never installed");

  result = await runOnce(installed, badFeed, { until: /^(ERROR|NOT-FOUND) / });
  assert.ok(!result.seen.some((line) => line.startsWith("FOUND")), result.seen.join("\n"));
  assert.deepEqual(result.requests, ["appcast.xml"], "with a tampered appcast not even the dmg is fetched");
  assert.match(result.seen.at(-1), /^ERROR .*(EdDSA|signature|signed)/i, "the appcast is refused by its signature");
  assert.equal(versionOf(installed), "20000101.0001", "a tampered appcast never leads to an install");
  console.log(`PASS: a tampered dmg is downloaded but refused by its EdDSA signature before mounting; a tampered appcast is refused before anything is downloaded (Sparkle: ${result.seen.at(-1).split(" <- ").at(-1)})`);

  result = await runOnce(installed, good, { until: /^LAUNCHED 20000101\.0002 / });
  assert.deepEqual(result.seen.slice(0, 5).map((line) => line.split(" ")[0]), ["LAUNCHED", "CHECKING", "FOUND", "DOWNLOADING", "EXTRACTING"], result.seen.join("\n"));
  assert.ok(result.seen.includes("READY"), result.seen.join("\n"));
  assert.equal(versionOf(installed), "20000101.0002", "the app from the dmg replaced the installed one");
  assert.ok(result.seen.includes(`LAUNCHED 20000101.0002 ${installed}`), "and Sparkle relaunched it from the same place");
  assert.ok(existsSync(join(installed, "Contents/Frameworks/Sparkle.framework/Versions/Current")), "the framework's symlinks survived the trip through the dmg");
  assert.equal(spawnSync("codesign", ["--verify", "--deep", "--strict", installed]).status, 0, "and its signature is intact");
  console.log("PASS: the old app finds the update, downloads the dmg, verifies it before mounting, installs the new app and relaunches it");
} finally {
  for (const child of children) child.kill("SIGKILL");
  await new Promise((done) => { server.closeAllConnections(); server.close(done); });
  for (const app of bundles) spawnSync(lsregister, ["-u", app]);
  // defaults delete 只清内容、留下一个空 plist，文件另删。
  spawnSync("defaults", ["delete", bundleId], { stdio: "ignore" });
  rmSync(join(homedir(), "Library/Preferences", `${bundleId}.plist`), { force: true });
  for (const dir of ["Library/Caches", "Library/HTTPStorages", "Library/Saved Application State", "Library/WebKit"]) {
    rmSync(join(homedir(), dir, dir.endsWith("State") ? `${bundleId}.savedState` : bundleId), { recursive: true, force: true });
  }
  rmSync(temporary, { recursive: true, force: true });
}

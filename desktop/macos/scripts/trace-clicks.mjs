import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "macOS only");
const mac = fileURLToPath(new URL("..", import.meta.url));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const installed = process.env.NAVI_CLICK_TRACE_APP || "/Applications/Navi.app";
const service = new URL(process.env.NAVI_CLICK_TRACE_URL || "http://127.0.0.1:4317");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(service.hostname), "diagnostics only connects to the existing local service");
const response = await fetch(new URL("/api/health", service), { signal: AbortSignal.timeout(5000) });
assert.ok(response.ok, `health: ${response.status}`);
const { instance } = await response.json();
assert.ok((instance?.desktop || instance?.localOnly) && instance?.dataDir && instance?.codeDir && instance?.windowPort,
  "an existing app-owned local service with a dedicated window port is required");
assert.ok(existsSync(join(instance.codeDir, "node/bin/node")), "existing bundled runtime is missing");

const temporary = mkdtempSync(join(tmpdir(), "navi-click-trace-"));
const app = join(temporary, "Navi 点击诊断.app");
const contents = join(app, "Contents");
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(join(contents, "Resources"), { recursive: true });
symlinkSync(join(installed, "Contents/Frameworks"), join(contents, "Frameworks"));
symlinkSync(instance.codeDir, join(contents, "Resources/app"));
const plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", join(installed, "Contents/Info.plist")], { encoding: "utf8" }));
const commit = plist.NaviSourceCommit;
assert.match(commit || "", /^[a-f0-9]{7,40}$/, "installed app has no source commit");
const sourcePaths = execFileSync("git", ["ls-tree", "-r", "--name-only", commit, "desktop/macos/Sources/"], { cwd: repo, encoding: "utf8" })
  .trim().split("\n").filter(path => /^desktop\/macos\/Sources\/[^/]+\.swift$/.test(path));
assert.ok(sourcePaths.length > 0, "installed app source commit is not available locally");
const sourceDirectory = join(temporary, "Sources");
mkdirSync(sourceDirectory);
const replaceOnce = (source, original, replacement) => {
  assert.equal(source.split(original).length, 2, `installed diagnostic hook changed: ${original}`);
  return source.replace(original, replacement);
};
let webViewDefinitions = 0;
for (const path of sourcePaths) {
  let source = execFileSync("git", ["show", `${commit}:${path}`], { cwd: repo, encoding: "utf8" });
  source = source.replace(/(?:final )?class NaviWebView\s*:\s*WKWebView\s*\{/, () => {
    webViewDefinitions += 1;
    return "class OriginalNaviWebView: WKWebView {";
  });
  if (path.endsWith("/ServerLauncher.swift")) {
    source = replaceOnce(source, "func ensureRunningSync(timeout: TimeInterval) -> Outcome {", `func ensureRunningSync(timeout: TimeInterval) -> Outcome {
    if ProcessInfo.processInfo.environment["NAVI_MAC_CLICK_TRACE"] != nil {
      return NaviHealth.isServing(NaviHealth.probeSync()) ? .ready : .failed("诊断窗口只连接现有服务，不启动或替换服务。")
    }`);
  }
  if (path.endsWith("/AppDelegate.swift")) {
    for (const original of [
      "guard adoptLegacyIdentity() else { return }",
      "AppUpdater.shared.start()",
      "do { try LoginService.reconcileAtLaunch() } catch { NSAlert(error: error).runModal() }",
      "DispatchQueue.global(qos: .utility).async { DownloadTransaction.reclaimAbandoned() }",
    ]) source = replaceOnce(source, original, "");
  }
  if (path.endsWith("/LaunchFlow.swift")) {
    source = replaceOnce(source, "HostMcpSetup.runOnceIfNeeded(window: window)", "");
    source = replaceOnce(source, "checkStaleServer()\n", "");
  }
  writeFileSync(join(sourceDirectory, path.split("/").at(-1)), source);
}
assert.equal(webViewDefinitions, 1, "expected one installed NaviWebView implementation");
for (const key of Object.keys(plist)) if (key.startsWith("SU")) delete plist[key];
Object.assign(plist, {
  CFBundleIdentifier: "dev.navi.click-trace", CFBundleName: "Navi 点击诊断",
  CFBundleDisplayName: "Navi 点击诊断", CFBundleExecutable: "Navi",
});
delete plist.CFBundleURLTypes;
const info = join(contents, "Info.plist");
writeFileSync(info, JSON.stringify(plist));
execFileSync("plutil", ["-convert", "xml1", info]);
const environment = {
  NAVI_URL: service.origin, NAVI_DATA_DIR: instance.dataDir, NAVI_MAC_RUNTIME: instance.codeDir,
  NAVI_MAC_WINDOW_PORT: String(instance.windowPort), NAVI_MAC_CLICK_TRACE: join(temporary, "events.jsonl"),
};
const bootstrap = Object.entries(environment).map(([key, value]) => `setenv(${JSON.stringify(key)}, ${JSON.stringify(value)}, 1)`).join("\n");
const main = join(temporary, "main.swift");
const entry = replaceOnce(readFileSync(join(sourceDirectory, "main.swift"), "utf8"), "LegacyIdentity.adoptDefaultsAtLaunch()", "");
writeFileSync(main, `import Darwin\n${bootstrap}\n${entry}`);
const sources = readdirSync(sourceDirectory).filter(name => name.endsWith(".swift") && name !== "main.swift");
execFileSync("swiftc", ["-O", "-swift-version", "5", "-target", "arm64-apple-macos14.0",
  "-framework", "AppKit", "-framework", "WebKit", "-F", join(installed, "Contents/Frameworks"), "-framework", "Sparkle",
  "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
  ...sources.map(name => join(sourceDirectory, name)), join(mac, "Diagnostics/ClickTrace.swift"), main,
  "-o", join(contents, "MacOS/Navi")], { stdio: "inherit" });
execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
console.log(`诊断源码：已安装版本 ${commit}\n诊断窗口：${app}\n事件日志：${environment.NAVI_MAC_CLICK_TRACE}`);
console.log("只记录事件元数据，不记录输入内容；未改变 WebKit 输入处理，也未替换现用应用或服务。");
if (!process.argv.includes("--prepare-only")) execFileSync("open", ["-n", app]);

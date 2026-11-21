import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS About panel requires AppKit");
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "navi-version-display-"));
const app = join(temporary, "NaviVersionDisplay.app");
const contents = join(app, "Contents");
const resultPath = join(temporary, "result.json");
const buildNumber = "20261121.040506";
const shortVersion = "0.3.2";

try {
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>dev.navi.tests.version-display</string>
  <key>CFBundleExecutable</key><string>NaviVersionDisplay</string>
  <key>CFBundleName</key><string>Navi</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${shortVersion}</string>
  <key>CFBundleVersion</key><string>${buildNumber}</string>
</dict></plist>`);
  const build = spawnSync("swiftc", ["-swift-version", "5", "-framework", "AppKit",
    join(root, "desktop/macos/Sources/AboutPanel.swift"), join(root, "desktop/macos/Tests/About/main.swift"),
    "-o", join(contents, "MacOS/NaviVersionDisplay")], { encoding: "utf8", timeout: 60_000 });
  assert.equal(build.status, 0, `${build.error ?? ""}\n${build.stdout}${build.stderr}`);
  const args = ["-n", "-W", app, "--args", resultPath];
  if (process.env.NAVI_MAC_VERSION_SCREENSHOT) args.push(process.env.NAVI_MAC_VERSION_SCREENSHOT);
  const launch = spawnSync("/usr/bin/open", args, { encoding: "utf8", timeout: 20_000 });
  assert.equal(launch.status, 0, `${launch.error ?? ""}\n${launch.stdout}${launch.stderr}`);
  if (process.env.NAVI_MAC_VERSION_SCREENSHOT) assert.ok(statSync(process.env.NAVI_MAC_VERSION_SCREENSHOT).size > 0);
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.equal(result.actionSent, true);
  assert.equal(result.buildNumber, buildNumber, "automatic updates still have the internal build number");
  assert.equal(result.shortVersion, shortVersion);
  assert.ok(result.text.some((text) => text.includes(shortVersion)), JSON.stringify(result));
  assert.ok(result.text.every((text) => !text.includes(buildNumber)), JSON.stringify(result));
  console.log("PASS: native About panel shows only the release version and preserves CFBundleVersion");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

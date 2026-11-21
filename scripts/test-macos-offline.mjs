import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runTestProcess } from "./test-process.mjs";
import { withTestResources } from "./test-process-resources.mjs";

if (process.platform !== "darwin") {
  console.log("SKIP: macOS offline UI");
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "navi-offline-ui-"));
await withTestResources(async () => {
  const contents = join(temporary, "NaviOfflinePreview.app/Contents");
  const executable = join(contents, "MacOS/NaviOfflinePreview");
  const resource = join(contents, "Resources/loader.svg");
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  mkdirSync(join(contents, "Resources"), { recursive: true });
  writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.navi.offline-preview</string>
<key>CFBundleName</key><string>NaviOfflinePreview</string>
<key>CFBundleExecutable</key><string>NaviOfflinePreview</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  copyFileSync(join(root, "docs/logo/loader.svg"), resource);
  const build = readFileSync(join(root, "desktop/macos/build.sh"), "utf8");
  assert.match(build, /cp "\$HERE\/\.\.\/\.\.\/docs\/logo\/loader.svg" "\$APP\/Contents\/Resources\/loader.svg"/);
  await runTestProcess("swiftc", ["-swift-version", "5",
    ...["Sources/OfflineView.swift", "Sources/NaviPalette.swift", "Tests/Offline/main.swift"]
      .map((path) => join(root, "desktop/macos", path)),
    "-o", executable,
  ], { cwd: root, timeout: 120000 });
  const result = await runTestProcess(executable, [], { cwd: root, timeout: 60000 });
  process.stdout.write(result.stdout);
  rmSync(resource);
  const fallback = await runTestProcess(executable, ["--fallback"], { cwd: root, timeout: 60000 });
  process.stdout.write(fallback.stdout);
}, [() => rmSync(temporary, { recursive: true, force: true })]);

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARCHITECTURES, architectureConfig, assertArchitecture, buildArchitecture, configuredArchitectures, distributionName, recoveryName } from "../desktop/macos/scripts/architecture.mjs";

const config = JSON.parse(readFileSync(new URL("../desktop/macos/release.json", import.meta.url), "utf8"));
assert.deepEqual(configuredArchitectures(config), ["arm64", "x64"]);
const arm = architectureConfig(config, "arm64");
const intel = architectureConfig(config, "x64");
assert.equal(arm.appcastPath, "navi/mac/appcast.xml");
assert.equal(intel.appcastPath, "navi/mac/appcast-intel.xml");
assert.equal(arm.tagPrefix, "navi-mac-v");
assert.equal(intel.tagPrefix, "navi-mac-intel-v");
assert.equal(intel.legacyAppcastPath, null);
assert.equal(arm.publicKey, intel.publicKey);
assert.equal(arm.downloadTag, intel.downloadTag);
assert.equal(architectureConfig(intel, "arm64").appcastPath, arm.appcastPath);
assert.equal(distributionName("0.3.2", "20261121.040506", "arm64"), "Navi-0.3.2-20261121.040506.dmg");
assert.equal(distributionName("0.3.2", "20261121.040506", "x64"), "Navi-0.3.2-20261121.040506-intel.dmg");
assert.equal(recoveryName("123", "arm64"), "mac-release-123-arm64");
assert.equal(recoveryName("123", "x64"), "mac-release-123-x64");
assert.equal(buildArchitecture({}, "x64"), "x64");
assert.equal(buildArchitecture({ NAVI_MAC_ARCH: "arm64" }, "arm64"), "arm64");
assert.throws(() => buildArchitecture({ NAVI_MAC_ARCH: "x64" }, "arm64"), /对应架构/);
assert.throws(() => assertArchitecture("x86_64"), /不支持/);
assert.throws(() => architectureConfig({ ...config, architectures: undefined }, "x64"), /缺少 Intel/);
for (const override of [{ appcastPath: config.appcastPath }, { tagPrefix: config.tagPrefix }, { legacyAppcastPath: config.legacyAppcastPath }]) {
  assert.throws(() => architectureConfig({ ...config, architectures: { x64: { ...config.architectures.x64, ...override } } }, "x64"));
}
for (const metadata of Object.values(ARCHITECTURES)) assert.match(metadata.checksum, /^[a-f0-9]{64}$/);
assert.notEqual(ARCHITECTURES.arm64.checksum, ARCHITECTURES.x64.checksum);
console.log("PASS: native architecture selection, pinned runtimes, separate update feeds, immutable Intel naming and legacy ARM compatibility");

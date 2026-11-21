import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ARCHITECTURES, architectureConfig, assertArchitecture, buildArchitecture, configuredArchitectures, distributionName, publishedNames, recoveryName, releaseNames } from "../desktop/macos/scripts/architecture.mjs";

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
assert.equal(distributionName("0.3.3", "arm64"), "Navi-0.3.3.dmg");
assert.equal(distributionName("0.3.3", "x64"), "Navi-0.3.3-intel.dmg");
for (const channel of [arm, intel]) {
  const shortVersion = "0.3.3";
  const version = "20261121.040506";
  const clean = releaseNames(channel, shortVersion, version);
  assert.equal(clean.tag, `${channel.tagPrefix}${shortVersion}`);
  assert.equal(clean.name, distributionName(shortVersion, channel.architecture));
  const legacy = releaseNames(channel, shortVersion, version, `${clean.tag}-${version}`);
  assert.equal(legacy.name, distributionName(`${shortVersion}-${version}`, channel.architecture));
  for (const names of [clean, legacy]) {
    const details = { shortVersion, version, url: `https://github.com/o/app/releases/download/${names.tag}/${names.name}` };
    assert.deepEqual(publishedNames(channel, details), names);
    assert.throws(() => publishedNames(architectureConfig(config, channel.architecture === "arm64" ? "x64" : "arm64"), details), /架构不符/);
    assert.throws(() => publishedNames(channel, { ...details, shortVersion: "0.3.4" }), /版本或架构不符/);
  }
  for (const [tag, name] of [[clean.tag, legacy.name], [legacy.tag, clean.name]]) {
    assert.throws(() => publishedNames(channel, { shortVersion, version, url: `https://github.com/o/app/releases/download/${tag}/${name}` }));
  }
  assert.throws(() => releaseNames(channel, shortVersion, version, `${clean.tag}-20261121.999999`));
  assert.throws(() => publishedNames(channel, { shortVersion, version: "20261121.999999", url: `https://github.com/o/app/releases/download/${legacy.tag}/${legacy.name}` }));
}
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

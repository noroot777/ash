import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "v26.13.1";
export const ARCHITECTURES = {
  arm64: { label: "Apple 芯片", swift: "arm64", checksum: "af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559" },
  x64: { label: "Intel", swift: "x86_64", checksum: "2693310b2820f9350d29524f21344e1c623875bab773457d55b2aceb9670716f" },
};

export function assertArchitecture(architecture) {
  assert.ok(Object.hasOwn(ARCHITECTURES, architecture), `不支持的 Mac 架构：${architecture}`);
  return architecture;
}

export function buildArchitecture(env = process.env, host = process.arch) {
  const architecture = assertArchitecture(env.NAVI_MAC_ARCH || host);
  assert.equal(architecture, host, "请在对应架构的 Mac runner 上构建，不能混用 Node 或原生依赖");
  return architecture;
}

export function architectureConfig(config, architecture = "arm64") {
  assertArchitecture(architecture);
  const base = config.baseConfig ?? config;
  if (architecture !== "arm64") assert.ok(base.architectures?.[architecture], "缺少 Intel Mac 更新源配置");
  const selected = { ...base, ...base.architectures?.[architecture], architecture, baseConfig: base };
  assert.equal(selected.releaseRepo, base.releaseRepo);
  assert.equal(selected.feedRepo, base.feedRepo);
  if (architecture !== "arm64") {
    assert.notEqual(selected.appcastPath, base.appcastPath, "Intel 更新源不能覆盖 Apple 芯片更新源");
    assert.notEqual(selected.tagPrefix, base.tagPrefix, "Intel Release tag 不能覆盖 Apple 芯片 tag");
    assert.ok(!selected.legacyAppcastPath, "Intel 不发布旧版 Ash 通知源");
  }
  return selected;
}

export const configuredArchitectures = (config) => ["arm64", ...((config.baseConfig ?? config).architectures?.x64 ? ["x64"] : [])];
export const distributionName = (version, build, architecture = "arm64") =>
  `Navi-${version}-${build}${assertArchitecture(architecture) === "x64" ? "-intel" : ""}.dmg`;
export const recoveryName = (runId, architecture) => `mac-release-${runId}-${assertArchitecture(architecture)}`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.platform, "darwin", "Mac 安装包需要在 macOS 构建");
  console.log(buildArchitecture());
}

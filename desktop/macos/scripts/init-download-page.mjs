import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHub, NO_TOKEN_HINT, resolveToken } from "./github.mjs";
import { updateDownloadChannel } from "./release-channel.mjs";
import { itemDetails, latestItem, readConfig } from "./release-state.mjs";

export function verifyDownload(bytes, signature, publicKey) {
  const raw = Buffer.from(publicKey, "base64");
  assert.equal(raw.length, 32, "EdDSA 公钥格式不对");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  assert.ok(verify(null, bytes, key, Buffer.from(signature, "base64")), "dmg 的 EdDSA 签名无效，未更新下载页");
}

export async function initializeDownloadPage(github, config, { check = false, fetchDownload = fetch } = {}) {
  const feed = await github.readFile(config.feedRepo, config.appcastPath, config.feedBranch);
  const item = latestItem(feed?.text);
  const latest = itemDetails(item);
  assert.ok(latest?.shortVersion && latest.commit && latest.url, "现有更新源缺少完整的已发布版本");
  const tag = `${config.tagPrefix}${latest.shortVersion}-${latest.version}`;
  const release = await github.findRelease(config.releaseRepo, tag);
  assert.ok(release && !release.draft && !release.prerelease, "现有版本还不是公开稳定版");
  const name = `Navi-${latest.shortVersion}-${latest.version}.dmg`;
  const asset = release.assets?.find((entry) => entry.name === name);
  assert.equal(asset?.browser_download_url, latest.url, "更新源和公开 Release 的下载地址不一致");
  assert.equal(latest.url, `https://github.com/${config.releaseRepo}/releases/download/${tag}/${name}`);
  const response = await fetchDownload(latest.url);
  assert.ok(response.ok, `公开 dmg 下载失败：HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const length = Number(item.xml.match(/\blength="(\d+)"/)?.[1]);
  assert.equal(bytes.length, length, "下载大小与更新源不同");
  assert.equal(bytes.length, asset.size, "下载大小与 Release 附件不同");
  const signature = item.xml.match(/sparkle:edSignature="([^"]+)"/)?.[1];
  assert.ok(signature, "更新源缺少 EdDSA 签名");
  verifyDownload(bytes, signature, config.publicKey);
  if (check) return `已验证现有 Mac ${latest.shortVersion}（${latest.version}），未修改下载页`;
  return updateDownloadChannel(github, config, { ...latest, page: `https://github.com/${config.releaseRepo}/releases/tag/${tag}` });
}

async function main() {
  assert.ok(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === "--check"), "仅支持 --check");
  const config = readConfig(resolve(dirname(fileURLToPath(import.meta.url)), "../release.json"));
  const auth = resolveToken();
  if (!auth) throw new Error(NO_TOKEN_HINT);
  console.log(await initializeDownloadPage(new GitHub(auth.token), config, { check: process.argv[2] === "--check" }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`✕ ${error.message}`); process.exitCode = 1; });
}

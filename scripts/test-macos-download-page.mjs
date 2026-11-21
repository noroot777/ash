import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { renderAppcast, renderItem } from "../desktop/macos/scripts/appcast.mjs";
import { initializeDownloadPage, verifyDownload } from "../desktop/macos/scripts/init-download-page.mjs";
import { updateDownloadChannel } from "../desktop/macos/scripts/release-channel.mjs";
import { architectureConfig, distributionName } from "../desktop/macos/scripts/architecture.mjs";

const config = { releaseRepo: "o/app", feedRepo: "o/feed", feedBranch: "main", appcastPath: "navi/mac/appcast.xml",
  tagPrefix: "navi-mac-v", downloadTag: "navi-mac-latest" };
const commit = "a".repeat(40);
const bytes = Buffer.from("a signed test distribution");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
config.publicKey = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url").toString("base64");
const signature = sign(null, bytes, privateKey).toString("base64");
const version = "20261121.040506";
const tag = `navi-mac-v0.3.2-${version}`;
const url = `https://github.com/o/app/releases/download/${tag}/Navi-0.3.2-${version}.dmg`;
const candidate = { version, shortVersion: "0.3.2", commit, url, page: `https://github.com/o/app/releases/tag/${tag}` };
const feed = (release = candidate) => renderAppcast({ title: "test", link: "https://github.com/o/app", items: [renderItem({
  ...release, length: bytes.length, signature, minimumSystemVersion: "14.0", pubDate: new Date(),
})] });
const state = { feed: feed(), channel: null, writes: [], fail: false };
const github = {
  readFile: async () => ({ text: state.feed }),
  commitSha: async () => commit,
  findRelease: async (_repo, name) => name === config.downloadTag ? state.channel
    : { tag_name: tag, draft: false, prerelease: false, assets: [{ name: `Navi-0.3.2-${version}.dmg`, browser_download_url: url, size: bytes.length }] },
  call: async (method, path, { body }) => {
    if (state.fail) throw new Error("channel rejected");
    state.writes.push({ method, path, body });
    state.channel = { id: 1, ...state.channel, ...body };
    return { json: state.channel };
  },
};

assert.match(await updateDownloadChannel(github, config, candidate), /下载页已更新/);
assert.equal(state.writes[0].method, "POST");
assert.equal(state.channel.tag_name, config.downloadTag);
assert.equal(state.channel.make_latest, "false");
assert.match(state.channel.body, /^## Navi 0\.3\.2$/m);
assert.ok(state.channel.body.includes(`<!-- navi-mac-build:${version} -->`), "internal channel identity is preserved");
assert.doesNotMatch(state.channel.body, /^## .*2026/m);
assert.ok(state.channel.body.includes(url));
assert.equal(state.channel.target_commitish, commit);
const body = state.channel.body;
assert.match(await updateDownloadChannel(github, config, candidate), /已经是这一版/);
assert.equal(state.writes.length, 1);
state.feed = feed({ ...candidate, version: "20261122.000001" });
assert.match(await updateDownloadChannel(github, config, candidate), /保持在更新源的最新版本/);
assert.equal(state.channel.body, body);
state.feed = feed();
state.channel.body = "<!-- navi-mac-build:20261122.000001 -->";
assert.match(await updateDownloadChannel(github, config, candidate), /留在更新的/);
state.channel.body = body;
state.feed = feed({ ...candidate, url: "https://example.invalid/other.dmg" });
await assert.rejects(updateDownloadChannel(github, config, candidate), /未更新/);
state.feed = "";
await assert.rejects(updateDownloadChannel(github, config, candidate), /未更新/);
state.feed = feed();
state.channel.body = "stale";
state.fail = true;
await assert.rejects(updateDownloadChannel(github, config, candidate), /channel rejected/);
state.fail = false;
await updateDownloadChannel(github, config, candidate);
assert.equal(state.writes.at(-1).method, "PATCH");
assert.equal(state.writes.at(-1).body.target_commitish, undefined, "channel updates never move its tag");
console.log("PASS: Mac-only fixed page is idempotent, never changes historical assets/tags or global latest, and rejects incomplete feeds");

const fetchDownload = async (address) => { assert.equal(address, url); return new Response(bytes); };
const count = state.writes.length;
assert.equal(await initializeDownloadPage(github, config, { check: true, fetchDownload }), "已验证现有 Mac 0.3.2，未修改下载页");
assert.equal(state.writes.length, count);
await initializeDownloadPage(github, config, { fetchDownload });
await assert.rejects(initializeDownloadPage(github, config, { fetchDownload: async () => new Response("tampered") }), /下载大小/);
await assert.rejects(initializeDownloadPage(github, config, { fetchDownload: async () => new Response(null, { status: 404 }) }), /下载失败/);
const modified = Buffer.from(bytes);
modified[0] ^= 1;
assert.throws(() => verifyDownload(modified, signature, config.publicKey), /签名无效/);
console.log("PASS: initial migration verifies the existing public asset's URL, length and EdDSA signature before updating the page");

const dualConfig = { ...config, architectures: { x64: { appcastPath: "navi/mac/appcast-intel.xml", tagPrefix: "navi-mac-intel-v", legacyAppcastPath: null } } };
const intelConfig = architectureConfig(dualConfig, "x64");
const intelTag = `${intelConfig.tagPrefix}${candidate.shortVersion}-${version}`;
const intelUrl = `https://github.com/o/app/releases/download/${intelTag}/${distributionName(candidate.shortVersion, version, "x64")}`;
const intel = { ...candidate, url: intelUrl, page: `https://github.com/o/app/releases/tag/${intelTag}` };
const feeds = new Map([[config.appcastPath, feed()]]);
github.readFile = async (_repo, path) => feeds.has(path) ? { text: feeds.get(path) } : null;
state.channel = null;
await updateDownloadChannel(github, dualConfig, candidate);
assert.match(state.channel.body, /Apple 芯片/);
assert.ok(!state.channel.body.includes("（Intel）"), "unpublished Intel packages are never advertised");
feeds.set(intelConfig.appcastPath, feed(intel));
await updateDownloadChannel(github, intelConfig, intel);
assert.ok(state.channel.body.includes(url));
assert.ok(state.channel.body.includes(intelUrl));
assert.match(state.channel.body, /<!-- navi-mac-build-x64:20261121.040506 -->/);
const dualBody = state.channel.body;
await updateDownloadChannel(github, dualConfig, candidate);
assert.equal(state.channel.body, dualBody, "an ARM completion/retry never removes the Intel choice");
feeds.set(intelConfig.appcastPath, feed({ ...intel, url }));
await assert.rejects(updateDownloadChannel(github, dualConfig, candidate), /架构不符/);
feeds.set(intelConfig.appcastPath, feed({ ...intel, version: "20261120.000001" }));
assert.match(await updateDownloadChannel(github, dualConfig, candidate), /留在更新的/);
assert.equal(state.channel.body, dualBody, "stale feeds cannot roll either architecture back");
console.log("PASS: both architecture choices are retained; missing Intel feeds, crossed download URLs and stale channel markers are handled safely");

// mac 发版脚本（desktop/macos/scripts/release.mjs）的定点回归（仅 macOS）。不碰 GitHub、不碰钥匙串：
// 用现生成的演练密钥和一个假的 Ash.app。
//
// 本地演练（--local）：只出 dmg 不出 zip；dmg 是只读压缩镜像，卷里是 Ash.app（就是给的那份）、指向
// /Applications 的软链和入库的 Finder 布局；dmg 与 appcast 都验得过签、被篡改的（长度不变地改一个字节）
// dmg 和 appcast 验不过；同一版、更旧的版本拒发；app 里的公钥和签名私钥不是一对时拒发；第二版排在第一
// 版前面、第一版原样保留；`--notes` 进 appcast（转义过）；同一构建号缓存的 dmg 来自另一份 app 时拒发，
// 来自同一份时原样沿用。
//
// 正式发版对着一个本地假 GitHub 跑（两个仓库：o/app 放安装包，o/feed 放 appcast；账号权限和这张 token
// 真写得了分开模拟）。什么都不公开的几种：账号能写、token 只写得了其中一个或都写不了；清单分支要 PR / 开着
// 保护；构建提交没推；同名 tag 指着别的提交；app 里没记构建提交；旧格式（只有一个 repo）的配置。都齐了：
// 草稿 Release → 传 dmg → 下回来核对 → 公开（tag 打在构建提交上）→ appcast 提交进 o/feed、指向 o/app 的
// 公开附件 → （临时仓库里的）README 链接只提交 README。预检都过、提交 appcast 时才被拒：Release 保持公开
// （公开不撤回），修好后重跑只补 appcast。沿用一个记着别的提交、排在第二页的旧草稿：找得到，公开时 tag
// 打在这次的构建提交上。全都发完、只是 README 没提交上：重跑只补 README，不碰 GitHub；补的是旧版的收尾时
// README 不倒回旧版。README 那一步只动自己写的内容：提交失败且期间别处改过 README 时保留现场，README 已经指向
// 更新的一版时不倒回去。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.platform, "darwin", "macOS-only regression");
const root = fileURLToPath(new URL("..", import.meta.url));
const mac = join(root, "desktop/macos");
const temporary = mkdtempSync(join(tmpdir(), "ash-macos-release-"));
// git 的环境变量（在钩子或别的 git 命令里跑测试时会有）别漏进子进程：夹具仓库要用它自己的 .git。
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const sparkle = spawnSync(process.execPath, [join(mac, "scripts/sparkle.mjs")], { encoding: "utf8" });
assert.equal(sparkle.status, 0, sparkle.stderr);
const signUpdate = join(sparkle.stdout.trim(), "bin/sign_update");
const releaseScript = join(mac, "scripts/release.mjs");

const makeKey = (name) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const file = join(temporary, `${name}.key`);
  writeFileSync(file, Buffer.from(jwk.d, "base64url").toString("base64"));
  return { file, publicKey: Buffer.from(jwk.x, "base64url").toString("base64") };
};
const key = makeKey("rehearsal");
const wrong = makeKey("wrong");

function fakeApp(version, publicKey, { feed = "http://127.0.0.1:1/appcast.xml", commit = "unknown", tag = version } = {}) {
  const app = join(temporary, `apps-${tag}`, "Ash.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/Ash"), `binary ${tag}`);
  writeFileSync(join(app, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>AshSourceCommit</key><string>${commit}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>SUFeedURL</key><string>${feed}</string>
  <key>SUPublicEDKey</key><string>${publicKey}</string>
</dict></plist>`);
  return app;
}

const unescapeXml = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
const verify = (...args) => spawnSync(signUpdate, ["--verify", "--ed-key-file", key.file, ...args], { encoding: "utf8" }).status;
/** 长度不变地改掉文件正中间的一个字节（长度对不上 Sparkle 也会拒，这里要证明拦住它的是签名）。 */
function flipByte(file) {
  const bytes = readFileSync(file);
  bytes[bytes.length >> 1] ^= 0xff;
  writeFileSync(file, bytes);
}

/** 挂上 dmg（只读、不进 Finder），列出卷根，读完卸掉。 */
function dmgContents(dmg) {
  const mount = mkdtempSync(join(temporary, "mount-"));
  const attach = spawnSync("hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount], { encoding: "utf8" });
  assert.equal(attach.status, 0, attach.stderr);
  try {
    const entries = readdirSync(mount).filter((name) => name !== ".fseventsd" && name !== ".Trashes").sort();
    const applications = lstatSync(join(mount, "Applications"));
    return {
      entries,
      applications: applications.isSymbolicLink() ? readlinkSync(join(mount, "Applications")) : null,
      layout: readFileSync(join(mount, ".DS_Store")),
      binary: readFileSync(join(mount, "Ash.app/Contents/MacOS/Ash"), "utf8"),
    };
  } finally {
    spawnSync("hdiutil", ["detach", mount, "-force"], { encoding: "utf8" });
    rmSync(mount, { recursive: true, force: true });
  }
}

/**
 * README 链接那一步只动自己写的内容：提交失败时文件仍是自己写的那份才还原，期间被别处改过就保留现场；
 * README 已经指向更新的一版时不倒回去（不靠调用方早先读的 appcast）。commitLink 是同步的，放子进程里跑，
 * 好在提交钩子卡着的时候从外面改 README。
 */
async function readmeOwnership() {
  const dir = join(temporary, "readme-ownership");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  const git = (...args) => {
    const out = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  const readme = join(dir, "README.md");
  const original = "# ash\n<!-- ash-mac-download -->\n**[下载 ash 0.2.0（20000102.0002）](https://example.invalid/2.dmg)**\n<!-- /ash-mac-download -->\n";
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(readme, original);
  git("add", ".");
  git("commit", "-q", "-m", "init");
  // 钩子进来后留个记号，等到外面放行（或两秒）再失败。
  git("config", "core.hooksPath", "hooks");
  writeFileSync(join(dir, "hooks/pre-commit"), "#!/bin/sh\ntouch .entered\nfor i in $(seq 40); do [ -e .go ] && break; sleep 0.05; done\necho 'hook says no' >&2\nexit 1\n", { mode: 0o755 });
  const helper = join(mac, "scripts/download-link.mjs");
  const commitLink = (version, during) => {
    rmSync(join(dir, ".entered"), { force: true });
    rmSync(join(dir, ".go"), { force: true });
    const runner = `import { commitLink } from ${JSON.stringify(helper)};
console.log(commitLink(${JSON.stringify(readme)}, { url: "https://example.invalid/${version}.dmg", shortVersion: "0.2.0", version: "${version}" }));`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", runner], { cwd: dir, env: cleanEnv });
    let out = "";
    child.stdout.on("data", (data) => (out += data));
    child.stderr.on("data", (data) => (out += data));
    return (async () => {
      if (during) {
        while (!existsSync(join(dir, ".entered")) && child.exitCode === null) await new Promise((done) => setTimeout(done, 10));
        during();
        writeFileSync(join(dir, ".go"), "");
      }
      const [status] = await once(child, "close");
      assert.equal(status, 0, out);
      return out;
    })();
  };
  const clean = () => assert.equal(git("status", "--porcelain", "--", "README.md"), "");

  let out = await commitLink("20000102.0003");
  assert.match(out, /提交 .* 失败（hook says no），已还原/);
  assert.equal(readFileSync(readme, "utf8"), original, "a failed commit of an untouched README restores it");
  clean();

  out = await commitLink("20000102.0003", () => writeFileSync(readme, readFileSync(readme, "utf8") + "a line someone just saved\n"));
  assert.match(out, /期间被别处改过，保留现场没还原/);
  assert.ok(readFileSync(readme, "utf8").includes("a line someone just saved"), "someone else's edit survives the failed commit");
  assert.ok(readFileSync(readme, "utf8").includes("20000102.0003"));
  writeFileSync(readme, original);
  clean();

  out = await commitLink("20000102.0001");
  assert.match(out, /README 的下载链接留在更新的 20000102\.0002/);
  assert.equal(readFileSync(readme, "utf8"), original, "an older version never replaces a newer link");
  assert.equal(git("log", "--format=%s"), "init");
  console.log("PASS: the README link step only touches what it wrote: a failed commit restores an untouched README, keeps someone else's concurrent edit, and an older version never replaces a newer link");
}

try {
  await localRehearsal();
  await formalRehearsal();
  await readmeOwnership();
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

async function localRehearsal() {
  const feed = join(temporary, "feed");
  const artifacts = join(temporary, "artifacts");
  const release = (app, keyFile, notes = "演练", target = feed) => spawnSync(process.execPath,
    [releaseScript, "--local", target, "--app", app, "--ed-key-file", keyFile, "--notes", notes],
    { encoding: "utf8", env: { ...cleanEnv, ASH_MAC_RELEASE_ARTIFACTS: artifacts } });
  const appcast = () => readFileSync(join(feed, "appcast.xml"), "utf8");

  let result = release(fakeApp("20000101.0001", key.publicKey), key.file);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const first = join(feed, "Ash-0.2.0-20000101.0001.dmg");
  assert.ok(existsSync(first));
  assert.deepEqual(readdirSync(feed).sort(), ["Ash-0.2.0-20000101.0001.dmg", "appcast.xml"], "only a dmg, no zip");
  assert.ok(!readdirSync(join(artifacts, "v0.2.0-20000101.0001")).some((name) => name.endsWith(".zip")));
  const format = spawnSync("hdiutil", ["imageinfo", first], { encoding: "utf8" }).stdout;
  assert.match(format, /^Format: UDZO$/m, "a compressed read-only image");
  const contents = dmgContents(first);
  assert.deepEqual(contents.entries, [".DS_Store", "Applications", "Ash.app"], "the app, a link to drop it on, the Finder layout — nothing else");
  assert.equal(contents.applications, "/Applications");
  assert.deepEqual(contents.layout, readFileSync(join(mac, "dmg/DS_Store")), "the checked-in layout");
  assert.equal(contents.binary, "binary 20000101.0001", "the app that was given");
  const signature = appcast().match(/sparkle:edSignature="([^"]+)"/)[1];
  assert.equal(verify(first, signature), 0, "the dmg verifies against the signature in the appcast");
  assert.equal(verify(join(feed, "appcast.xml")), 0, "the appcast itself is signed");
  assert.match(appcast(), /url="http:\/\/127\.0\.0\.1:1\/Ash-0\.2\.0-20000101\.0001\.dmg"/);
  assert.equal(Number(appcast().match(/length="(\d+)"/)[1]), readFileSync(first).length);

  result = release(fakeApp("20000101.0001", key.publicKey), key.file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /已经发过了/);
  result = release(fakeApp("20000101.0000", key.publicKey), key.file);
  assert.match(result.stderr, /不比 appcast 里最新的 20000101\.0001 新/);
  result = release(fakeApp("20000101.0002", key.publicKey), wrong.file);
  assert.match(result.stderr, /不是一对/, "an app whose key does not match the signing key is never published");

  result = release(fakeApp("20000101.0002", key.publicKey), key.file, "第二版");
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const versions = [...appcast().matchAll(/<sparkle:version>([^<]+)<\/sparkle:version>/g)].map((m) => m[1]);
  assert.deepEqual(versions, ["20000101.0002", "20000101.0001"], "newest first, the earlier item kept");
  assert.equal(appcast().match(/sparkle:edSignature="([^"]+)"/g).length, 2);
  assert.equal(verify(join(feed, "appcast.xml")), 0, "re-signed after adding the item");
  const descriptions = [...appcast().matchAll(/<description>([^<]*)<\/description>/g)].map((m) => unescapeXml(m[1]));
  assert.deepEqual(descriptions, ["<p>第二版</p>", "<p>演练</p>"], "--notes reaches the appcast");

  const second = join(feed, "Ash-0.2.0-20000101.0002.dmg");
  const newest = appcast().match(/sparkle:edSignature="([^"]+)"/)[1];
  flipByte(second);
  assert.notEqual(verify(second, newest), 0, "a tampered dmg fails verification");
  writeFileSync(join(feed, "appcast.xml"), appcast().replace("20000101.0002</sparkle:version>", "20990101.0002</sparkle:version>"));
  assert.notEqual(verify(join(feed, "appcast.xml")), 0, "a tampered appcast fails verification");

  // 同一构建号：上次封的 dmg 来自另一份 app → 拒发
  const cached = join(artifacts, "v0.2.0-20990101.0003");
  mkdirSync(cached, { recursive: true });
  writeFileSync(join(cached, "Ash-0.2.0-20990101.0003.dmg"), "dmg of some other build");
  writeFileSync(join(cached, "Ash-0.2.0-20990101.0003.dmg.source"), "0000\n");
  result = release(fakeApp("20990101.0003", key.publicKey), key.file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /是上次从另一份 app 封的/, "a cached dmg of a different app is never signed for this one");
  // 同一份 app 没发完重跑 → 原样沿用上次那个 dmg（重封出来字节不同，已传上去的签名就对不上了）
  const again = fakeApp("20990101.0004", key.publicKey);
  result = release(again, key.file, "演练", join(temporary, "feed-a"));
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  result = release(again, key.file, "演练", join(temporary, "feed-b"));
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /沿用上次没发完的/);
  const name = "Ash-0.2.0-20990101.0004.dmg";
  assert.deepEqual(readFileSync(join(temporary, "feed-b", name)), readFileSync(join(temporary, "feed-a", name)), "the very same bytes");
  console.log("PASS: release --local ships only a signed drag-to-install dmg; refuses re-releases, older versions and mismatched keys; tampering is detected; notes kept; cached dmg bound to its app and reused for it");
}

/**
 * 本地假 GitHub：只认 `Bearer test-token`，记下每个请求。push 是账号对仓库的权限（仓库信息里的
 * permissions.push），token 是这张凭证真写得了的仓库（缺省同 push）；commits 是装包仓库里有的提交，
 * tags 是已有的 tag，rules / protectedBranches 是清单分支上的限制，feedPut 是提交 appcast 时回的状态。
 * drafts 是事先就在的草稿（[{ tag, target }]），newer 是排在它们前面的别的 Release 数（列表按页给，每页 100）。
 * 草稿的附件只能经 API 下，公开之后才有公开地址。
 */
async function fakeGitHub({ push, token = push, commits = {}, tags = {}, rules = [], protectedBranch = false, feedPut = 200, drafts = [], newer = 0 }) {
  const state = { calls: [], files: new Map(), releases: [], downloads: new Map(), assets: new Map(), tags: { ...tags }, feedPut };
  let base = "";
  let ids = 0;
  for (const draft of drafts) {
    ids++;
    state.releases.push({ id: ids, repo: "o/app", tag_name: draft.tag, target: draft.target, draft: true, assets: [], upload_url: `PLACEHOLDER/uploads/${ids}{?name,label}` });
  }
  const others = Array.from({ length: newer }, (_, i) => ({ id: 10000 + i, repo: "o/app", tag_name: `other-${i}`, draft: false, assets: [] }));
  const publicUrl = (release, name) => `${base}/download/${release.repo}/${release.tag_name}/${name}`;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    const json = (status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && state.downloads.has(url.pathname)) return res.end(state.downloads.get(url.pathname));
    state.calls.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== "Bearer test-token") return json(401, { message: "Bad credentials" });
    if (req.method === "GET" && state.assets.has(url.pathname)) return res.end(state.assets.get(url.pathname));
    if (req.method === "POST" && url.pathname.startsWith("/uploads/")) {
      const release = state.releases.find((r) => r.id === Number(url.pathname.split("/")[2]));
      const name = url.searchParams.get("name");
      const asset = { id: ++ids, name, size: body.length, contentType: req.headers["content-type"], url: `${base}/assets/${ids}`,
        browser_download_url: release.draft ? `${base}/download/${release.repo}/untagged-${release.id}/${name}` : publicUrl(release, name) };
      state.assets.set(`/assets/${ids}`, body);
      if (!release.draft) state.downloads.set(new URL(asset.browser_download_url).pathname, body);
      release.assets.push(asset);
      return json(201, asset);
    }
    const route = url.pathname.match(/^\/repos\/(o\/(?:app|feed))(\/.*)?$/);
    if (!route) return json(404, {});
    const [, repo, rest = ""] = route;
    if (req.method === "GET" && rest === "") return json(200, { default_branch: "main", permissions: { push: push.includes(repo) } });
    if (req.method === "POST" && rest === "/git/blobs") return token.includes(repo) ? json(201, { sha: "b".repeat(40) }) : json(403, { message: "Resource not accessible by personal access token" });
    if (req.method === "GET" && rest === "/branches/main") return json(200, { name: "main", protected: repo === "o/feed" && protectedBranch });
    if (req.method === "GET" && rest === "/rules/branches/main") return json(200, repo === "o/feed" ? rules : []);
    const commit = rest.match(/^\/commits\/(.+)$/);
    if (commit && req.method === "GET") return repo === "o/app" && commits[commit[1]] ? json(200, { sha: commits[commit[1]] }) : json(422, {});
    const tag = rest.match(/^\/git\/ref\/tags\/(.+)$/);
    if (tag && req.method === "GET") {
      const sha = state.tags[`${repo}:${decodeURIComponent(tag[1])}`];
      return sha ? json(200, { object: { type: "commit", sha } }) : json(404, {});
    }
    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents) {
      const path = `${repo}:${decodeURIComponent(contents[1])}`;
      const file = state.files.get(path);
      if (req.method === "GET") return file ? json(200, { sha: file.sha, encoding: "base64", content: Buffer.from(file.text).toString("base64") }) : json(404, {});
      if (state.feedPut !== 200) return json(state.feedPut, { message: "Resource not accessible by personal access token" });
      const put = JSON.parse(body);
      if (file?.sha !== put.sha) return json(409, { message: "sha does not match" });
      const sha = createHash("sha1").update(put.content).digest("hex");
      state.files.set(path, { sha, text: Buffer.from(put.content, "base64").toString("utf8"), branch: put.branch, message: put.message });
      return json(200, { content: { sha } });
    }
    if (req.method === "GET" && rest.startsWith("/releases/tags/")) {
      const found = state.releases.find((r) => r.repo === repo && !r.draft && r.tag_name === decodeURIComponent(rest.split("/").pop()));
      return found ? json(200, found) : json(404, {});
    }
    if (req.method === "GET" && rest === "/releases") {
      const page = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("per_page") || 30);
      const all = [...(repo === "o/app" ? others : []), ...state.releases.filter((r) => r.repo === repo)];
      return json(200, all.slice((page - 1) * size, page * size));
    }
    if (req.method === "POST" && rest === "/releases") {
      const { tag_name: tagName, target_commitish: target, name, body: notes, draft } = JSON.parse(body);
      const created = { id: ++ids, repo, tag_name: tagName, target, name, body: notes, draft, assets: [], upload_url: `${base}/uploads/${ids}{?name,label}` };
      state.releases.push(created);
      return json(201, created);
    }
    const patch = rest.match(/^\/releases\/(\d+)$/);
    if (patch && req.method === "PATCH") {
      const release = state.releases.find((r) => r.id === Number(patch[1]));
      const change = JSON.parse(body);
      release.draft = change.draft;
      release.target = change.target_commitish ?? release.target;
      // 公开时按（这一下写进来的）目标打 tag，已有就沿用；附件换成公开地址。退回草稿时公开地址作废。
      if (!release.draft) state.tags[`${repo}:${release.tag_name}`] ??= release.target;
      for (const asset of release.assets) {
        state.downloads.delete(new URL(asset.browser_download_url).pathname);
        asset.browser_download_url = release.draft ? `${base}/download/${repo}/untagged-${release.id}/${asset.name}` : publicUrl(release, asset.name);
        if (!release.draft) state.downloads.set(new URL(asset.browser_download_url).pathname, state.assets.get(new URL(asset.url).pathname));
      }
      return json(200, release);
    }
    json(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  for (const release of state.releases) release.upload_url = release.upload_url.replace("PLACEHOLDER", base);
  return { state, base, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) };
}

/** README 所在的临时仓库：一个提交，README 里带下载链接的那对标记，外加一个不相干的未提交改动。 */
function readmeRepo() {
  const dir = join(temporary, "readme-repo");
  mkdirSync(dir, { recursive: true });
  const git = (...args) => {
    const out = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: cleanEnv });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(dir, "README.md"), "# ash\n\n## 下载 mac 版\n\n<!-- ash-mac-download -->\n第一版还没发布。\n<!-- /ash-mac-download -->\n\n装法……\n");
  writeFileSync(join(dir, "other.txt"), "committed\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  writeFileSync(join(dir, "other.txt"), "someone else's uncommitted change\n");
  return { readme: join(dir, "README.md"), git };
}

async function formalRehearsal() {
  const configFile = join(temporary, "release.json");
  const config = { releaseRepo: "o/app", feedRepo: "o/feed", feedBranch: "main", appcastPath: "ash/mac/appcast.xml",
    tagPrefix: "ash-mac-v", keychainAccount: "unused", publicKey: key.publicKey };
  const feed = "https://raw.githubusercontent.com/o/feed/main/ash/mac/appcast.xml";
  const { readme, git } = readmeRepo();
  const publish = async (github, app, { conf = config, artifacts = "formal-artifacts" } = {}) => new Promise((done) => {
    writeFileSync(configFile, JSON.stringify(conf));
    const child = spawn(process.execPath, [releaseScript, "--app", app, "--ed-key-file", key.file, "--notes", "正式 & <b>演练</b>"], {
      env: { ...cleanEnv, GH_TOKEN: "test-token", GITHUB_TOKEN: "", ASH_MAC_GITHUB_API: github.base,
        ASH_MAC_RELEASE_CONFIG: configFile, ASH_MAC_RELEASE_ARTIFACTS: join(temporary, artifacts), ASH_MAC_README: readme },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("close", (status) => done({ status, out }));
  });
  // 写操作里去掉预检那几个看不见的 blob（证明 token 写得了用的）。
  const writes = (github) => github.state.calls.filter((c) => !c.startsWith("GET") && !c.endsWith("/git/blobs"));
  const sha = "abc1234".padEnd(40, "0");
  const app = fakeApp("20000102.0001", key.publicKey, { feed, commit: "abc1234" });
  const both = ["o/app", "o/feed"];
  const refused = async (options, pattern, why, target = app, conf = config) => {
    const github = await fakeGitHub({ push: both, commits: { abc1234: sha }, ...options });
    const result = await publish(github, target, { conf, artifacts: "refused-artifacts" });
    await github.close();
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, pattern, why);
    assert.deepEqual(writes(github), [], `nothing is written: ${why}`);
    assert.deepEqual(github.state.releases, []);
    return github;
  };

  for (const token of [["o/app"], ["o/feed"], []]) {
    const github = await refused({ token }, /没有写权限[\s\S]*缺一样就一样都不传/,
      `the account can push to both, but the token can write only ${token.join(",") || "neither"}`);
    assert.ok(github.state.calls.includes("POST /repos/o/app/git/blobs"), "write access is proven by writing, not read off the repo info");
  }
  await refused({ push: ["o/app"], token: both }, /o\/feed 没有写权限/, "the account cannot push to the feed repo");
  await refused({ rules: [{ type: "deletion" }, { type: "pull_request" }] }, /ruleset 规则 pull_request/, "the feed branch only takes pull requests");
  await refused({ protectedBranch: true }, /开着分支保护/, "the feed branch is protected");
  await refused({ commits: {} }, /还没有提交 abc1234.*先 git push/, "the build commit is not pushed");
  await refused({ tags: { "o/app:ash-mac-v0.2.0-20000102.0001": "f".repeat(40) } }, /已经有 tag .*不是这份 app 的构建提交/, "a same-named tag points elsewhere");
  await refused({}, /没记构建提交/, "the app does not know its build commit", fakeApp("20000102.0002", key.publicKey, { feed }));
  await refused({}, /旧格式/, "a single-repo config is refused, not guessed", app, { ...config, repo: "o/feed" });

  // 预检都过、提交 appcast 时才被拒（比如权限在这期间被收回）：公开不撤回 —— 撤回之前要确认没有哪份
  // appcast 引用它，而读和撤之间别的发版进程可能刚提交了 appcast。只靠重跑往前补完。
  let github = await fakeGitHub({ push: both, commits: { abc1234: sha }, feedPut: 403 });
  let result = await publish(github, app);
  assert.notEqual(result.status, 0, result.out);
  assert.match(result.out, /appcast 没提交上/);
  assert.match(result.out, /公开不撤回/);
  const id = github.state.releases[0].id;
  assert.deepEqual(writes(github), ["POST /repos/o/app/releases", `POST /uploads/${id}`, `PATCH /repos/o/app/releases/${id}`,
    "PUT /repos/o/feed/contents/ash/mac/appcast.xml"], "draft, upload, publish, appcast refused — and nothing is taken back");
  assert.equal(github.state.releases[0].draft, false, "the release stays public");
  assert.equal(github.state.files.size, 0);
  // 修好后重跑：认出已公开的 Release 和上面的包，只补 appcast。
  github.state.calls.length = 0;
  github.state.feedPut = 200;
  result = await publish(github, app);
  await github.close();
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /沿用 o\/app 里已有的 Release/);
  assert.deepEqual(writes(github), ["PUT /repos/o/feed/contents/ash/mac/appcast.xml"], "no second release, no second upload, no second publish");
  assert.equal(github.state.releases.length, 1);
  console.log("PASS: when the appcast is refused after the release went public, the release stays public and a rerun only adds the appcast");

  // 沿用一个旧草稿：它排在 150 个更新的 Release 后面（第二页），还记着别的提交、没有 tag。
  github = await fakeGitHub({ push: both, commits: { abc1234: sha }, drafts: [{ tag: "ash-mac-v0.2.0-20000102.0001", target: "e".repeat(40) }], newer: 150 });
  result = await publish(github, app, { artifacts: "draft-artifacts" });
  await github.close();
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /沿用 o\/app 里已有的草稿 Release/, "the draft is found past the first page");
  assert.deepEqual(writes(github).filter((c) => c.startsWith("POST /repos")), [], "no second release is created");
  assert.equal(github.state.tags["o/app:ash-mac-v0.2.0-20000102.0001"], sha, "publishing writes this build's commit as the target, so the tag lands on it");
  console.log("PASS: an old draft is found on a later page and published with this build's commit as its tag");

  const initial = git("rev-list", "--max-parents=0", "HEAD");
  git("reset", "-q", "--hard", initial);
  writeFileSync(join(dirname(readme), "other.txt"), "someone else's uncommitted change\n");
  github = await fakeGitHub({ push: both, commits: { abc1234: sha } });
  result = await publish(github, app, { artifacts: "formal-artifacts-2" });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /GitHub 凭证：GH_TOKEN/);
  const [release] = github.state.releases;
  assert.deepEqual(writes(github), ["POST /repos/o/app/releases", `POST /uploads/${release.id}`, `PATCH /repos/o/app/releases/${release.id}`,
    "PUT /repos/o/feed/contents/ash/mac/appcast.xml"], "release and dmg go to the app repo (as a draft, then public), then the appcast to the feed repo");
  assert.ok(github.state.calls.includes(`GET /assets/${release.assets[0].id}`), "the uploaded dmg is read back before the release goes public");
  assert.equal(release.target, sha, "the tag is created on the commit the app was built from");
  assert.equal(github.state.tags["o/app:ash-mac-v0.2.0-20000102.0001"], sha);
  assert.match(release.name, /macOS/);
  assert.equal(release.assets[0].name, "Ash-0.2.0-20000102.0001.dmg");
  assert.equal(release.assets[0].contentType, "application/x-apple-diskimage");
  assert.ok(release.body.startsWith("正式 & <b>演练</b>\n\n"), "the release body starts with the notes as given");
  const committed = github.state.files.get("o/feed:ash/mac/appcast.xml");
  assert.equal(committed.branch, "main");
  assert.match(committed.text, /<sparkle:version>20000102\.0001<\/sparkle:version>/);
  const url = `${github.base}/download/o/app/ash-mac-v0.2.0-20000102.0001/Ash-0.2.0-20000102.0001.dmg`;
  assert.ok(committed.text.includes(`url="${url}"`), "the appcast in the feed repo points at the public dmg in the app repo");
  writeFileSync(join(temporary, "committed-appcast.xml"), committed.text);
  assert.equal(verify(join(temporary, "committed-appcast.xml")), 0, "the committed appcast is signed");
  writeFileSync(join(temporary, "uploaded.dmg"), github.state.downloads.get(new URL(url).pathname));
  assert.equal(verify(join(temporary, "uploaded.dmg"), committed.text.match(/sparkle:edSignature="([^"]+)"/)[1]), 0, "the public dmg matches its signature");
  assert.equal(unescapeXml(committed.text.match(/<description>([^<]*)<\/description>/)[1]), "<p>正式 &amp; &lt;b&gt;演练&lt;/b&gt;</p>",
    "in the appcast the notes are HTML-escaped");

  const link = `<!-- ash-mac-download -->\n**[下载 ash 0.2.0（20000102.0001）](${url})**\n<!-- /ash-mac-download -->`;
  assert.ok(readFileSync(readme, "utf8").includes(link), "the README download link names this very dmg");
  assert.match(result.out, /README 的下载链接已改成这一版并提交/);
  assert.equal(git("log", "-1", "--format=%s"), "docs(README): mac 版下载指向 0.2.0（20000102.0001）");
  assert.equal(git("show", "--name-only", "--format=", "HEAD"), "README.md", "only the README is committed");
  assert.equal(git("status", "--porcelain"), "M other.txt", "someone else's change stays uncommitted");
  console.log("PASS: a formal release proves write access to both repos and a pushed, untagged-elsewhere build commit before writing anything; then a draft release, upload, read-back, publish, the signed appcast in the feed repo, and only the README link committed locally");

  // 全都发完了、只是 README 没提交上（这里把那个提交撤掉来模拟）：重跑只补 README，不再碰 GitHub。
  git("reset", "-q", "--hard", initial);
  writeFileSync(join(dirname(readme), "other.txt"), "someone else's uncommitted change\n");
  assert.ok(readFileSync(readme, "utf8").includes("第一版还没发布"));
  github.state.calls.length = 0;
  result = await publish(github, app, { artifacts: "formal-artifacts-2" });
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /appcast 里已经是这个包：只补没做完的收尾/);
  assert.deepEqual(writes(github), [], "nothing is written to GitHub again");
  assert.ok(readFileSync(readme, "utf8").includes(link), "the README link is filled in");
  assert.equal(git("log", "-1", "--format=%s"), "docs(README): mac 版下载指向 0.2.0（20000102.0001）");

  // 再发一版，README 指向它；之后补旧版的收尾不把 README 倒回旧版。
  result = await publish(github, fakeApp("20000102.0003", key.publicKey, { feed, commit: "abc1234" }), { artifacts: "formal-artifacts-2" });
  assert.equal(result.status, 0, result.out);
  assert.equal(git("log", "-1", "--format=%s"), "docs(README): mac 版下载指向 0.2.0（20000102.0003）");
  github.state.calls.length = 0;
  result = await publish(github, app, { artifacts: "formal-artifacts-2" });
  await github.close();
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /README 的下载链接留在更新的 20000102\.0003/);
  assert.deepEqual(writes(github), []);
  assert.equal(git("log", "-1", "--format=%s"), "docs(README): mac 版下载指向 0.2.0（20000102.0003）", "the README keeps the newer version");
  console.log("PASS: rerunning a fully published version only finishes the README link, and never moves it back to an older version");
}

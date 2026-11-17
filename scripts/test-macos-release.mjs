// mac 发版脚本（desktop/macos/scripts/release.mjs）的定点回归（仅 macOS）。不碰 GitHub、不碰钥匙串：
// 用现生成的演练密钥和一个假的 Ash.app。
//
// 本地演练（--local）：只出 dmg 不出 zip；dmg 是只读压缩镜像，卷里是 Ash.app（就是给的那份）、指向
// /Applications 的软链和入库的 Finder 布局；dmg 与 appcast 都验得过签、被篡改的（长度不变地改一个字节）
// dmg 和 appcast 验不过；同一版、更旧的版本拒发；app 里的公钥和签名私钥不是一对时拒发；第二版排在第一
// 版前面、第一版原样保留；`--notes` 进 appcast（转义过）；同一构建号缓存的 dmg 来自另一份 app 时拒发，
// 来自同一份时原样沿用。
//
// 正式发版对着一个本地假 GitHub 跑（两个仓库：o/app 放安装包，o/feed 放 appcast）：只对其中一个有写权限
// 时什么都不传；构建提交还没推到装包仓库时什么都不传；都齐了就在 o/app 建 Release（tag 打在构建提交上）、
// 传 dmg，再把 appcast 提交进 o/feed，appcast 里的下载地址指向 o/app 的那个附件；最后把（临时仓库里的）
// README 下载链接改成这个 dmg、只提交 README。旧格式（只有一个 repo）的配置拒绝。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

try {
  await localRehearsal();
  await formalRehearsal();
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

/** 本地假 GitHub：只认 `Bearer test-token`；记下每个请求。push 列出这张凭证能写的仓库，commits 是装包仓库里有的提交。 */
async function fakeGitHub({ push, commits = {} }) {
  const state = { calls: [], files: new Map(), releases: [], downloads: new Map() };
  let base = "";
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, base);
    const json = (status, value) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.method === "GET" && state.downloads.has(url.pathname)) return res.end(state.downloads.get(url.pathname));
    state.calls.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== "Bearer test-token") return json(401, { message: "Bad credentials" });
    const route = url.pathname.match(/^\/repos\/(o\/(?:app|feed))(\/.*)?$/);
    if (!route) {
      if (req.method === "POST" && url.pathname.startsWith("/uploads/")) {
        const parts = url.pathname.split("/");
        const repo = `${parts[2]}/${parts[3]}`;
        const tag = parts[4];
        const name = url.searchParams.get("name");
        const asset = { name, size: body.length, contentType: req.headers["content-type"], browser_download_url: `${base}/download/${repo}/${tag}/${name}` };
        state.downloads.set(`/download/${repo}/${tag}/${name}`, body);
        state.releases.find((r) => r.repo === repo && r.tag_name === tag).assets.push(asset);
        return json(201, asset);
      }
      return json(404, {});
    }
    const [, repo, rest = ""] = route;
    if (req.method === "GET" && rest === "") return json(200, { default_branch: "main", permissions: { push: push.includes(repo) } });
    const commit = rest.match(/^\/commits\/(.+)$/);
    if (commit && req.method === "GET") return repo === "o/app" && commits[commit[1]] ? json(200, { sha: commits[commit[1]] }) : json(422, {});
    const contents = rest.match(/^\/contents\/(.+)$/);
    if (contents) {
      const path = `${repo}:${decodeURIComponent(contents[1])}`;
      const file = state.files.get(path);
      if (req.method === "GET") return file ? json(200, { sha: file.sha, encoding: "base64", content: Buffer.from(file.text).toString("base64") }) : json(404, {});
      const put = JSON.parse(body);
      if (file?.sha !== put.sha) return json(409, { message: "sha does not match" });
      const sha = createHash("sha1").update(put.content).digest("hex");
      state.files.set(path, { sha, text: Buffer.from(put.content, "base64").toString("utf8"), branch: put.branch, message: put.message });
      return json(200, { content: { sha } });
    }
    if (req.method === "GET" && rest.startsWith("/releases/tags/")) {
      const found = state.releases.find((r) => r.repo === repo && r.tag_name === decodeURIComponent(rest.split("/").pop()));
      return found ? json(200, found) : json(404, {});
    }
    if (req.method === "POST" && rest === "/releases") {
      const { tag_name: tag, target_commitish: target, name, body: notes } = JSON.parse(body);
      const created = { repo, tag_name: tag, target, name, body: notes, assets: [], upload_url: `${base}/uploads/${repo}/${tag}{?name,label}` };
      state.releases.push(created);
      return json(201, created);
    }
    json(404, {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
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
  const publish = async (github, app, conf = config) => new Promise((done) => {
    writeFileSync(configFile, JSON.stringify(conf));
    const child = spawn(process.execPath, [releaseScript, "--app", app, "--ed-key-file", key.file, "--notes", "正式 & <b>演练</b>"], {
      env: { ...cleanEnv, GH_TOKEN: "test-token", GITHUB_TOKEN: "", ASH_MAC_GITHUB_API: github.base,
        ASH_MAC_RELEASE_CONFIG: configFile, ASH_MAC_RELEASE_ARTIFACTS: join(temporary, "formal-artifacts"), ASH_MAC_README: readme },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("close", (status) => done({ status, out }));
  });
  const writes = (github) => github.state.calls.filter((c) => !c.startsWith("GET"));
  const sha = "abc1234".padEnd(40, "0");
  const app = fakeApp("20000102.0001", key.publicKey, { feed, commit: "abc1234" });

  for (const push of [["o/app"], ["o/feed"], []]) {
    const github = await fakeGitHub({ push, commits: { abc1234: sha } });
    const result = await publish(github, app);
    await github.close();
    assert.notEqual(result.status, 0, result.out);
    assert.match(result.out, /没有写权限/);
    assert.match(result.out, /缺一样就一样都不传/);
    assert.deepEqual(writes(github), [], `nothing is published when the credential can write only ${push.join(",") || "neither"}`);
  }

  let github = await fakeGitHub({ push: ["o/app", "o/feed"], commits: {} });
  let result = await publish(github, app);
  await github.close();
  assert.notEqual(result.status, 0, result.out);
  assert.match(result.out, /还没有提交 abc1234.*先 git push/);
  assert.deepEqual(writes(github), [], "an unpushed build commit stops the release before anything is written");

  github = await fakeGitHub({ push: ["o/app", "o/feed"] });
  result = await publish(github, app, { ...config, repo: "o/feed" });
  await github.close();
  assert.match(result.out, /旧格式/, "a single-repo config is refused, not guessed");
  assert.deepEqual(github.state.calls, []);

  github = await fakeGitHub({ push: ["o/app", "o/feed"], commits: { abc1234: sha } });
  result = await publish(github, app);
  await github.close();
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /GitHub 凭证：GH_TOKEN/);
  assert.deepEqual(writes(github), ["POST /repos/o/app/releases", "POST /uploads/o/app/ash-mac-v0.2.0-20000102.0001", "PUT /repos/o/feed/contents/ash/mac/appcast.xml"],
    "release and dmg go to the app repo, then the appcast to the feed repo — all through the API with the one token");
  const [release] = github.state.releases;
  assert.equal(release.target, sha, "the tag points at the commit the app was built from");
  assert.match(release.name, /macOS/);
  assert.equal(release.assets[0].name, "Ash-0.2.0-20000102.0001.dmg");
  assert.equal(release.assets[0].contentType, "application/x-apple-diskimage");
  assert.ok(release.body.startsWith("正式 & <b>演练</b>\n\n"), "the release body starts with the notes as given");
  const committed = github.state.files.get("o/feed:ash/mac/appcast.xml");
  assert.equal(committed.branch, "main");
  assert.match(committed.text, /<sparkle:version>20000102\.0001<\/sparkle:version>/);
  const url = `${github.base}/download/o/app/ash-mac-v0.2.0-20000102.0001/Ash-0.2.0-20000102.0001.dmg`;
  assert.ok(committed.text.includes(`url="${url}"`), "the appcast in the feed repo points at the dmg in the app repo");
  writeFileSync(join(temporary, "committed-appcast.xml"), committed.text);
  assert.equal(verify(join(temporary, "committed-appcast.xml")), 0, "the committed appcast is signed");
  writeFileSync(join(temporary, "uploaded.dmg"), github.state.downloads.get(new URL(url).pathname));
  assert.equal(verify(join(temporary, "uploaded.dmg"), committed.text.match(/sparkle:edSignature="([^"]+)"/)[1]), 0, "the uploaded dmg matches its signature");
  assert.equal(unescapeXml(committed.text.match(/<description>([^<]*)<\/description>/)[1]), "<p>正式 &amp; &lt;b&gt;演练&lt;/b&gt;</p>",
    "in the appcast the notes are HTML-escaped");

  assert.ok(readFileSync(readme, "utf8").includes(`<!-- ash-mac-download -->\n**[下载 ash 0.2.0（20000102.0001）](${url})**\n<!-- /ash-mac-download -->`),
    "the README download link names this very dmg");
  assert.match(result.out, /README 的下载链接已改成这一版并提交/);
  assert.equal(git("log", "-1", "--format=%s"), "docs(README): mac 版下载指向 0.2.0（20000102.0001）");
  assert.equal(git("show", "--name-only", "--format=", "HEAD"), "README.md", "only the README is committed");
  assert.equal(git("status", "--porcelain"), "M other.txt", "someone else's change stays uncommitted");
  console.log("PASS: a formal release needs write access to both repos and a pushed build commit before writing anything; then the dmg goes to the app repo, the signed appcast to the feed repo, and only the README link is committed locally");
}

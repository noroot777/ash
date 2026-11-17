#!/usr/bin/env node
// 发一版 mac app：构建独立 app → 封 dmg → EdDSA 签名 → 在装包仓库（release.json 的 releaseRepo）建
// GitHub Release、传 dmg → 更新 appcast.xml（整份也签过）→ 经 GitHub API 提交进清单仓库（feedRepo）→
// 把仓库根 README 的下载链接改成这个 dmg、只在本地提交。已装的 app 定时拉那份 appcast，看到新版就提示
// 安装；同一个 dmg 也是新用户下载安装的那个。读写 GitHub 全程只用一张凭证，开传之前先确认它对两个仓库
// 都有写权限。
//
//   npm run release:mac                         # 正式发版（要先 --keys 做过一次）
//   npm run release:mac -- --keys               # 生成 / 读出正式 EdDSA 密钥，公钥写进 release.json
//   npm run release:mac -- --init-repo          # release.json 里的仓库还不存在时建它们（公开）
//   npm run release:mac -- --local <目录> --app <Ash.app> --ed-key-file <私钥文件>
//                                               # 演练：dmg 和 appcast 写进本地目录，不碰 GitHub、不碰 README
//
// 其它选项：--app <Ash.app> 用现成的构建（不重新 build）；--notes <文字> 换掉自动生成的更新说明。
//
// 几条不变量（README「发版」里有为什么）：
//  · 发出去的 app 里的公钥必须就是签这一版的私钥对应的那把 —— 对不上直接拒，发出去谁都装不上。
//  · 版本号（CFBundleVersion）必须比 appcast 里最新的一版大；正式发版要求工作区干净（发出去的包
//    对得上一个提交）。
//  · 两个仓库任何一个写不了，一个字节都不传：包传上去了 appcast 却改不了，或者反过来，都是半截的发版。
//  · 先传 dmg、确认下得下来，再推 appcast：feed 永远不指向一个还不存在的包。没发完重跑时，同
//    一版沿用上次封好的 dmg（重封出来的字节不同，签名就和已传上去的那份对不上了）—— 但只在
//    这次给的 app 和封那个 dmg 的是同一份时（旁边记着 app 的内容摘要），不是就拒发。
//  · Release 的 tag 打在构建这份 app 的那个提交上，所以那个提交要先推到装包仓库。
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareVersions, latestVersion, parseItems, previousCommit, renderAppcast, renderItem } from "./appcast.mjs";
import { commitLink, LINK_COMMIT_PREFIX } from "./download-link.mjs";
import { GitHub, NO_TOKEN_HINT, resolveToken } from "./github.mjs";
import { ensureSparkle } from "./sparkle.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAC = resolve(HERE, "..");
const REPO = resolve(MAC, "../..");
// ASH_MAC_RELEASE_CONFIG 只给回归测试换一份发版配置（配合 github.mjs 的 ASH_MAC_GITHUB_API 演练正式发版）。
const CONFIG_PATH = process.env.ASH_MAC_RELEASE_CONFIG || join(MAC, "release.json");
// ASH_MAC_README 同理：换掉发完要改下载链接的那份 README（测试指向一个临时仓库）。
const README = process.env.ASH_MAC_README || join(REPO, "README.md");

const say = (line) => process.stdout.write(`${line}\n`);
class Stop extends Error {}
const die = (line) => { throw new Stop(line); };

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...opts });
  if (result.status !== 0) {
    die(`${command} ${args.join(" ")} 失败（${result.status ?? result.signal}）\n${result.stderr || ""}${result.stdout || ""}`.trim());
  }
  return (result.stdout || "").trim();
}

/** 私钥文件（generate_keys -x 导出的那种：base64 的 32 字节种子，或旧版 96 字节）对应的公钥。 */
function publicKeyOfKeyFile(file) {
  const raw = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  if (raw.length === 96) return raw.subarray(64).toString("base64");
  if (raw.length !== 32 && raw.length !== 64) die(`${file} 不像 EdDSA 私钥（${raw.length} 字节）`);
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw.subarray(0, 32)]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  return Buffer.from(jwk.x, "base64url").toString("base64");
}

function readConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  if (config.repo) die(`${CONFIG_PATH} 还是只有一个 repo 的旧格式：拆成 releaseRepo（放安装包的 Release）和 feedRepo（放 appcast）。`);
  for (const key of ["releaseRepo", "feedRepo"]) if (!config[key]) die(`${CONFIG_PATH} 里缺 ${key}`);
  return { feedBranch: "main", appcastPath: "appcast.xml", tagPrefix: "v", ...config };
}

const feedOf = (config) => `https://raw.githubusercontent.com/${config.feedRepo}/${config.feedBranch}/${config.appcastPath}`;

function infoOf(app) {
  const plist = join(app, "Contents", "Info.plist");
  if (!existsSync(plist)) die(`${plist} 不存在`);
  return JSON.parse(run("plutil", ["-convert", "json", "-o", "-", plist]));
}

async function main() {
  const { values } = parseArgs({
    options: {
      local: { type: "string" },
      app: { type: "string" },
      "ed-key-file": { type: "string" },
      notes: { type: "string" },
      keys: { type: "boolean" },
      "init-repo": { type: "boolean" },
    },
  });
  const config = readConfig();
  const sparkle = await ensureSparkle();
  const tool = (name) => join(sparkle, "bin", name);
  const keyArgs = values["ed-key-file"] ? ["--ed-key-file", resolve(values["ed-key-file"])] : ["--account", config.keychainAccount];

  if (values.keys) return makeKeys(config, tool);

  const local = values.local ? resolve(values.local) : null;
  let github = null;
  if (!local) {
    if (!config.publicKey) die("release.json 里还没有 publicKey：先跑一次 npm run release:mac -- --keys");
    const auth = resolveToken();
    if (!auth) die(NO_TOKEN_HINT);
    say(`▶ GitHub 凭证：${auth.source}`);
    github = new GitHub(auth.token);
    const repos = [...new Set([config.releaseRepo, config.feedRepo])];
    if (values["init-repo"]) return initRepos(repos, github);
    const missing = [];
    for (const repo of repos) if (!(await github.repoExists(repo))) missing.push(repo);
    if (missing.length) die(`${missing.join("、")} 还不存在：先跑一次 npm run release:mac -- --init-repo`);
    // 传附件和改 appcast 用的是同一张凭证、写的是两个仓库：在对外放出任何东西之前确认两样都做得了。
    const readOnly = [];
    for (const repo of repos) if (!(await github.canPush(repo))) readOnly.push(repo);
    if (readOnly.length) {
      die(`这张凭证（${auth.source}）对 ${readOnly.join("、")} 没有写权限：安装包要传到 ${config.releaseRepo}、`
        + `appcast 要提交进 ${config.feedRepo}，缺一样就一样都不传。\n${NO_TOKEN_HINT}`);
    }
  }

  // ── 1. 这次要发的 app ──
  let app = values.app ? resolve(values.app) : join(MAC, "build", "Ash.app");
  if (!values.app) {
    if (run("git", ["status", "--porcelain"], { cwd: REPO })) die("工作区有没提交的改动：正式发版要从干净的提交构建（发出去的包要对得上一个提交）。");
    say("▶ 构建独立 app");
    const build = spawnSync("bash", [join(MAC, "build.sh")], { stdio: "inherit" });
    if (build.status !== 0) die("构建失败");
    app = join(MAC, "build", "Ash.app");
  }
  const info = infoOf(app);
  const version = info.CFBundleVersion;
  const shortVersion = info.CFBundleShortVersionString;
  const commit = info.AshSourceCommit && info.AshSourceCommit !== "unknown" ? info.AshSourceCommit : null;

  // ── 2. 钥匙对不对 ──
  const signingKey = values["ed-key-file"]
    ? publicKeyOfKeyFile(resolve(values["ed-key-file"]))
    : run(tool("generate_keys"), ["--account", config.keychainAccount, "-p"]);
  if (!info.SUPublicEDKey) die(`${app} 里没有 SUPublicEDKey：这一份不带自更新，发出去也没人收得到下一版。`);
  if (info.SUPublicEDKey !== signingKey) {
    die(`app 里的公钥（${info.SUPublicEDKey}）和这次签名用的私钥（公钥 ${signingKey}）不是一对：发出去谁都装不上。`);
  }
  if (!local) {
    if (info.SUPublicEDKey !== config.publicKey) die("app 里的公钥和 release.json 的 publicKey 不一样：正式发版只能用 release.json 那一把。");
    const feed = feedOf(config);
    if (info.SUFeedURL !== feed) die(`app 的更新源是 ${info.SUFeedURL}，不是 ${feed}：构建时是不是设了 ASH_MAC_FEED_URL？`);
  }

  // ── 3. appcast 那一头 ──
  // 本地演练的目录就是更新源本身，appcast 放在根上；正式发版从清单仓库 appcastPath 读出现在那一版，
  // 在本地拼好、签好，最后整份提交回去（带着读出时的 sha，这期间别人改过就拒）。
  const remote = local ? null : await github.readFile(config.feedRepo, config.appcastPath, config.feedBranch);
  const appcastPath = local ? join(local, "appcast.xml") : join(MAC, "build", "release-appcast", basename(config.appcastPath));
  mkdirSync(dirname(appcastPath), { recursive: true });
  const current = local ? (existsSync(appcastPath) ? readFileSync(appcastPath, "utf8") : "") : remote?.text ?? "";
  const items = parseItems(current);
  const latest = latestVersion(items);
  if (items.some((item) => item.version === version)) die(`${version} 已经发过了（appcast 里有）。`);
  if (latest && compareVersions(version, latest) <= 0) die(`这一版 ${version} 不比 appcast 里最新的 ${latest} 新：Sparkle 不会把它当成更新。`);

  // ── 4. 封 dmg、签名 ──
  // 只出 dmg：人下载的和 Sparkle 更新用的是同一个文件（scripts/make-dmg.sh 里有格式上的取舍）。
  const tag = `${local ? "v" : config.tagPrefix}${shortVersion}-${version}`;
  // ASH_MAC_RELEASE_ARTIFACTS 只给回归测试换地方，免得演练的包落进 build/releases。
  const artifacts = join(process.env.ASH_MAC_RELEASE_ARTIFACTS || join(MAC, "build", "releases"), tag);
  mkdirSync(artifacts, { recursive: true });
  const dmg = join(artifacts, `Ash-${shortVersion}-${version}.dmg`);
  const source = `${dmg}.source`;
  const digest = appDigest(app);
  if (existsSync(dmg)) {
    const packed = existsSync(source) ? readFileSync(source, "utf8").trim() : "（没有记录）";
    if (packed !== digest) {
      die(`${dmg} 是上次从另一份 app 封的（内容摘要 ${packed}，这次是 ${digest}）：同一个构建号换了包。\n`
        + `要发这次这份就换个构建号重新构建；确定上次那份没传出去，也可以删掉 ${artifacts} 再重跑。`);
    }
    say(`▶ 沿用上次没发完的 ${dmg}`);
  } else {
    say(`▶ 封 ${dmg}`);
    // 临时名也以 .dmg 结尾（hdiutil 会给别的后缀补上 .dmg）。
    const part = join(artifacts, `.part-${basename(dmg)}`);
    run("bash", [join(HERE, "make-dmg.sh"), app, part]);
    writeFileSync(source, `${digest}\n`);
    run("mv", [part, dmg]);
  }
  const signature = run(tool("sign_update"), [...keyArgs, "-p", dmg]);
  run(tool("sign_update"), [...keyArgs, "--verify", dmg, signature]);
  const length = statSync(dmg).size;
  const dmgName = basename(dmg);
  let url = local ? new URL(dmgName, info.SUFeedURL).href : null;
  const notes = values.notes != null ? notesFromText(values.notes) : releaseNotes(items, commit);

  // ── 5. 先把包放上去 ──
  if (local) {
    copyFileSync(dmg, join(local, dmgName));
  } else {
    let release = await github.releaseByTag(config.releaseRepo, tag);
    if (!release) {
      const target = await tagTarget(github, config.releaseRepo, commit);
      say(`▶ 在 ${config.releaseRepo} 建 Release ${tag}（tag 打在 ${target.label}）`);
      release = await github.createRelease(config.releaseRepo, {
        tag, target: target.ref, name: `ash for macOS ${shortVersion}（${version}）`,
        body: `${notes.text}\n\n安装：下载 ${dmgName}，打开后把 Ash 拖进 Applications。第一次打开被系统拦住时的处理见 https://github.com/${config.releaseRepo}#下载-mac-版`,
      });
    }
    say(`▶ 传 ${dmgName}（${(length / 1048576).toFixed(1)} MB）`);
    url = (await github.uploadAsset(release, dmg)).browser_download_url;
    await confirmDownloadable(url, dmg, length);
  }

  // ── 6. 再更新 appcast ──
  const item = renderItem({
    version, shortVersion, url, length, signature, commit,
    minimumSystemVersion: info.LSMinimumSystemVersion || "14.0",
    notes: notes.html,
    pubDate: new Date(),
  });
  writeFileSync(appcastPath, renderAppcast({
    title: "ash for macOS",
    link: `https://github.com/${config.releaseRepo}`,
    items: [item, ...items.map((i) => i.xml)],
  }));
  run(tool("sign_update"), [...keyArgs, appcastPath]);
  run(tool("sign_update"), [...keyArgs, "--verify", appcastPath]);
  if (!local) {
    say(`▶ 提交 ${config.feedRepo}/${config.appcastPath}`);
    try {
      await github.writeFile(config.feedRepo, {
        path: config.appcastPath, branch: config.feedBranch, text: readFileSync(appcastPath, "utf8"), sha: remote?.sha,
        message: `ash mac ${shortVersion}（${version}）`,
      });
    } catch (error) {
      die(`appcast 没提交上：${error.message}\n包已经传好了；HTTP 409 / 422 是这期间 appcast 被别处改过，直接重跑（会沿用同一个包、重新读一遍 appcast）。`);
    }
  }
  say(`✓ 已发 ${shortVersion}（${version}）`);
  say(`  包：${url}`);
  say(`  appcast：${local ? appcastPath : feedOf(config)}`);
  if (!local) {
    say("  （raw.githubusercontent 有几分钟缓存，已装的 app 下一次定时检查或点「检查更新…」时就能看到）");
    say(`  ${commitLink(README, { url, shortVersion, version })}`);
  }
}

/**
 * Release 的 tag 打在哪：构建这份 app 的那个提交（装包仓库里得有它，没推就停在这里，此时什么都还没传）；
 * app 里没记提交（--app 给的老构建）才退回仓库的默认分支。
 */
async function tagTarget(github, repo, commit) {
  if (!commit) {
    const branch = await github.defaultBranch(repo);
    return { ref: branch, label: `${branch} 分支的最新提交（app 里没记构建提交）` };
  }
  const sha = await github.commitSha(repo, commit);
  if (!sha) die(`${repo} 里还没有提交 ${commit}（这份 app 就是从它构建的）：先 git push，再重跑（什么都还没传）。`);
  return { ref: sha, label: `构建提交 ${commit}` };
}

/** 一份 app 的内容摘要：每个文件的相对路径、可执行位、内容（软链记指向）。认「是不是同一份 app」用。 */
function appDigest(app) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(app, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) hash.update(`L ${rel} -> ${readlinkSync(path)}\n`);
      else if (stat.isDirectory()) walk(path);
      else hash.update(`F ${rel} ${stat.mode & 0o111 ? "x" : "-"} ${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
    }
  };
  walk(app);
  return hash.digest("hex");
}

/** 更新说明：上一版以来这个仓库里的提交标题（上一版的提交找不到时取最近 15 条）。 */
function releaseNotes(items, commit) {
  const since = previousCommit(items);
  const range = since && spawnSync("git", ["cat-file", "-e", `${since}^{commit}`], { cwd: REPO }).status === 0
    ? [`${since}..${commit || "HEAD"}`] : ["-15", commit || "HEAD"];
  const subjects = run("git", ["log", "--no-merges", "--format=%s", ...range, "--", ".", ":!desktop/macos/release.json"], { cwd: REPO })
    .split("\n").filter((s) => s && !s.startsWith(LINK_COMMIT_PREFIX)).slice(0, 30);
  const list = subjects.length ? subjects : ["小修小补"];
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return { text: list.map((s) => `- ${s}`).join("\n"), html: `<ul>${list.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` };
}

/** `--notes` 给的说明：和自动生成的一样，Release 用原文、appcast 用转义过的 HTML。 */
function notesFromText(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const paragraphs = text.trim().split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`);
  return { text: text.trim(), html: paragraphs.join("") };
}

/** 传上去的包确实下得下来、大小和内容都对（feed 指向它之前最后一道确认）。 */
async function confirmDownloadable(url, file, length) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(url, { redirect: "follow" });
    if (response.ok) {
      const body = Buffer.from(await response.arrayBuffer());
      const want = createHash("sha256").update(readFileSync(file)).digest("hex");
      const got = createHash("sha256").update(body).digest("hex");
      if (body.length === length && got === want) return;
      die(`从 ${url} 下回来的包和本地这份不一样（${body.length} 字节，sha256 ${got}）`);
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
  die(`${url} 一直下不下来：没有推 appcast。等 GitHub 那边好了重跑一次（会沿用同一个包）。`);
}

function makeKeys(config, tool) {
  const existing = spawnSync(tool("generate_keys"), ["--account", config.keychainAccount, "-p"], { encoding: "utf8" });
  if (existing.status !== 0 && config.publicKey) {
    // 已经发过（或者至少定下了）一把公钥，钥匙串里却没有私钥：多半是换了电脑。新建一把只会得到
    // 一把已装的 app 永远不认的钥匙。
    die(`钥匙串里没有 ${config.keychainAccount} 的私钥，而 release.json 已经定了公钥 ${config.publicKey}。\n`
      + `把备份导回来：${tool("generate_keys")} --account ${config.keychainAccount} -f <备份文件>`);
  }
  say(`▶ generate_keys --account ${config.keychainAccount}（钥匙串里已有就沿用，没有才新建）`);
  const made = spawnSync(tool("generate_keys"), ["--account", config.keychainAccount], { stdio: "inherit" });
  if (made.status !== 0) die("generate_keys 失败");
  const publicKey = run(tool("generate_keys"), ["--account", config.keychainAccount, "-p"]);
  if (config.publicKey && config.publicKey !== publicKey) {
    die(`release.json 里已经是另一把公钥（${config.publicKey}），钥匙串里这把是 ${publicKey}。\n密钥永远不能换：去找回原来那把私钥（generate_keys --account ${config.keychainAccount} -f <备份文件>）。`);
  }
  // 按文件原样改这一项（config 里带着补上的缺省值，别把它们也写回去）。
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")), publicKey }, null, 2)}\n`);
  say(`✓ 公钥 ${publicKey} 已写进 ${CONFIG_PATH}（提交它）。`);
  say(`  现在就备份私钥：${tool("generate_keys")} --account ${config.keychainAccount} -x <放到钥匙串之外的地方>`);
  say("  私钥丢了，已经装了 app 的机器就再也收不到更新。");
}

async function initRepos(repos, github) {
  for (const name of repos) {
    if (await github.repoExists(name)) {
      say(`✓ ${name} 已经在了`);
      continue;
    }
    const repo = await github.createPublicRepo(name, "ash for macOS 的发布仓库（安装包 / appcast）");
    say(`✓ 已建公开仓库 ${repo.html_url}`);
  }
}

main().catch((error) => {
  process.stderr.write(`✕ ${error instanceof Stop ? error.message : error.stack || error}\n`);
  process.exit(1);
});

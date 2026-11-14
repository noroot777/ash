#!/usr/bin/env node
// 把「跑起一份 ash 要的一切」装进 Ash.app 的 Contents/Resources/app：固定版本的 node、shared/web/
// server/mcp 产物、生产依赖，以及按这份 node 重编的 node-pty。装完之后 app 不再依赖任何仓库检出，
// 也不依赖系统里有没有 node。
//
//   node desktop/macos/scripts/bundle-runtime.mjs <Resources 目录>
//
// 目录布局与仓库同形（server 认代码根 = server/dist 往上两级，见 server/src/data-root.ts）：
//
//   app/node/bin/node            自带运行时（只留这一个文件 + LICENSE，不带 npm）
//   app/package.json             workspaces 根，node_modules 里 @ash/* 的软链指回同级目录
//   app/node_modules/            server + mcp 的生产依赖
//   app/shared/{package.json,src}  shared 的导出直接指 .ts 源码，靠 node 的类型擦除跑 ——
//                                所以它必须在 node_modules **外面**（node 不擦 node_modules 里的 .ts）
//   app/server/{package.json,dist}
//   app/mcp/{package.json,dist}  ash MCP 的入口，首启接 MCP 时登记的就是它
//   app/web/dist
//   app/scripts/start-detached.mjs  app 起服务时让 server 进自己的会话
//   app/.in-use                  代码锁：跑这份代码的服务、MCP 以共享锁拿着它，换包时安装器拿排他锁
//                                （shared/src/code-lock.ts、scripts/install-app.sh）
//
// 下载的 node 包按写死在这里的 sha256 校验，不认就不用（缓存里的也每次重验）。依赖按
// 「lockfile + 各 workspace 的 package.json + node 版本」缓存，没变就不再装一遍。
//
// 环境变量：ASH_MAC_SKIP_BUILD=1 跳过 `npm run build`（产物已是最新时省时间）；
//           ASH_MAC_CACHE=<目录> 换缓存位置（缺省 desktop/macos/build/cache）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 升级 node：改这三行，sha256 取 https://nodejs.org/dist/<版本>/SHASUMS256.txt 里对应那一行。
// ≥22.16 才有内置的 node:sqlite；shared 跑 .ts 源码还要默认开着的类型擦除。
const NODE_VERSION = "v26.13.1";
const NODE_ARCHIVE = `node-${NODE_VERSION}-darwin-arm64.tar.xz`;
const NODE_SHA256 = "af6202f5370a3a5209e85dc543758dfd9f44c8726626a236730cd603a67a8559";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const resources = process.argv[2];
if (!resources) {
  console.error("usage: bundle-runtime.mjs <Ash.app/Contents/Resources>");
  process.exit(2);
}
const CACHE = resolve(process.env.ASH_MAC_CACHE || join(HERE, "..", "build", "cache"));
const APP = join(resolve(resources), "app");
const WORKSPACES = ["shared", "server", "web", "mcp"];

const say = (line) => process.stdout.write(`${line}\n`);
const die = (line) => { process.stderr.write(`✕ ${line}\n`); process.exit(1); };

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...opts });
  if (result.status !== 0) die(`${command} ${args.join(" ")} 失败（退出码 ${result.status ?? result.signal}）`);
}

async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// ── 1. 产物 ────────────────────────────────────────────────────────────────
if (process.env.ASH_MAC_SKIP_BUILD !== "1") {
  say("▶ npm run build");
  run("npm", ["run", "build"], { cwd: REPO });
}
for (const built of ["server/dist/index.js", "mcp/dist/index.js", "web/dist/index.html", "shared/src/index.ts"]) {
  if (!existsSync(join(REPO, built))) die(`${built} 不存在：先在仓库根跑一次 npm run build`);
}

// ── 2. node ────────────────────────────────────────────────────────────────
mkdirSync(CACHE, { recursive: true });
const archive = join(CACHE, NODE_ARCHIVE);
if (!existsSync(archive) || (await sha256Of(archive)) !== NODE_SHA256) {
  say(`▶ 下载 ${NODE_ARCHIVE}`);
  const response = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}`);
  if (!response.ok) die(`下载 node 失败：HTTP ${response.status}`);
  const partial = `${archive}.part`;
  writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  const actual = await sha256Of(partial);
  if (actual !== NODE_SHA256) {
    rmSync(partial, { force: true });
    die(`${NODE_ARCHIVE} 的 sha256 对不上：期望 ${NODE_SHA256}，实际 ${actual}`);
  }
  renameSync(partial, archive);
}
const nodeHome = join(CACHE, NODE_ARCHIVE.replace(/\.tar\.xz$/, ""));
if (!existsSync(join(nodeHome, "bin", "node"))) {
  const unpacking = `${nodeHome}.unpacking`;
  rmSync(unpacking, { recursive: true, force: true });
  mkdirSync(unpacking);
  run("tar", ["-xJf", archive, "-C", unpacking, "--strip-components", "1"]);
  renameSync(unpacking, nodeHome);
}
const node = join(nodeHome, "bin", "node");
const npmCli = join(nodeHome, "lib", "node_modules", "npm", "bin", "npm-cli.js");

// ── 3. 生产依赖（node-pty 按这份 node 重编）──────────────────────────────
const manifests = ["package.json", "package-lock.json", ...WORKSPACES.map((w) => `${w}/package.json`), "server/scripts/prepare-node-pty.mjs"];
const depsKey = createHash("sha256")
  .update(`${NODE_VERSION}\nnode-pty: node-gyp --nodedir\n`)
  .update(manifests.map((m) => `${m}\n${readFileSync(join(REPO, m), "utf8")}`).join("\n"))
  .digest("hex").slice(0, 16);
const deps = join(CACHE, `deps-${depsKey}`);
if (!existsSync(join(deps, "node_modules"))) {
  say("▶ 安装生产依赖，按自带 node 重编 node-pty");
  const stage = `${deps}.installing`;
  rmSync(stage, { recursive: true, force: true });
  for (const m of manifests) {
    mkdirSync(dirname(join(stage, m)), { recursive: true });
    cpSync(join(REPO, m), join(stage, m));
  }
  // npm 的生命周期脚本里写的是裸 `node`：让它们用的就是要打进包的这一份。
  const env = { ...process.env, PATH: `${join(nodeHome, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin` };
  run(node, [npmCli, "ci", "--omit=dev", "--workspace=@ash/server", "--workspace=@ash/mcp", "--no-audit", "--no-fund"], { cwd: stage, env });
  // node-pty 自带的预编译包先删掉：它的加载器找不到 build/Release 时会退回 prebuilds/，删了才
  // 保证跑起来的一定是下面这份。头文件取自同一个 node 包（--nodedir），不去网上另下一份。
  const pty = join(stage, "node_modules", "node-pty");
  rmSync(join(pty, "prebuilds"), { recursive: true, force: true });
  const gyp = join(nodeHome, "lib", "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js");
  run(node, [gyp, "rebuild", `--nodedir=${nodeHome}`], { cwd: pty, env });
  run(node, [join(pty, "scripts", "post-install.js")], { cwd: pty, env });
  if (!existsSync(join(pty, "build", "Release", "pty.node"))) die("node-pty 没编出来（build/Release/pty.node 不存在）");
  rmSync(deps, { recursive: true, force: true });
  renameSync(stage, deps);
}

// ── 4. 装进 app ─────────────────────────────────────────────────────────────
say(`▶ 组装 ${APP}`);
rmSync(APP, { recursive: true, force: true });
mkdirSync(join(APP, "node", "bin"), { recursive: true });
cpSync(node, join(APP, "node", "bin", "node"));
cpSync(join(nodeHome, "LICENSE"), join(APP, "node", "LICENSE"));
// -c：APFS 上是克隆，不占第二份空间；-R 原样保留 workspace 软链。
run("cp", ["-cR", join(deps, "node_modules"), join(APP, "node_modules")]);
cpSync(join(REPO, "package.json"), join(APP, "package.json"));
const copies = [
  "shared/package.json", "shared/src",
  "server/package.json", "server/dist",
  "mcp/package.json", "mcp/dist",
  "web/dist",
  "scripts/start-detached.mjs",
];
for (const rel of copies) cpSync(join(REPO, rel), join(APP, rel), { recursive: true, verbatimSymlinks: true });
writeFileSync(join(APP, ".in-use"), "");
// web 不进生产依赖，它那条 workspace 软链指向一个没有 package.json 的目录，留着只会让人误会。
rmSync(join(APP, "node_modules", "@ash", "web"), { force: true });

// ── 5. 自检：拿打进去的那份 node，从打进去的那份目录里加载 ──────────────────────
const smoke = spawnSync(join(APP, "node", "bin", "node"), ["--input-type=module", "-e", `
  await import("node:sqlite");
  const pty = (await import("node-pty")).default;
  const mcp = await import("@ash/shared/mcp");
  if (!mcp.ASH_MCP_SERVER_NAME || typeof pty.spawn !== "function") process.exit(3);
  console.log(process.version);
`], { cwd: join(APP, "server"), encoding: "utf8" });
if (smoke.status !== 0 || smoke.stdout.trim() !== NODE_VERSION) {
  die(`自检失败：自带的 node 加载不了 sqlite / node-pty / shared 源码\n${smoke.stdout}${smoke.stderr}`);
}
say(`✓ 自带运行时 ${NODE_VERSION}，产物与依赖已装进 ${APP}`);

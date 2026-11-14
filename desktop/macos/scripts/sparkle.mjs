#!/usr/bin/env node
// 取一份固定版本的 Sparkle（自更新框架 + 发布用的 sign_update / generate_keys），缓存在
// desktop/macos/build/cache 里，打印解开后的目录。build.sh 和 release.mjs 都从这里拿。
//
//   node desktop/macos/scripts/sparkle.mjs        # → .../build/cache/Sparkle-2.10.1
//
// 下载包按写死的 sha256 校验，对不上就不用（缓存里的也每次重验）。升级 Sparkle：改下面两行，
// sha256 自己下一份算（GitHub release 页不给校验和），并且读一遍它的 CHANGELOG 里有没有改
// 更新校验的规则 —— app 是 ad-hoc 签名，装得上新版全靠 EdDSA 那一道。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SPARKLE_VERSION = "2.10.1";
const SPARKLE_SHA256 = "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27";

const HERE = dirname(fileURLToPath(import.meta.url));

async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** 确保缓存里有解开的 Sparkle，返回它的目录（里面有 Sparkle.framework 和 bin/）。 */
export async function ensureSparkle(cache = resolve(process.env.ASH_MAC_CACHE || join(HERE, "..", "build", "cache"))) {
  const home = join(cache, `Sparkle-${SPARKLE_VERSION}`);
  if (existsSync(join(home, "bin", "sign_update")) && existsSync(join(home, "Sparkle.framework"))) return home;
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, `Sparkle-${SPARKLE_VERSION}.tar.xz`);
  if (!existsSync(archive) || (await sha256Of(archive)) !== SPARKLE_SHA256) {
    const url = `https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz`;
    process.stderr.write(`▶ 下载 ${url}\n`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`下载 Sparkle 失败：HTTP ${response.status}`);
    const partial = `${archive}.part`;
    writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    const actual = await sha256Of(partial);
    if (actual !== SPARKLE_SHA256) {
      rmSync(partial, { force: true });
      throw new Error(`Sparkle-${SPARKLE_VERSION}.tar.xz 的 sha256 对不上：期望 ${SPARKLE_SHA256}，实际 ${actual}`);
    }
    renameSync(partial, archive);
  }
  const unpacking = `${home}.unpacking`;
  rmSync(unpacking, { recursive: true, force: true });
  mkdirSync(unpacking);
  // 框架里全是软链（Versions/Current → B），只有 tar 原样还原，别换成别的解法。
  const tar = spawnSync("tar", ["-xJf", archive, "-C", unpacking], { stdio: "inherit" });
  if (tar.status !== 0) throw new Error("解开 Sparkle 失败");
  rmSync(home, { recursive: true, force: true });
  renameSync(unpacking, home);
  return home;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${await ensureSparkle()}\n`);
  } catch (error) {
    process.stderr.write(`✕ ${error.message}\n`);
    process.exit(1);
  }
}

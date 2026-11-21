import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export function appInfo(app) {
  const plist = join(app, "Contents", "Info.plist");
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`读 ${plist} 失败：${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function appDigest(app) {
  const hash = createHash("sha256");
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const pathInApp = relative(app, path);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) hash.update(`L ${pathInApp} -> ${readlinkSync(path)}\n`);
      else if (stat.isDirectory()) walk(path);
      else hash.update(`F ${pathInApp} ${stat.mode & 0o111 ? "x" : "-"} ${createHash("sha256").update(readFileSync(path)).digest("hex")}\n`);
    }
  };
  walk(app);
  return hash.digest("hex");
}

export function packApp(app, artifacts, name, say = console.log) {
  mkdirSync(artifacts, { recursive: true });
  const dmg = join(artifacts, name);
  const source = `${dmg}.source`;
  const digest = appDigest(app);
  if (existsSync(dmg)) {
    const packed = existsSync(source) ? readFileSync(source, "utf8").trim() : "（没有记录）";
    if (packed !== digest) {
      throw new Error(`${dmg} 是上次从另一份 app 封的（内容摘要 ${packed}，这次是 ${digest}）：同一个构建号换了包。\n`
        + `要发这次这份就换个构建号重新构建；确定上次那份没传出去，也可以删掉 ${artifacts} 再重跑。`);
    }
    say(`▶ 沿用上次没发完的 ${dmg}`);
  } else {
    say(`▶ 封 ${dmg}`);
    const part = join(artifacts, `.part-${basename(dmg)}`);
    const result = spawnSync("bash", [join(HERE, "make-dmg.sh"), app, part], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`封 dmg 失败（${result.status ?? result.signal}）`);
    writeFileSync(source, `${digest}\n`);
    renameSync(part, dmg);
  }
  return dmg;
}

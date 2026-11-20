import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export const manifestName = "runtime-manifest.json";

export function runtimeManifest(root, schema) {
  const files = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const rel = relative(root, path);
      if (rel === manifestName || rel === ".in-use") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = relative(root, resolve(directory, link));
        if (link.startsWith("/") || target === ".." || target.startsWith("../")) throw new Error(`运行时软链越界：${rel}`);
        files.push({ path: rel, link });
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push({ path: rel, sha: hash(readFileSync(path)), executable: Boolean(stat.mode & 0o111) });
      else throw new Error(`不支持的运行时文件：${rel}`);
    }
  }
  visit(root);
  const payload = JSON.stringify({ protocol: 1, schema, files });
  return { id: hash(payload), payload };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2]);
  const repo = fileURLToPath(new URL("../../..", import.meta.url));
  const schema = readdirSync(join(repo, "server/src/db")).filter((file) => file.endsWith(".ts")).sort()
    .map((file) => `${file}\n${readFileSync(join(repo, "server/src/db", file), "utf8")}`).join("\n");
  writeFileSync(join(root, manifestName), JSON.stringify(runtimeManifest(root, hash(schema))));
}

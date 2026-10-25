import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function git(repo, args) {
  return spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
  });
}

function emptyDirectory(repo, directory) {
  const target = resolve(repo, directory);
  const inside = relative(repo, target);
  if (!inside || isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) return false;
  let current = repo;
  for (const part of inside.split(sep)) {
    current = join(current, part);
    try {
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    } catch (error) {
      return error.code === "ENOENT";
    }
  }
  return readdirSync(target).length === 0;
}

export function repairEmptyWorkspaces(repo) {
  const result = { restored: [], warnings: [] };
  let directories;
  try {
    const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    directories = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages;
    if (!Array.isArray(directories)) return result;
    repo = realpathSync(repo);
  } catch {
    return result;
  }
  const top = git(repo, ["rev-parse", "--show-toplevel"]);
  try {
    if (top.status !== 0 || realpathSync(top.stdout.trim()) !== repo) return result;
  } catch {
    return result;
  }
  if (git(repo, ["config", "--bool", "core.sparseCheckout"]).stdout.trim() === "true") return result;
  const revision = git(repo, ["rev-parse", "--verify", "HEAD"]);
  if (revision.status !== 0) return result;
  const source = revision.stdout.trim();
  for (const directory of directories) {
    if (typeof directory !== "string" || /[*?[\]]/.test(directory)) continue;
    try {
      if (!emptyDirectory(repo, directory)) continue;
      const manifest = git(repo, ["show", `${source}:${directory.replaceAll("\\", "/").replace(/\/$/, "")}/package.json`]);
      if (manifest.status !== 0 || !JSON.parse(manifest.stdout)?.name) continue;
      const staged = git(repo, ["diff", "--cached", "--quiet", source, "--", directory]);
      if (staged.status !== 0) {
        result.warnings.push(`${directory}: 暂存区有改动或无法核对,未自动恢复`);
        continue;
      }
      if (!emptyDirectory(repo, directory)) continue;
      const restored = git(repo, ["restore", `--source=${source}`, "--worktree", "--", directory]);
      if (restored.status === 0) result.restored.push(directory);
      else result.warnings.push(`${directory}: Git 恢复失败: ${(restored.stderr || restored.error?.message || "未知错误").trim()}`);
    } catch (error) {
      result.warnings.push(`${directory}: 未自动恢复: ${error.message}`);
    }
  }
  return result;
}

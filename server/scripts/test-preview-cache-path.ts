import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-preview-cache-path-"));
const physical = join(root, "physical");
const alias = join(root, "alias");
mkdirSync(physical);
symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
process.env.ASH_DEPS_DIR = join(alias, "deps");
const { heldCacheOf, pruneNodeDeps } = await import("../src/preview-deps.js");
try {
  const cache = join(alias, "deps", "fixture-cache");
  const modules = join(cache, "node_modules");
  const link = join(root, "node_modules");
  mkdirSync(modules, { recursive: true });
  symlinkSync(modules, link, process.platform === "win32" ? "junction" : "dir");
  const held = heldCacheOf(link);
  assert.equal(held, realpathSync(cache));
  const expired = new Date(Date.now() - 40 * 24 * 60 * 60_000);
  utimesSync(cache, expired, expired);
  pruneNodeDeps([held!]);
  assert.equal(existsSync(modules), true, "经过软链的数据目录仍须保护使用中的缓存");
  assert.ok(Date.now() - statSync(cache).mtimeMs < 60_000);
  rmSync(link);
  utimesSync(cache, expired, expired);
  pruneNodeDeps();
  assert.equal(existsSync(cache), false);
  console.log("preview cache path: symlink/junction aliases preserve held caches and release expired unused caches");
} finally {
  rmSync(alias);
  rmSync(root, { recursive: true, force: true });
}

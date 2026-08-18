import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "harness-local-open-"));
const repo = join(stage, "repo");
const outside = join(stage, "outside");
process.env.HARNESS_DB = join(stage, "harness.db");

try {
  mkdirSync(join(repo, ".worktrees", "task", "docs"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const demo = join(repo, ".worktrees", "task", "docs", "index.html");
  const secret = join(outside, "secret.html");
  writeFileSync(demo, "<!doctype html><title>demo</title>");
  writeFileSync(secret, "<!doctype html><title>secret</title>");
  symlinkSync(outside, join(repo, "escape"));

  const [{ db, ensureSchema }, { projects }, { isTrustedLocalOpenRemote, registeredProjectRoots, resolveAllowedLocalPath }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/local-open-routes.js"),
  ]);
  await ensureSchema();
  await db.insert(projects).values({ id: "project", name: "demo", repoPath: repo, createdAt: new Date().toISOString() });
  assert.deepEqual(await registeredProjectRoots(), [repo], "已登记项目根目录应自动进入打开白名单");
  assert.equal(await resolveAllowedLocalPath(demo, [repo]), realpathSync(demo), "项目根目录内的 worktree 产物应可打开");
  assert.equal(await resolveAllowedLocalPath(secret, [repo]), null, "项目外的路径必须拒绝");
  assert.equal(await resolveAllowedLocalPath(join(repo, "escape", "secret.html"), [repo]), null, "软链不能越过项目根目录");
  assert.equal(await resolveAllowedLocalPath(join(repo, "missing.html"), [repo]), null, "不存在的文件不能交给系统打开");

  assert.equal(isTrustedLocalOpenRemote("127.0.0.1"), true);
  assert.equal(isTrustedLocalOpenRemote("::ffff:127.0.0.1"), true);
  assert.equal(isTrustedLocalOpenRemote("100.64.1.2"), true);
  assert.equal(isTrustedLocalOpenRemote("100.128.1.2"), false);
  assert.equal(isTrustedLocalOpenRemote("192.168.1.2"), false);

  console.log("✓ local-open：项目 worktree 可打开，越界/软链/非可信来源被拒绝");
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-local-open-"));
const repo = join(stage, "repo");
const outside = join(stage, "outside");
const home = join(stage, "home");
process.env.ASH_DB = join(stage, "ash.db");
// homedir() 每次现读：POSIX 读 HOME，Windows 读 USERPROFILE
process.env.HOME = home;
process.env.USERPROFILE = home;

try {
  mkdirSync(join(repo, ".worktrees", "task", "docs"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const demo = join(repo, ".worktrees", "task", "docs", "index.html");
  const secret = join(outside, "secret.html");
  writeFileSync(demo, "<!doctype html><title>demo</title>");
  writeFileSync(secret, "<!doctype html><title>secret</title>");
  symlinkSync(outside, join(repo, "escape"));
  mkdirSync(join(home, "Movies"), { recursive: true });
  const film = join(home, "Movies", "成片.mp4");
  const song = join(home, "Movies", "配乐.mp3");
  const script = join(home, "run.command");
  writeFileSync(film, "mp4");
  writeFileSync(song, "mp3");
  writeFileSync(script, "#!/bin/sh");
  writeFileSync(join(home, "notes.txt"), "secret");
  writeFileSync(join(outside, "elsewhere.mp4"), "mp4");
  symlinkSync(script, join(home, "Movies", "伪装.mp4"));

  const [{ db, ensureSchema }, { projects }, { isTrustedLocalOpenRemote, registeredProjectRoots, resolveAllowedLocalPath, resolveOpenableLocalPath }] = await Promise.all([
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

  // 白名单之外只多放家目录里的音视频：交给的是播放器，不是能执行东西的默认程序
  assert.equal(await resolveOpenableLocalPath(demo), realpathSync(demo), "白名单里的照旧");
  assert.equal(await resolveOpenableLocalPath("~/Movies/成片.mp4"), realpathSync(film), "家目录里的视频，`~` 由服务端展开");
  assert.equal(await resolveOpenableLocalPath(song), realpathSync(song), "音频同样放");
  assert.equal(await resolveOpenableLocalPath(join(home, "notes.txt")), null, "家目录里别的文件不放");
  assert.equal(await resolveOpenableLocalPath(script), null, "能执行的更不放");
  assert.equal(await resolveOpenableLocalPath(join(home, "Movies", "伪装.mp4")), null, "按 realpath 的真名判：软链到脚本的 .mp4 不放");
  assert.equal(await resolveOpenableLocalPath(join(outside, "elsewhere.mp4")), null, "家目录外的视频不放");
  assert.equal(await resolveOpenableLocalPath(join(home, "Movies")), null, "目录不放");
  assert.equal(await resolveOpenableLocalPath(""), null);

  assert.equal(isTrustedLocalOpenRemote("127.0.0.1"), true);
  assert.equal(isTrustedLocalOpenRemote("::ffff:127.0.0.1"), true);
  assert.equal(isTrustedLocalOpenRemote("100.64.1.2"), true);
  assert.equal(isTrustedLocalOpenRemote("100.128.1.2"), false);
  assert.equal(isTrustedLocalOpenRemote("192.168.1.2"), false);

  console.log("✓ local-open：项目 worktree 可打开，家目录里的音视频可打开，越界/软链/非可信来源被拒绝");
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

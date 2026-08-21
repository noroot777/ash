// 任务文件浏览的安全边界与识别口径（server/src/file-browser.ts）。
//
// 这些是「点一下就跑」的只读端点，但它们把一段用户可控的路径拼到 fs 调用上，
// 所以边界必须钉死，且要钉在**纯函数层**而不是靠端点手测：
//   1. 越界一律拒：`../..`、绝对路径、以及指向工作区外面的软链
//   2. 「越界」和「文件不存在」分开报 —— 前者是指控，后者只是文件没了
//   3. 文本/二进制识别、.gitignore 标记、排序（忽略项沉底、目录在前）
//   4. resolveTarget 对目录也给答案（「在文件夹中查看」要能对着文件夹按）
// 跑：npm -w server run test:file-browser
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-file-browser-"));
const repo = join(stage, "repo");
const outside = join(stage, "outside");
process.env.ASH_DB = join(stage, "ash.db");

const status = (error: unknown) => (error as { status?: number }).status;

try {
  mkdirSync(repo, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "node_modules"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "不该被读到");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n*.log\n");
  writeFileSync(join(repo, "readme.md"), "# 标题\n中文正文\n");
  writeFileSync(join(repo, "debug.log"), "被 gitignore 挡着");
  writeFileSync(join(repo, "src", "app.ts"), "export const x = 1;\n");
  // NUL 是二进制最硬的特征，扩展名帮不上忙的那一类就靠它
  writeFileSync(join(repo, "blob.dat"), Buffer.from([0x7f, 0x45, 0x4c, 0x00, 0x01, 0x02]));
  writeFileSync(join(repo, "src", "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  symlinkSync(outside, join(repo, "escape"));

  execFileSync("git", ["-C", repo, "init", "-q"]);

  const { listDirectory, readFileContent, resolveTarget } = await import("../src/file-browser.js");
  const root = { path: repo, branch: "main", gitRepo: true, source: "repo" as const, repoPath: repo };

  // ── 1. 越界 ────────────────────────────────────────────────────────────────
  for (const bad of ["../outside", "../outside/secret.txt", outside, join(outside, "secret.txt"), "escape/secret.txt", "escape"]) {
    await assert.rejects(
      () => resolveTarget(root, bad),
      (error: Error) => status(error) === 400 && /不在这个任务的工作目录/.test(error.message),
      `越界路径必须被拒：${bad}`,
    );
  }
  // 软链本身指向外面 —— 列目录看得见它，点进去不给
  await assert.rejects(() => listDirectory(root, "escape"), (error: Error) => status(error) === 400);

  // ── 2. 越界 vs 不存在 ──────────────────────────────────────────────────────
  await assert.rejects(
    () => resolveTarget(root, "src/gone.ts"),
    (error: Error) => status(error) === 404 && /文件不存在/.test(error.message),
    "界内但不存在的路径要报 404「文件不存在」，不能说成越界",
  );
  await assert.rejects(() => readFileContent(root, "src"), (error: Error) => status(error) === 400);

  // 目录也要能解析出位置：「在文件夹中查看」对着文件夹按是正常动作
  assert.equal((await resolveTarget(root, "src")).directory, true);
  assert.equal((await resolveTarget(root, "readme.md")).directory, false);
  assert.equal((await resolveTarget(root, "")).absPath, repo);

  // ── 3. 内容识别 ────────────────────────────────────────────────────────────
  const readme = await readFileContent(root, "readme.md");
  assert.equal(readme.kind, "text");
  assert.match(readme.text ?? "", /中文正文/);
  assert.equal(readme.truncated, false);
  assert.equal((await readFileContent(root, "blob.dat")).kind, "binary");
  assert.equal((await readFileContent(root, "blob.dat")).text, null, "二进制不许把字节当文本塞进 JSON");
  const png = await readFileContent(root, "src/pixel.png");
  assert.equal(png.kind, "image");
  assert.equal(png.mime, "image/png");

  // ── 4. 列目录：忽略标记与排序 ──────────────────────────────────────────────
  const listing = await listDirectory(root, "");
  const byName = new Map(listing.entries.map((entry) => [entry.name, entry]));
  assert.equal(byName.get("node_modules")?.ignored, true);
  assert.equal(byName.get("debug.log")?.ignored, true);
  assert.equal(byName.get("readme.md")?.ignored, false);
  assert.equal(byName.get("escape")?.symlink, true);
  assert.equal(byName.get("src")?.kind, "dir");
  assert.ok(!byName.has(".git"), ".git 不该出现在树里");

  const names = listing.entries.map((entry) => entry.name);
  const firstIgnored = listing.entries.findIndex((entry) => entry.ignored);
  assert.ok(
    listing.entries.slice(firstIgnored).every((entry) => entry.ignored),
    `忽略项必须整块沉底：${names.join(", ")}`,
  );
  const visible = listing.entries.filter((entry) => !entry.ignored);
  const lastDir = visible.map((entry) => entry.kind).lastIndexOf("dir");
  assert.ok(
    visible.slice(0, lastDir + 1).every((entry) => entry.kind === "dir"),
    `目录必须排在文件前面：${visible.map((entry) => entry.name).join(", ")}`,
  );

  assert.equal((await listDirectory(root, "src")).entries.length, 2);

  console.log("✓ file-browser：越界拦截、越界/不存在分辨、文本二进制识别、忽略标记与排序");
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}

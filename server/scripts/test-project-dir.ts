// 「本地目录」这条路上唯一会动磁盘的那一小块：`createDir`。钉住三件靠通读发现不了的事：
// 不带这个标志位时**绝不建目录**（老行为，MCP / 手机端还在用）、带了才建、被文件占着或
// 写成相对路径时拒绝且不留项目行。
//
// 端点测试直接挂 project-routes 的 mount 函数，不起 server。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-project-dir-test-"));
process.env.ASH_DB = join(root, "ash.db");

try {
  const { ensureProjectDir } = await import("../src/project-dir.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects } = await import("../src/db/schema.js");
  const { mountProjectRoutes } = await import("../src/project-routes.js");
  const { Hono } = await import("hono");
  await ensureSchema();

  // ── ensureProjectDir 本体 ──
  {
    const target = join(root, "unit", "deeper", "dir");
    ensureProjectDir(target);
    assert.ok(existsSync(target), "缺失的上级目录要一起建出来");
    ensureProjectDir(target); // 幂等：已经存在时什么都不做，也不该抛
    writeFileSync(join(target, "keep.txt"), "keep\n");
    ensureProjectDir(target);
    assert.deepEqual(readdirSync(target), ["keep.txt"], "已存在的目录内容不许被动");

    const file = join(root, "a-file");
    writeFileSync(file, "x\n");
    assert.throws(() => ensureProjectDir(file), /被一个文件占用/, "路径被文件占着要拒绝");
    assert.throws(() => ensureProjectDir("relative/dir"), /绝对路径/, "相对路径要拒绝");
    assert.throws(() => ensureProjectDir("  "), /不能为空/, "空路径要拒绝");
  }

  // ── POST /projects ──
  const api = new Hono();
  mountProjectRoutes(api);
  const create = (body: unknown) => api.request("/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const countProjects = async () => (await db.select().from(projects)).length;

  // 不带 createDir:目录不存在也照记不误,但**一个目录都不许建**——这个端点也服务 MCP 和
  // 手机端,那边路径没填好只意味着「还没填好」。
  {
    const target = join(root, "not-created");
    const res = await create({ name: "只记路径", repoPath: target });
    assert.equal(res.status, 201);
    assert.equal(existsSync(target), false, "没要求建目录就不许建");
  }

  // 带 createDir:连同缺失的上级一起建出来,项目正常登记
  {
    const target = join(root, "made", "by", "ash");
    const res = await create({ name: "建目录", repoPath: target, createDir: true });
    assert.equal(res.status, 201);
    assert.equal((await res.json() as { repoPath: string }).repoPath, target);
    assert.ok(existsSync(target), "createDir 要真的把目录建出来");
    assert.deepEqual(readdirSync(target), [], "建出来的是空目录,不许往里放东西");
  }

  // 建不出来:拒绝,而且不许留下项目行(项目行是成功的凭据)
  {
    const file = join(root, "occupied-file");
    writeFileSync(file, "x\n");
    const before = await countProjects();
    const res = await create({ name: "被占", repoPath: file, createDir: true });
    assert.equal(res.status, 409, "路径被文件占着是 409");
    assert.equal(await countProjects(), before, "建不出目录就不许写库");

    const bad = await create({ name: "相对路径", repoPath: "relative/dir", createDir: true });
    assert.equal(bad.status, 400, "相对路径是 400");
    assert.match((await bad.json() as { error: string }).error, /绝对路径/);
    assert.equal(await countProjects(), before, "参数不合法同样不许写库");
  }

  console.log("project dir ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

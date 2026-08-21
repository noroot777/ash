// 「从 Git 检出新项目」的回归测试。钉住 `project-clone.ts` 顶部那四条决定里靠通读发现
// 不了的三条:非空目录一律拒绝、失败不留半个坑(且只收拾自己造的)、克隆成功才写库。
//
// 自带临时 bare 仓当远端,不联网、不碰 ash 自己的仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-project-clone-test-"));
process.env.ASH_DB = join(root, "ash.db");

/** 一个能被克隆的本地 bare 仓,带 main 和 side 两条分支。 */
function makeOrigin(name: string): string {
  const work = join(root, `${name}-work`);
  execFileSync("git", ["init", "-b", "main", work]);
  const git = (...args: string[]) => execFileSync("git", ["-C", work, ...args], { encoding: "utf8" });
  git("config", "user.name", "Ash Clone Test");
  git("config", "user.email", "clone@example.test");
  writeFileSync(join(work, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-m", "seed");
  git("branch", "side");
  const origin = join(root, `${name}.git`);
  execFileSync("git", ["clone", "--bare", work, origin]);
  return origin;
}

async function rejects(fn: () => Promise<unknown>, pattern: RegExp, label: string) {
  let message = "";
  try {
    await fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message, `${label}: 本该拒绝,却成功了`);
  assert.match(message, pattern, label);
  return message;
}

try {
  const { cloneProject } = await import("../src/project-clone.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects } = await import("../src/db/schema.js");
  await ensureSchema();
  const countProjects = async () => (await db.select().from(projects)).length;

  const origin = makeOrigin("upstream");
  const head = (repo: string) =>
    execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

  // ── 目标目录连同缺失的上级一起建出来;项目名默认取仓库名 ──
  {
    const target = join(root, "nested", "deeper", "upstream");
    const project = await cloneProject({ url: origin, targetPath: target });
    assert.equal(project.repoPath, target);
    assert.equal(project.name, "upstream", "名字留空时按仓库地址推导");
    assert.equal(project.health.isRepo, true);
    assert.ok(existsSync(join(target, "seed.txt")), "工作区文件要检出来");
    assert.equal(head(target), "main");
  }

  // ── 指定分支就检出那一条;项目名给了就用给的 ──
  {
    const target = join(root, "on-side");
    const project = await cloneProject({ url: origin, targetPath: target, branch: "side", name: "自定义名" });
    assert.equal(project.name, "自定义名");
    assert.equal(head(target), "side");
  }

  // ── 用户原本就有的空目录:可以克隆进去 ──
  {
    const target = join(root, "pre-made-empty");
    mkdirSync(target);
    await cloneProject({ url: origin, targetPath: target, name: "空目录" });
    assert.ok(existsSync(join(target, "seed.txt")));
  }

  // ── 非空目录一律拒绝,而且拒绝之后目录里的东西一件不少 ──
  {
    const target = join(root, "occupied");
    mkdirSync(target);
    writeFileSync(join(target, "mine.txt"), "别动我\n");
    const before = await countProjects();
    await rejects(
      () => cloneProject({ url: origin, targetPath: target }),
      /不是空的/,
      "非空目录必须拦在动手之前",
    );
    assert.deepEqual(readdirSync(target), ["mine.txt"], "被拒之后目录内容不许变");
    assert.equal(await countProjects(), before, "被拒不许留下项目行");
  }

  // ── 已经登记为项目的路径:拦住,不造第二个同仓库项目 ──
  {
    const taken = join(root, "on-side"); // 上面已经登记过
    const message = await rejects(
      () => cloneProject({ url: origin, targetPath: taken }),
      /已经登记为项目/,
      "同一条路径不许登记两次",
    );
    assert.match(message, /自定义名/, "拒绝时要说清是被哪个项目占着");
  }

  // ── 克隆失败:自己造的目录要删干净,库里也不许留下指向空路径的项目 ──
  {
    const target = join(root, "will-fail", "repo");
    const before = await countProjects();
    await rejects(
      () => cloneProject({ url: join(root, "no-such-repo.git"), targetPath: target }),
      /克隆失败/,
      "源仓库不存在时要报克隆失败",
    );
    assert.equal(existsSync(target), false, "失败后不许留下残缺的目标目录");
    assert.equal(await countProjects(), before, "失败不许写库——项目行是成功的凭据");
  }

  // ── 失败收拾只针对自己造的:用户原本就存在的空目录留在原地 ──
  {
    const target = join(root, "user-empty");
    mkdirSync(target);
    await rejects(
      () => cloneProject({ url: join(root, "no-such-repo.git"), targetPath: target }),
      /克隆失败/,
      "源仓库不存在时要报克隆失败",
    );
    assert.equal(existsSync(target), true, "用户自己建的空目录不许被顺手删掉");
  }

  // ── flag 形状的参数不许透传给 git(--upload-pack= 能执行任意命令) ──
  {
    await rejects(
      () => cloneProject({ url: "--upload-pack=touch /tmp/pwned", targetPath: join(root, "pwn") }),
      /仓库地址不能以 - 开头/,
      "flag 形状的仓库地址必须拦住",
    );
    await rejects(
      () => cloneProject({ url: origin, targetPath: join(root, "pwn2"), branch: "--upload-pack=x" }),
      /分支名不能以 - 开头/,
      "flag 形状的分支名必须拦住",
    );
    assert.equal(existsSync(join(root, "pwn")), false, "被拒之后一个目录都不许建");
  }

  // ── 相对路径拒绝:路径落在服务端那台机器上,相对谁都说不清 ──
  await rejects(
    () => cloneProject({ url: origin, targetPath: "relative/dir" }),
    /绝对路径/,
    "相对路径必须拦住",
  );
  await rejects(
    () => cloneProject({ url: "", targetPath: join(root, "x") }),
    /仓库地址不能为空/,
    "空地址必须拦住",
  );

  // ── 路由层:状态码要按拒绝的理由分开,前端才能分清「填错了」和「被占了」 ──
  {
    const { Hono } = await import("hono");
    const { mountProjectCloneRoutes } = await import("../src/project-clone.js");
    const api = new Hono();
    mountProjectCloneRoutes(api);
    const post = (body: unknown) => api.request("/projects/clone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const ok = await post({ url: origin, targetPath: join(root, "via-http"), name: "走 HTTP" });
    assert.equal(ok.status, 201, "克隆成功是 201 Created");
    assert.equal((await ok.json() as { name: string }).name, "走 HTTP");

    const dup = await post({ url: origin, targetPath: join(root, "via-http") });
    assert.equal(dup.status, 409, "路径被占是 409,不是 400");

    const bad = await post({ url: origin, targetPath: "relative/dir" });
    assert.equal(bad.status, 400, "参数不合法是 400");
    assert.match((await bad.json() as { error: string }).error, /绝对路径/);
  }

  console.log("project clone ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}

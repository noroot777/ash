import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// 运行产物目录(ASH_RUNS_DIR)落在**依赖目录内部**时,依赖那边的复制遍历必须跟源码那边用同一份排除
// 计划,而且无论如何都不能走进正在建的快照自己。2026-10-26 独立审查实测:不过滤时克隆 node_modules
// 会进 runs、进本次快照、再把快照里已建好的依赖树拷一遍,一层层嵌套到 ENAMETOOLONG 为止(约 286ms),
// 一个测试命令都还没开始跑;重试还是同样的失败。
//
// 这条用例必须单独一个文件:RUNS_DIR 在模块 import 时就由环境变量固化了,同一个进程里换不掉。
const root = mkdtempSync(join(tmpdir(), "ash-gate-runs-inside-"));
const repo = join(root, "project");
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const linkDir = (target: string, path: string) => (process.platform === "win32"
  ? symlinkSync(resolve(dirname(path), target), path, "junction")
  : symlinkSync(target, path));

try {
  // 先把项目和依赖铺好,再把 RUNS_DIR 指到依赖目录里面去。
  mkdirSync(join(repo, "packages", "lib"), { recursive: true });
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.name", "Gate Runs Test");
  git("config", "user.email", "runs@example.test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(join(repo, "package.json"), '{"private":true,"workspaces":["packages/*"]}');
  writeFileSync(join(repo, "packages", "lib", "package.json"),
    '{"name":"@demo/lib","version":"1.0.0","type":"module","main":"index.mjs"}');
  writeFileSync(join(repo, "packages", "lib", "index.mjs"), 'export const build = "certified";\n');
  writeFileSync(join(repo, "probe.mjs"), 'import { build } from "@demo/lib";\nconsole.log(build);\n');
  mkdirSync(join(repo, "node_modules", "@demo"), { recursive: true });
  linkDir(join("..", "..", "packages", "lib"), join(repo, "node_modules", "@demo", "lib"));
  mkdirSync(join(repo, "node_modules", "plain"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "plain", "package.json"), '{"name":"plain","version":"1.0.0"}');
  writeFileSync(join(repo, "node_modules", ".package-lock.json"),
    '{"packages":{"node_modules/plain":{"version":"1.0.0"}}}');
  // runs 住在依赖目录里,而且里面先放一个**被跟踪**的文件:排除计划按相对路径记一次、三处各按
  // 自己的根解释,所以副本回算那一侧也得排除它,否则会判「没能按原样复现」。
  const runs = join(repo, "node_modules", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, ".keep"), "runs lives inside the dependency directory\n");
  git("add", "-A");
  git("commit", "-m", "project with runs inside node_modules");

  process.env.ASH_RUNS_DIR = runs;
  const { createGateSnapshot, gateSnapshotPath, readGateSource, verifyGateSnapshot } =
    await import("../src/accept-gate-source.js");

  const source = await readGateSource(repo);
  const target = gateSnapshotPath("runs-inside", "r1");
  assert.equal(target.startsWith(join(repo, "node_modules")), true, "这条用例的前提:快照路径就在依赖目录内");

  const started = Date.now();
  await createGateSnapshot(repo, target, source);
  const elapsed = Date.now() - started;

  // 建得出来、而且没把自己拷进去:快照里既不该有 runs,也不该有嵌套的第二层快照。
  assert.equal(existsSync(join(target, "node_modules", "runs")), false,
    "运行产物目录不该跟着进副本——它既不是测试输入,而且本次快照就住在里面");
  assert.equal(readFileSync(join(target, "packages", "lib", "index.mjs"), "utf8").trim(),
    'export const build = "certified";', "源码照旧冻进快照");
  assert.equal(execFileSync(process.execPath, [join(target, "probe.mjs")], { encoding: "utf8" }).trim(),
    "certified", "workspace 包照旧解析到快照自己那份");
  assert.equal(await verifyGateSnapshot(target, source), true, "副本回算也要排除同一份运行产物,否则自证会失败");
  // 嵌套会在 ENAMETOOLONG 之前先把时间和磁盘吃掉,所以顺手钉一个宽松的上界:正常只需几十毫秒。
  assert.ok(elapsed < 30_000, `建快照不该陷进自我复制(实际 ${elapsed}ms)`);
  const depth = (path: string, level = 0): number => {
    if (level > 4 || !existsSync(join(path, "node_modules"))) return level;
    return depth(join(path, "node_modules"), level + 1);
  };
  assert.ok(depth(target) <= 1, "快照里不该出现嵌套的依赖树");
  assert.equal(readdirSync(runs).includes(".keep"), true, "工作区那份运行产物目录本身不被动");

  console.log("accept-gate-runs-inside: runtime directory inside the dependency tree is excluded from both copies");
} finally { rmSync(root, { recursive: true, force: true }); }

// 回归的并行执行器：把 package.json 里用 `&&` 串起来的测试链展开成一条条叶子，直接起叶子
// 命令（不再一层套一层 `npm run`），N 条同时跑，任何一条红就把在跑的全部收掉、拒绝放行。
//
// 测试清单仍然只有一份，就是各包 package.json 里那几条链 —— 这里只负责展开和调度，不另存
// 名单，链怎么改这里就怎么跑。
//
// 跑法：node scripts/test-runner.mjs <workspace> <script>（如 `web test`）；验收入口
// scripts/accept-test.mjs 用 runSteps() 把后端、前端两步并进同一个池子。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NPM, NPM_SPAWN_OPTS } from "./npm.mjs";

const manifest = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

function workspaceDirs(repo) {
  const dirs = new Map([[".", repo]]);
  for (const entry of manifest(repo).workspaces ?? []) {
    const dir = resolve(repo, entry);
    dirs.set(entry, dir);
    const { name } = manifest(dir);
    if (name) dirs.set(name, dir);
  }
  return dirs;
}

/** 把 `<workspace>` 包里的 `<script>` 链展开成叶子，顺序与原链一致。 */
export function expandChain(repo, workspace, script) {
  const dirs = workspaceDirs(repo);
  const leaves = [];
  const visit = (dir, name) => {
    const chain = manifest(dir).scripts?.[name];
    if (typeof chain !== "string") throw new Error(`${relative(repo, dir) || "."} 没有脚本 ${name}`);
    // 按 `&&` 切只在链里没有引号时成立；有引号的命令（`node -e "a && b"`）请收进脚本文件。
    if (/["'`]/.test(chain)) throw new Error(`${relative(repo, dir) || "."} 的 ${name} 带引号，无法安全展开：${chain}`);
    for (const part of chain.split("&&").map((text) => text.trim())) {
      const local = /^npm run (\S+)$/.exec(part);
      const other = /^npm (?:-w|--workspace) (\S+) run (\S+)$/.exec(part);
      if (local) visit(dir, local[1]);
      else if (other) {
        const target = dirs.get(other[1]);
        if (!target) throw new Error(`找不到 workspace ${other[1]}（${relative(repo, dir) || "."} 的 ${name}）`);
        visit(target, other[2]);
      } else leaves.push({ cwd: dir, command: part, script: name, label: `${relative(repo, dir) || "."}: ${part}` });
    }
  };
  const start = dirs.get(workspace);
  if (!start) throw new Error(`找不到 workspace ${workspace}`);
  visit(start, script);
  return leaves;
}

// 叶子所在包可以在 package.json 的 `testStage` 里声明一个共用台子（模块导出 startSharedStage，
// 返回 { env, stop }）：同包叶子开跑前起一次，env 交给它们，全部结束后收掉。web 用它共用一份
// Chrome 和 vite，见 web/scripts/dom-stage.mjs。
function stageModule(cwd) {
  const declared = manifest(cwd).testStage;
  return declared ? pathToFileURL(join(cwd, declared)).href : null;
}

// npm run 会把从包目录往上每一级的 node_modules/.bin 排到 PATH 最前面，叶子命令里裸写的
// `tsx` 靠的就是这个。
function binPath(repo, cwd, base) {
  const dirs = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.push(join(dir, "node_modules", ".bin"));
    if (dir === repo || dir === dirname(dir)) break;
  }
  return [...dirs, base].filter(Boolean).join(delimiter);
}

// 上一次每条叶子用了多久、红没红。排队时上次红的先跑（修完再跑最快知道修没修好），其余按
// 用时从长到短（最长的那条要是排在最后，整轮就得干等它一条）；没见过的新叶子当成最长。
// 叶子按仓库内相对路径记，各 worktree 和验收快照共用一份。
const HISTORY = join(tmpdir(), "ash-test-runner-history.json");

function readHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY, "utf8"));
  } catch {
    return {};
  }
}

function writeHistory(updates) {
  if (!Object.keys(updates).length) return;
  const temporary = `${HISTORY}.${process.pid}`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...readHistory(), ...updates }));
    renameSync(temporary, HISTORY);
  } catch {
    // 记不下来只影响下一轮的排队顺序。
  }
}

function schedule(leaves, history) {
  const rank = (leaf) => {
    const last = history[leaf.label];
    return last ? [last.failed ? 1 : 0, last.seconds] : [1, Infinity];
  };
  return leaves
    .map((leaf, index) => ({ leaf, index, rank: rank(leaf) }))
    .sort((a, b) => b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || a.index - b.index)
    .map(({ leaf }) => leaf);
}

function descendants(roots) {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map();
  for (const line of (listed.stdout ?? "").split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid > 0 && ppid > 0) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found = [];
  const stack = [...roots];
  while (stack.length) {
    for (const child of children.get(stack.pop()) ?? []) {
      found.push(child);
      stack.push(child);
    }
  }
  return found;
}

const signal = (pid, name) => {
  try {
    process.kill(pid, name);
  } catch {
    // 已经退了。
  }
};

/**
 * 跑一组步骤（每步 = 一条链）。所有叶子进同一个池子（排队顺序见 schedule）；某步的叶子全部绿了
 * 就报这一步通过。返回第一条红的叶子（全绿为 null）和它的退出码。
 */
export async function runSteps(repo, steps, { jobs = defaultJobs(), env = process.env, log = console.log } = {}) {
  if (process.platform === "win32") return runSequentially(repo, steps, env, log);
  const queue = schedule(steps.flatMap((step, index) => expandChain(repo, step.workspace, step.script)
    .map((leaf) => ({ ...leaf, step: index }))), readHistory());
  const timings = {};
  const remaining = steps.map((_, index) => queue.filter((leaf) => leaf.step === index).length);
  const logs = mkdtempSync(join(tmpdir(), "ash-test-runner-"));
  const stages = new Map();
  const running = new Map();
  let failure = null;
  let done = 0;
  const total = queue.length;
  log(`[test-runner] ${total} 条测试，${jobs} 路并行。`);

  const stageEnv = (cwd) => {
    const module = stageModule(cwd);
    if (!module) return Promise.resolve({});
    if (!stages.has(module)) stages.set(module, import(module).then((loaded) => loaded.startSharedStage()));
    return stages.get(module).then((stage) => stage.env);
  };

  // `sh -c` 当 shield：detached 让 sh 自己当进程组组长，被测脚本是组内的普通成员 —— 跟在
  // `npm run` 底下「继承调用方的组、组长另有其人」同形。不能 detached 被测脚本本身：一批产品
  // 代码的职责就是杀干净同组进程，它当了组长就会把自己杀掉（exit 143、日志却全是 passed）。
  // 命令后面那句 `exit` 不能省，否则 sh 会把自己 exec 掉，被测脚本又成了组长。
  const launch = async (leaf) => {
    const extra = await stageEnv(leaf.cwd);
    // 等台子的这段时间里别的叶子可能已经红了、收场也扫过了，这时再起就成了没人收的孤儿。
    if (failure) return { leaf, status: { code: 1, skipped: true } };
    const file = join(logs, `${queue.indexOf(leaf)}.log`);
    const output = openSync(file, "w");
    const startedAt = Date.now();
    const child = spawn("/bin/sh", ["-c", `${leaf.command}\n__rc=$?; exit $__rc`], {
      cwd: leaf.cwd,
      detached: true,
      stdio: ["ignore", output, output],
      env: { ...env, ...extra, npm_lifecycle_event: leaf.script, PATH: binPath(repo, leaf.cwd, env.PATH) },
    });
    closeSync(output);
    running.set(leaf, child);
    const status = await new Promise((settle) => {
      child.once("error", (error) => settle({ code: 127, error }));
      child.once("exit", (code, killed) => settle({ code: code ?? 1, killed }));
    });
    running.delete(leaf);
    return { leaf, file, status, seconds: (Date.now() - startedAt) / 1000 };
  };

  const report = ({ leaf, file, status, seconds }) => {
    const passed = status.code === 0;
    timings[leaf.label] = { seconds, failed: !passed };
    done += 1;
    log(`\n── [${done}/${total}] ${passed ? "✓" : "✗"} ${leaf.label}（${seconds.toFixed(1)}s）`);
    if (existsSync(file)) process.stdout.write(readFileSync(file));
    if (status.error) log(`[test-runner] 无法启动：${status.error.message}`);
    if (status.killed) log(`[test-runner] 被信号 ${status.killed} 终止。`);
  };

  const stopAll = async () => {
    const shields = [...running.values()].map((child) => child.pid).filter((pid) => pid > 0);
    // 先记下整棵树：组杀只到 shield 那一组，测试自己 detached 出去的子进程得按父子关系补刀。
    const strays = descendants(shields);
    for (const pid of shields) signal(-pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (running.size && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 100));
    for (const pid of shields) signal(-pid, "SIGKILL");
    for (const pid of strays) signal(pid, "SIGKILL");
    while (running.size) await new Promise((wait) => setTimeout(wait, 100));
  };

  const interrupt = (name) => {
    log(`[test-runner] 收到 ${name}，收掉在跑的 ${running.size} 条。`);
    failure ??= { leaf: null, code: 128 + (name === "SIGINT" ? 2 : 15) };
    void stopAll();
  };
  const onTerm = () => interrupt("SIGTERM");
  const onInt = () => interrupt("SIGINT");
  process.on("SIGTERM", onTerm).on("SIGINT", onInt);

  try {
    let next = 0;
    const worker = async () => {
      while (!failure && next < queue.length) {
        const result = await launch(queue[next++]);
        if (failure) {
          if (result.status.code !== 0 && !result.status.skipped) log(`[test-runner] 已中止：${result.leaf.label}`);
          continue;
        }
        report(result);
        if (result.status.code !== 0) {
          failure = { leaf: result.leaf, code: result.status.code || 1 };
          if (running.size) log(`\n[test-runner] ${result.leaf.label} 未通过，收掉在跑的 ${running.size} 条。`);
          await stopAll();
          return;
        }
        if (--remaining[result.leaf.step] === 0) steps[result.leaf.step].onPass?.();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  } finally {
    process.off("SIGTERM", onTerm).off("SIGINT", onInt);
    for (const stage of stages.values()) await stage.then((started) => started.stop(), () => undefined);
    rmSync(logs, { recursive: true, force: true });
    writeHistory(timings);
  }
  return failure ?? { leaf: null, code: 0 };
}

// Windows 上没有 /bin/sh 和 ps，进程组也是另一套语义：照旧按链一步一步交给 npm 跑。
function runSequentially(repo, steps, env, log) {
  for (const step of steps) {
    const args = step.workspace === "." ? ["run", step.script] : ["-w", step.workspace, "run", step.script];
    const result = spawnSync(NPM, args, { ...NPM_SPAWN_OPTS, cwd: repo, stdio: "inherit", env });
    if (result.error) log(`[test-runner] 无法启动 ${step.workspace} ${step.script}：${result.error.message}`);
    if (result.signal) log(`[test-runner] ${step.workspace} ${step.script} 被信号 ${result.signal} 终止。`);
    if (result.status !== 0) return { leaf: { label: `${step.workspace} ${step.script}`, step: steps.indexOf(step) }, code: result.status || 1 };
    step.onPass?.();
  }
  return { leaf: null, code: 0 };
}

export function defaultJobs() {
  const requested = Number(process.env.ASH_TEST_JOBS);
  if (Number.isInteger(requested) && requested > 0) return requested;
  return Math.max(2, Math.min(8, Math.floor(availableParallelism() / 2)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [workspace, script] = process.argv.slice(2);
  if (!workspace || !script) {
    console.error("用法：node scripts/test-runner.mjs <workspace> <script>");
    process.exit(2);
  }
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const { leaf, code } = await runSteps(repo, [{ workspace, script }]);
  console.log(code === 0 ? `\n[test-runner] ${workspace} ${script} 全部通过。` : `\n[test-runner] 未通过${leaf ? `：${leaf.label}` : ""}。`);
  process.exit(code);
}

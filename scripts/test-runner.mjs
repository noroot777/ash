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
import { descendants, marked, pause, signal } from "./test-runner-processes.mjs";

const manifest = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

// `npm -w <ref>` 跟 npm 一个认法：先按包名，否则当成相对**发起这条链的包目录**的路径 ——
// 子包里写 `npm -w server` 指的是它自己底下的 server，npm 会报找不到，这里也不能替它圆过去。
function workspaceResolver(repo) {
  const names = new Map();
  const dirs = new Set([repo]);
  for (const entry of manifest(repo).workspaces ?? []) {
    const dir = resolve(repo, entry);
    dirs.add(dir);
    const { name } = manifest(dir);
    if (name) names.set(name, dir);
  }
  return (from, ref) => names.get(ref) ?? (dirs.has(resolve(from, ref)) ? resolve(from, ref) : undefined);
}

/** 把 `<workspace>` 包里的 `<script>` 链展开成叶子，顺序与原链一致。 */
export function expandChain(repo, workspace, script) {
  const findWorkspace = workspaceResolver(repo);
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
        const target = findWorkspace(dir, other[1]);
        if (!target) throw new Error(`找不到 workspace ${other[1]}（${relative(repo, dir) || "."} 的 ${name}）`);
        visit(target, other[2]);
      } else leaves.push({ cwd: dir, command: part, script: name, label: `${relative(repo, dir) || "."}: ${part}` });
    }
  };
  const start = findWorkspace(repo, workspace);
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

// 什么时候退出只由执行器决定：它得先把叶子收干净才能走。台子里的第三方库会在执行器进程上
// 装「收到信号就自己关掉然后 process.exit」的处理（Playwright 的 launchServer 装 SIGINT/SIGTERM/
// SIGHUP，vite 的 createServer 装 SIGTERM 和 stdin 结束），哪个先跑哪个就把执行器带走了，
// 收场还没开始。所以起台子期间新装上的这几类处理一律摘掉，台子由执行器在收尾时自己 stop。
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
async function startStageExclusively(module) {
  const before = new Map(EXIT_SIGNALS.map((name) => [name, process.listeners(name)]));
  const stdinBefore = process.stdin.listeners("end");
  try {
    return await import(module).then((loaded) => loaded.startSharedStage());
  } finally {
    for (const name of EXIT_SIGNALS) {
      for (const listener of process.listeners(name)) {
        if (!before.get(name).includes(listener)) process.removeListener(name, listener);
      }
    }
    for (const listener of process.stdin.listeners("end")) {
      if (!stdinBefore.includes(listener)) process.stdin.removeListener("end", listener);
    }
  }
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

/**
 * 跑一组步骤（每步 = 一条链）。所有叶子进同一个池子（排队顺序见 schedule）；某步的叶子全部绿了
 * 就报这一步通过。返回第一条红的叶子（全绿为 null）和它的退出码。
 *
 * 不变量：无论怎么结束（全绿、某条红、执行器自己出错、收到信号），返回之前这一轮起过的进程
 * 都已经收干净 —— 包括已经退出的叶子留下的后台进程。
 */
export async function runSteps(repo, steps, { jobs = defaultJobs(), env = process.env, log = console.log } = {}) {
  if (process.platform === "win32" || env.ASH_TEST_RUNNER === "serial") return runSequentially(repo, steps, env, log);
  const queue = schedule(steps.flatMap((step, index) => expandChain(repo, step.workspace, step.script)
    .map((leaf) => ({ ...leaf, step: index }))), readHistory());
  const timings = {};
  const remaining = steps.map((_, index) => queue.filter((leaf) => leaf.step === index).length);
  const logs = mkdtempSync(join(tmpdir(), "ash-test-runner-"));
  const owner = `ASH_TEST_RUNNER_${process.pid}_${Date.now().toString(36)}`;
  const stages = new Map();
  const running = new Map();
  let failure = null;
  let done = 0;
  const total = queue.length;
  log(`[test-runner] ${total} 条测试，${jobs} 路并行。`);

  const stageEnv = (cwd) => {
    const module = stageModule(cwd);
    if (!module) return Promise.resolve({});
    if (!stages.has(module)) stages.set(module, startStageExclusively(module));
    return stages.get(module).then((stage) => stage.env);
  };

  // 收掉一批进程组和带记号的进程：先 SIGTERM 给它们收尾的机会，到点 SIGKILL，再确认真的没了。
  // unconfirmed = 进程清单没看全，或者强杀之后还在 —— 这时不能说「收干净了」。
  const sweep = async (groups, leafIndex) => {
    const look = () => {
      const found = marked(owner, leafIndex);
      const alive = groups.filter((group) => signal(-group, 0)).map((group) => -group);
      return { targets: [...alive, ...found.pids], complete: found.complete };
    };
    let seen = look();
    const count = seen.targets.length;
    if (count) {
      for (const pid of seen.targets) signal(pid, "SIGTERM");
      for (const deadline = Date.now() + 3_000; seen.targets.length && Date.now() < deadline; seen = look()) await pause(100);
      for (const pid of seen.targets) signal(pid, "SIGKILL");
      for (const deadline = Date.now() + 2_000; seen.targets.length && Date.now() < deadline; seen = look()) await pause(100);
    }
    return { count, unconfirmed: !seen.complete || seen.targets.length > 0 };
  };

  // `sh -c` 当 shield：detached 让 sh 自己当进程组组长，被测脚本是组内的普通成员 —— 跟在
  // `npm run` 底下「继承调用方的组、组长另有其人」同形。不能 detached 被测脚本本身：一批产品
  // 代码的职责就是杀干净同组进程，它当了组长就会把自己杀掉（exit 143、日志却全是 passed）。
  // 命令后面那句 `exit` 不能省，否则 sh 会把自己 exec 掉，被测脚本又成了组长。
  const launch = async (leaf) => {
    const index = queue.indexOf(leaf);
    let extra;
    try {
      extra = await stageEnv(leaf.cwd);
    } catch (error) {
      return { leaf, status: { code: 1, error: new Error(`共用台子起不来：${error?.message ?? error}`) }, seconds: 0 };
    }
    // 等台子的这段时间里别的叶子可能已经红了、收场也扫过了，这时再起就成了没人收的孤儿。
    if (failure) return { leaf, status: { code: 1, skipped: true } };
    const file = join(logs, `${index}.log`);
    const startedAt = Date.now();
    let child;
    try {
      const output = openSync(file, "w");
      try {
        child = spawn("/bin/sh", ["-c", `${leaf.command}\n__rc=$?; exit $__rc`], {
          cwd: leaf.cwd,
          detached: true,
          stdio: ["ignore", output, output],
          env: { ...env, ...extra, [owner]: String(index), npm_lifecycle_event: leaf.script, PATH: binPath(repo, leaf.cwd, env.PATH) },
        });
      } finally {
        closeSync(output);
      }
    } catch (error) {
      return { leaf, file, status: { code: 1, error }, seconds: 0 };
    }
    running.set(leaf, child);
    const status = await new Promise((settle) => {
      child.once("error", (error) => settle({ code: 127, error }));
      child.once("exit", (code, killed) => settle({ code: code ?? 1, killed }));
    });
    // 主进程退了不等于这条叶子收干净了：它的组里、它 detached 出去的，都还得收。收的过程出了
    // 异常也要把它从 running 里拿掉，否则 stopAll 会一直等一条再也没人结算的叶子。
    let swept;
    try {
      swept = await sweep(child.pid > 0 ? [child.pid] : [], index);
    } catch (error) {
      swept = { count: 0, unconfirmed: true, error };
    } finally {
      running.delete(leaf);
    }
    status.leftovers = swept.count;
    if (swept.unconfirmed) {
      status.unconfirmed = swept.error?.message ?? "进程清单没看全，或者强杀之后还在";
      status.code ||= 1;
    }
    return { leaf, file, status, seconds: (Date.now() - startedAt) / 1000 };
  };

  const report = ({ leaf, file, status, seconds }) => {
    const passed = status.code === 0;
    timings[leaf.label] = { seconds, failed: !passed };
    done += 1;
    log(`\n── [${done}/${total}] ${passed ? "✓" : "✗"} ${leaf.label}（${seconds.toFixed(1)}s）`);
    try {
      if (file && existsSync(file)) process.stdout.write(readFileSync(file));
    } catch (error) {
      log(`[test-runner] 读不到这条的输出：${error.message}`);
    }
    if (status.error) log(`[test-runner] 无法启动：${status.error.message}`);
    if (status.killed) log(`[test-runner] 被信号 ${status.killed} 终止。`);
    if (status.leftovers) log(`[test-runner] 退出后还留着 ${status.leftovers} 个进程（组），已收掉。`);
    if (status.unconfirmed) log(`[test-runner] 无法确认这条起的进程已经收干净（${status.unconfirmed}），按未通过算。`);
  };

  // 收掉在跑的叶子，等到每一条都退出、各自的残留也收完（launch 里那次 sweep）才返回。
  const stopAll = async () => {
    const shields = [...running.values()].map((child) => child.pid).filter((pid) => pid > 0);
    // 先记下整棵树：组杀只到 shield 那一组，清空了环境又 detached 出去的子进程只能按父子关系补刀。
    const strays = descendants(shields).pids;
    for (const pid of shields) signal(-pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (running.size && Date.now() < deadline) await pause(100);
    for (const pid of shields) signal(-pid, "SIGKILL");
    for (const pid of strays) signal(pid, "SIGKILL");
    while (running.size) await pause(100);
  };

  // 所有红都走这里：记下第一条，然后收场。之后再红的（多半是被收掉的）只报「已中止」。
  const fail = async (leaf, code, message, reason) => {
    if (failure) return;
    failure = { leaf, code: code || 1, reason };
    if (message) log(`[test-runner] ${message}`);
    if (leaf && running.size) log(`\n[test-runner] ${leaf.label} 未通过，收掉在跑的 ${running.size} 条。`);
    await stopAll();
  };

  // 信号处理从开跑一直挂到收尾结束：收尾期间再来一次信号也只是记一笔，不会把执行器打断在
  // 半截（默认行为就是直接退出）。
  const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  const interrupt = (name) => {
    log(`[test-runner] 收到 ${name}，收掉在跑的 ${running.size} 条。`);
    void fail(null, SIGNAL_CODES[name], undefined, `收到 ${name}，回归被中断`);
  };
  const handlers = EXIT_SIGNALS.map((name) => [name, () => interrupt(name)]);
  for (const [name, handler] of handlers) process.on(name, handler);

  let settled = false;
  try {
    let next = 0;
    const worker = async () => {
      while (!failure && next < queue.length) {
        const leaf = queue[next++];
        try {
          const result = await launch(leaf);
          if (failure) {
            if (result.status.code !== 0 && !result.status.skipped) log(`[test-runner] 已中止：${leaf.label}`);
            continue;
          }
          report(result);
          if (result.status.code !== 0) return await fail(leaf, result.status.code);
          if (--remaining[leaf.step] === 0) steps[leaf.step].onPass?.();
        } catch (error) {
          return await fail(leaf, 1, `执行器自身出错（${leaf.label}）：${error?.stack ?? error}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
    settled = true;
  } finally {
    // 正常走到这里时 running 已经空了；万一是异常跳出来的，先记成红（还在等台子的叶子就不会
    // 再起），再照样收干净往下走。
    if (!settled) failure ??= { leaf: null, code: 1, reason: "执行器自身出错" };
    await stopAll();
    let final;
    try {
      final = await sweep([]);
    } catch (error) {
      final = { count: 0, unconfirmed: true, error };
    }
    if (final.count) log(`[test-runner] 收尾时还有 ${final.count} 个本轮起的进程，已收掉。`);
    if (final.unconfirmed) {
      log(`[test-runner] 无法确认本轮起的进程都已收干净（${final.error?.message ?? "进程清单没看全，或者强杀之后还在"}），按未通过算。`);
      failure ??= { leaf: null, code: 1, reason: "无法确认本轮起的进程都已收干净" };
    }
    for (const stage of stages.values()) {
      try {
        await stage.then((started) => started.stop(), () => undefined);
      } catch (error) {
        log(`[test-runner] 共用台子收不掉：${error?.message ?? error}`);
        failure ??= { leaf: null, code: 1, reason: "共用台子收不掉" };
      }
    }
    rmSync(logs, { recursive: true, force: true });
    writeHistory(timings);
    for (const [name, handler] of handlers) process.off(name, handler);
  }
  return failure ?? { leaf: null, code: 0 };
}

// Windows 上没有 /bin/sh 和 ps，进程组也是另一套语义：照旧按链一步一步交给 npm 跑。
// 其它平台设 ASH_TEST_RUNNER=serial 也走这条，门禁自检靠它在本机核对这份契约。
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

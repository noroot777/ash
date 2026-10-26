// 「命令在被测快照里压根没解析出来」这一档的端到端回归。
//
// 从 test-accept-gate.ts 里拆出来（第 2 轮审查 F3：那个文件被这组用例顶到 732 行，超了
// 根 CLAUDE.md 的 700 行上限）。
//
// 这里跑**真实 npm**，不是自己写的 runner 模仿它的措辞：两轮审查的反例都是用真 npm 复现
// 的，而这一档现在的判据是「起跑前读 package.json 的 scripts」，自己写的 runner 恰好绕开
// 了那个判据（它的入口是 `./runner.sh`，缺的是传给它的参数，谁也证明不了顶层没跑）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { acceptGateRuns, projects, sessions, tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { gateFailurePrompt } from "../src/accept-gate-messages.js";
import { diagnoseGateFailure } from "../src/accept-gate-diagnosis.js";
import { foreignOutputIn } from "../src/accept-gate-miss.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { releaseTurn } from "../src/turn-lock.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

type Ctx = {
  makeRepo: (name: string) => string;
  seedProject: (name: string, repo: string, gateCommand: string | null) => Promise<string>;
  seedTask: (projectId: string, repo: string, taskId: string, file: string) => Promise<string>;
  taskRow: (taskId: string) => Promise<{ stage: string | null }>;
  settled: (taskId: string) => Promise<void>;
  runsOf: (taskId: string) => Promise<GateRow[]> | { then: (f: (rows: GateRow[]) => unknown) => unknown };
  createdAt: string;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * 夹具的 package.json。`description` 里**故意**整词写着 `test:accept`，而 `scripts` 里没有：
 * 这就是第 2 轮审查 F2 那条反例的输入形状 —— 按「出现这个名字的文件集合有没有新增」算，
 * 基线和目标两边都是 `{package.json}`，差集为空，于是结论反过来说「目标分支上也找不到、
 * 合进来也不会让它出现」，而它明明就定义在那儿。
 *
 * 基线里另有一个撞名的 `test:accept-merge`（含 `test:accept` 这个子串），第 1 轮审查 F3
 * 的那条反例也一起留在这儿。
 */
const manifest = (scripts: Record<string, string>) => `${JSON.stringify({
  name: "gate-fixture", private: true,
  description: "CI will invoke test:accept once the branch is up to date",
  scripts,
}, null, 2)}\n`;
const BASELINE_SCRIPTS = { build: "echo build", "test:accept-merge": "echo merge" };

export async function testGateMissingCommand(ctx: Ctx): Promise<void> {
  // 门禁用登录 shell 起命令，所以 npm 要在**那个** PATH 里找得到。找不到的话下面的断言会
  // 以一堆看不懂的方式红掉，不如在这儿一次说清。
  assert.doesNotThrow(() => execFileSync("sh", ["-lc", "command -v npm"], { stdio: "ignore" }),
    "这一组用真实 npm 复现原始事故形状（判据是起跑前读 package.json 的 scripts），登录 shell 里得有 npm");
  const repo = ctx.makeRepo("gate-missing-command");
  writeFileSync(join(repo, "package.json"), manifest(BASELINE_SCRIPTS));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "baseline manifest: mentions test:accept, does not define it");
  const mentionOnly = git(repo, "rev-parse", "HEAD");

  const projectId = await ctx.seedProject("gate-missing-command", repo, "npm run test:accept");
  const taskId = "gatemissing01";
  const wsPath = await ctx.seedTask(projectId, repo, taskId, "missing.txt");
  // 任务开工**之后**，目标分支才把这条命令加进去 —— 本机那四次（都是 `npm run test:accept`）
  // 的形状：验收命令是「现在配的那条」，跑的却是任务那份更早的快照。
  writeFileSync(join(repo, "package.json"), manifest({ ...BASELINE_SCRIPTS, "test:accept": "echo real acceptance" }));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "Move frontend regression from push to acceptance");
  const introduced = git(repo, "rev-parse", "HEAD");
  const before = git(repo, "rev-parse", "main");
  const seededSession = "gate-missing-session";
  await db.insert(sessions).values({
    id: seededSession, taskId, role: "single", agentType: "claude", executor: "claude",
    cwd: repo, startedAt: ctx.createdAt, turnStartedAt: ctx.createdAt, endedAt: ctx.createdAt, activeMs: 0,
  });

  // 归因只认任务**自己记下的**开工起点（审查四 F2）。真实的 ash 开 worktree 时会冻结它，
  // 共享夹具的 seedTask 没写，这里按真实语义补上 —— 否则下面每一条都只能落「归因未知」。
  const taskStart = git(wsPath, "rev-parse", "HEAD");
  await db.update(tasks).set({ worktreeStartCommit: taskStart }).where(eq(tasks.id, taskId));

  const latest = async () => (await ctx.runsOf(taskId) as GateRow[]).at(0)!;
  const first = await acceptTask(taskId);
  assert.equal(first.accepted, false, "命令没跑到，这一按一样不许合并");
  await ctx.settled(taskId);
  const run = await latest();
  assert.equal(run.status, "failed");
  assert.equal(run.exitCode, 1, "测试自己的前提：npm 缺脚本时退的是 1，不是 127");
  // 核心那一条：跟普通测试红了**不是同一种** failure。
  assert.equal(run.failure, "command_missing", "「命令点名要跑的东西不在树里」不能还叫 exit_code");
  assert.equal(git(repo, "rev-parse", "main"), before, "归类不改变拦不拦：目标分支仍一动不动");
  assert.equal((await ctx.taskRow(taskId)).stage, "verified");
  // 起跑**前**那份事实必须落在这一行上：结算可能发生在重启之后，而跑完再核一次拿到的是
  // 跑完之后的状态（审查 F1 那条自删脚本就是这么被说成「没启动」的）。
  assert.deepEqual(JSON.parse(run.entryProbe ?? "null"),
    { ask: "test:accept", resolved: false, by: "被测快照 package.json 的 scripts" },
    "起跑前核到的入口事实要原样落盘");
  // 「未启动」和「该不该改代码」是两件事，分开存（第 3 轮审查 F2）。这一条核出来是
  // not-mine：基线上没有定义、目标分支上有。
  assert.equal(run.missAttribution, "not-mine", "归因要跟未启动分开落盘");

  assert.ok(run.diagnosis, "归类结论必须落在那一行上，不能只在这一次响应里说一句");
  const conclusion = run.diagnosis!;
  assert.match(conclusion, /一行都没跑到/, "① 命令点名要跑的东西没解析出来");
  assert.match(conclusion, /起跑前核过/, "① 判据里有起跑前那份事实");
  assert.match(conclusion, /Missing script/, "① 判据里有 runner 自己说的那句（第二件必要条件）");
  assert.match(conclusion, /没有别的程序写过东西/, "① 判据里有「日志里没有别人的输出」（第三件）");
  // ② 定义级核实：撞名的 `test:accept-merge`（审查一 F3）和 description 里的整词提及
  //    （审查二 F2）都不许把结论带偏。
  assert.match(conclusion, /是有定义的/, "② 读出目标分支那份 manifest 核过，这是定义级事实");
  assert.match(conclusion, /package\.json/, "② 它在目标分支上的落点");
  assert.match(conclusion, new RegExp(introduced.slice(0, 8)), "② 最早把它写进那个文件的是哪次提交");
  // 基线那次提交的 package.json 里**整词**写着 test:accept（在 description 里），但没定义它。
  // 按文字检索追引入提交会指到它身上（第 3 轮审查 F3），所以这一条得逐个提交核定义。
  assert.equal(new RegExp(mentionOnly.slice(0, 8)).test(conclusion), false,
    "② 只在文字里提过的那次提交不是定义的引入提交（审查三 F3）");
  assert.match(conclusion, /落后 main 1 个提交/, "② 任务分支落后目标分支多少");
  assert.equal(/上也找不到/.test(conclusion), false, "定义就在目标分支上，不许反过来说「也没有」（审查 F2）");
  assert.equal(/文字命中/.test(conclusion), false, "定义级事实不该退回文字命中那一档的对冲");
  // ③ 核实过目标分支上有，这一档才给合入建议。
  assert.match(conclusion, /把 main 合进任务分支/, "③ 出路一：合目标分支再验收");
  // 「目标上有」推不出「合进来就有」（第 8 轮审查 F3：合法的自定义合并驱动让干净合并后照旧
  // 缺它）。所以这一档只许给候选出路 + 让用户合完自己核一眼。
  assert.match(conclusion, /合完先核一眼这条命令在不在树里/, "③ 合入建议必须带「合完自己核一眼」");
  assert.equal(/就在树里了/.test(conclusion), false, "不许保证合进来它就在树里（审查八 F3）");
  assert.match(conclusion, /跳过前置命令/, "③ 出路二：这次显式跳过");
  assert.equal(/\*\*|`/.test(conclusion), false, "结论要纯文本：日志和 MCP 回执都不渲染 markdown");
  assert.match(readFileSync(run.logPath, "utf8"), /一行都没跑到/, "结论也要写进这一次的日志");
  // ash 结算时把归类结论**整段**追加进日志，而这一档的结论是多行的。只给第一行打 `[ash]`
  // 标记，后面几行就会被第三件必要条件当成「别的程序写的」，于是同一份日志重新归类（回流、
  // 重新交接、下面的对照组九都会走到）就从「一行都没跑到」退成「只敢报观察」—— 第 8 轮那次
  // 回归就是这么红的。所以 ash 的注记要逐行自带标记。
  assert.ok(conclusion.includes("\n"), "前提：这一档的结论本来就是多行的");
  assert.equal(foreignOutputIn(readFileSync(run.logPath, "utf8"), "npm"), false,
    "ash 自己追加进去的每一行都要自带标记，不然它会把自己的结论当成别人的输出");
  const timeline = () => readFileSync(sessionTranscriptPath(taskId, seededSession), "utf8");
  for (let i = 0; i < 200 && !/一行都没跑到/.test(timeline()); i++) await sleep(25);
  assert.match(timeline(), /一行都没跑到/, "结论要单独进时间线（用户刷新后唯一找得回的地方）");

  // 交回给 agent 的那份字：不许派「去修代码」这件它根本做不到的活，也不许自己断言
  // 「跟本次改动无关」（审查二 F1 末条：那件事由诊断那一层去核，不由这份模板去推）。
  const promptOf = (failure: "command_missing" | "exit_code") => gateFailurePrompt({
    command: run.command, summary: "未通过", logPath: run.logPath, tail: "",
    cwd: run.cwd, sourceCwd: repo, failure, diagnosis: conclusion,
    missAttribution: run.missAttribution as "not-mine",
  });
  const prompt = promptOf("command_missing");
  assert.match(prompt, /不要为这件事改任何代码/, "这一种不许让 agent 去改代码");
  assert.match(prompt, /不要为了确认而反复复跑/, "四次实测里烧掉的就是这几遍复跑");
  assert.match(prompt, /转述给用户/, "出路由用户拍板，agent 只负责转述");
  assert.equal(/这条红跟你这次的改动无关/.test(prompt), false,
    "缺失推不出「与本次改动无关」—— 模板不许自己下这个判断（审查二 F1）");
  assert.equal(prompt.includes("定位到底是哪一条红的"), false, "普通红那一版的措辞不该出现在这一种上");
  assert.equal(promptOf("exit_code").includes("不要为这件事改任何代码"), false,
    "带着诊断但 failure 仍是 exit_code 的那一档，不许被交成「不许修」（审查一 F2）");

  // 后面每条对照组都换一条命令、重按一次验收。
  const again = async (command: string) => {
    await db.update(projects).set({ acceptGateCommand: command }).where(eq(projects.id, projectId));
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
    releaseTurn(taskId);
    await acceptTask(taskId);
    await ctx.settled(taskId);
    return latest();
  };

  // 对照组一：真跑起来并红了的命令，一个字都不许被改写。
  const real = await again("echo 真断言失败 >&2; exit 4");
  assert.equal(real.failure, "exit_code", "真跑起来、真红了的仍是 exit_code —— 归类不许吃掉真 bug");
  assert.equal(real.diagnosis, null, "普通的红没有「不是你的代码」这种结论可给");

  // 对照组二：命令的**入口文件**只有目标分支上有。这条判据是文件级事实，跟日志里说了
  // 什么无关 —— 夹具把 stderr 全丢掉，一个字都没有，它照样定得了性。
  writeFileSync(join(repo, "only-on-target.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "add gate entry script on target only");
  const entryIntroduced = git(repo, "rev-parse", "HEAD");
  const absentFile = await again("./only-on-target.sh 2>/dev/null");
  assert.equal(absentFile.failure, "command_missing", "入口文件不在快照里 = 命令点名要跑的东西不在树里");
  assert.match(absentFile.diagnosis ?? "", /起跑前核过 被测快照里的文件：没有 \.\/only-on-target\.sh/, "硬证据要出现在结论里");
  assert.match(absentFile.diagnosis ?? "", /只有目标分支上有/, "文件级事实可以直说");
  assert.equal(/文字命中/.test(absentFile.diagnosis ?? ""), false, "路径模式不是文字命中");
  assert.match(absentFile.diagnosis ?? "", new RegExp(entryIntroduced.slice(0, 8)), "要指出是哪次提交把它加到目标分支的");
  assert.match(absentFile.diagnosis ?? "", /把 main 合进任务分支/, "核实过目标分支上有，才给合入建议");

  // 对照组三（审查二 F1 末条）：基线上**有**、这次改动把它删了。那时「命令不在树里」仍然
  // 成立，但出路恰恰是去改代码 —— 所以 failure 不许被改写成「不用你修」那一档。
  writeFileSync(join(wsPath, "package.json"), manifest({ build: "echo build" }));
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "task branch drops the acceptance script");
  const mine = await again("npm run test:accept-merge");
  assert.equal(mine.failure, "exit_code",
    "是这次改动把它弄没的，这条红要去改代码，不能摆成「不要动代码」（审查二 F1）");
  assert.match(mine.diagnosis ?? "", /开工基线上/, "要说清它在基线上是有的");
  assert.match(mine.diagnosis ?? "", /删掉或改名/, "要指出最可能的原因");
  assert.equal(mine.missAttribution, "mine", "核出来是这次改动弄没的，归因要落盘");
  assert.equal(gateFailurePrompt({ command: mine.command, summary: "未通过", logPath: mine.logPath, tail: "",
    cwd: mine.cwd, sourceCwd: repo, failure: mine.failure, diagnosis: mine.diagnosis,
    missAttribution: mine.missAttribution as "mine" })
    .includes("不要为这件事改任何代码"), false, "这一种交回去要让它修");

  // 对照组四（审查二 F1 反例①）：顶层**跑起来了**，缺的是它内部那一层点名的**同名**脚本。
  // 日志跟顶层缺失长得一模一样，只有起跑前那份事实能分开两者。
  mkdirSync(join(wsPath, "child"), { recursive: true });
  writeFileSync(join(wsPath, "child", "package.json"), `${JSON.stringify({ name: "child", private: true, scripts: {} })}\n`);
  writeFileSync(join(wsPath, "check.cjs"),
    "console.log('ACCEPTANCE STARTED');\n"
    + "require('node:child_process').execSync('npm --prefix child run test:accept', { stdio: 'inherit' });\n");
  writeFileSync(join(wsPath, "package.json"), manifest({ build: "echo build", "test:accept": "node check.cjs" }));
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "task branch defines test:accept; child does not");
  const nested = await again("npm run test:accept");
  assert.match(readFileSync(nested.logPath, "utf8"), /ACCEPTANCE STARTED/, "测试自己的前提：顶层确实跑起来了");
  assert.match(readFileSync(nested.logPath, "utf8"), /Missing script: "test:accept"/, "测试自己的前提：日志跟顶层缺失一模一样");
  assert.equal(nested.failure, "exit_code", "顶层跑起来了，内部同名缺件不许冒充顶层缺失（审查二 F1）");
  assert.match(nested.diagnosis ?? "", /不是「它不在树里」那一种/, "核过入口在树里，只敢排除这一种");
  assert.equal(/确实跑起来了/.test(nested.diagnosis ?? ""), false,
    "在树里推不出跑起来了（审查三 F1：权限位、解释器都挡在前面）");
  assert.equal(nested.missAttribution, null, "inner 这一档没有「谁把它弄没的」可言");
  assert.equal(/一行都没跑到|跳过前置命令|合进任务分支/.test(nested.diagnosis ?? ""), false,
    "inner 不许摆那两条出路，也不许说测试没跑");

  // 对照组五（审查二 F2）：目标分支上**确实**也没有。这一档才敢说「合进来也不会让它出现」，
  // 而判据只能是定义级的 —— 文字检索查空什么都不证明。
  const nowhere = await again("npm run never-anywhere");
  assert.equal(nowhere.failure, "command_missing");
  assert.match(nowhere.diagnosis ?? "", /上也找不到/, "定义级核出来确实没有，这时才敢这么说");
  assert.match(nowhere.diagnosis ?? "", /合目标分支进来也不会让它出现/, "并且要明说合分支解决不了");
  assert.equal(/把 main 合进任务分支/.test(nowhere.diagnosis ?? ""), false, "这一档**绝不许**给合入建议");

  // 对照组六（审查二 F1 反例②）：入口起跑时在树里，命令跑起来之后把自己删了，再报断言失败。
  // 事后看就是「入口不存在」—— 只有起跑前那份落盘的事实挡得住这一条。
  writeFileSync(join(wsPath, "verify.sh"),
    "#!/bin/sh\necho ACCEPTANCE STARTED\nrm -- \"$0\"\necho ASSERTION FAILED >&2\nexit 1\n", { mode: 0o755 });
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "self-deleting verifier");
  const selfDeleted = await again("./verify.sh");
  assert.match(readFileSync(selfDeleted.logPath, "utf8"), /ASSERTION FAILED/, "测试自己的前提：它报的是断言失败");
  assert.deepEqual(JSON.parse(selfDeleted.entryProbe ?? "null"),
    { ask: "./verify.sh", resolved: true, by: "被测快照里的文件" }, "起跑那一刻它在树里");
  assert.equal(selfDeleted.failure, "exit_code", "一次真的断言失败，不许因为它删了自己就变成「没启动」");
  assert.equal(selfDeleted.diagnosis, null, "也不该给出任何「不是你的代码」的结论");

  // 对照组七（审查三 F1 反例②）：命令换了目录,就得去 runner **真会读的那份** manifest 里
  // 核。顶层没有这个名字、child 里有：按顶层核就会把一次真跑起来的红说成「没启动、不用修」。
  writeFileSync(join(wsPath, "child", "package.json"),
    `${JSON.stringify({ name: "child", private: true, scripts: { "test:accept": "echo CHILD RAN; exit 3" } })}\n`);
  writeFileSync(join(wsPath, "package.json"), manifest({ build: "echo build" }));
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "child defines test:accept; top level does not");
  const scoped = await again("npm --prefix child run test:accept");
  assert.match(readFileSync(scoped.logPath, "utf8"), /CHILD RAN/, "测试自己的前提：child 里那条真跑起来了");
  assert.deepEqual(JSON.parse(scoped.entryProbe ?? "null"),
    { ask: "test:accept", resolved: true, by: "被测快照 child/package.json 的 scripts" },
    "核的必须是 --prefix 指的那份 manifest");
  assert.equal(scoped.failure, "exit_code", "真跑起来、真红了，不许因为顶层没这个名字就说它没启动");
  assert.equal(scoped.missAttribution, null, "它不是「没解析出来」那一档");
  assert.equal(/一行都没跑到/.test(scoped.diagnosis ?? ""), false, "更不许摆成免修那一档");

  // 对照组八（审查三 F1）：入口**在树里**、但不可执行。存在性推不出执行 —— 这一条就是
  // 「在树里 ≠ 跑起来了」的反例本身，所以那句对冲必须留着。
  writeFileSync(join(wsPath, "noexec.sh"), "#!/bin/sh\necho SHOULD NOT RUN\n", { mode: 0o644 });
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "entry present but not executable");
  const noexec = await again("./noexec.sh");
  assert.equal(noexec.exitCode, 126, "测试自己的前提：在树里但不可执行时 shell 退 126");
  assert.deepEqual(JSON.parse(noexec.entryProbe ?? "null"),
    { ask: "./noexec.sh", resolved: true, by: "被测快照里的文件" }, "起跑前核到的是「在树里」");
  assert.equal(noexec.failure, "exit_code", "在树里就不是「不在树里」那一种");
  assert.match(noexec.diagnosis ?? "", /不是「它不在树里」那一种/, "核过的那一件照说");
  assert.match(noexec.diagnosis ?? "", /这一层说不了/, "没核过的那一件不许替它说");
  assert.equal(/确实跑起来了|一行都没跑到/.test(noexec.diagnosis ?? ""), false,
    "它既没跑进去，也不是「不在树里」—— 两头都不许冒认");

  // 对照组十（审查四 F3）：目标分支上真正带进这个定义的那次提交**读不动**（manifest 超
  // 过 2 MiB 上限），紧跟着一次只缩短说明文字的提交读得动。读不出来不等于「那时还没有」，
  // 所以后者不许被冒认成「最早把这个定义带进来的」。
  const scriptsWithF3 = { ...BASELINE_SCRIPTS, "test:accept": "echo real acceptance", "test:accept-f3": "echo f3" };
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "gate-fixture", private: true, description: "x".repeat(2_200_000), scripts: scriptsWithF3 }, null, 2)}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "add test:accept-f3 with a huge description");
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "gate-fixture", private: true, description: "short", scripts: scriptsWithF3 }, null, 2)}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "DESCRIPTION ONLY shortened; acceptance already existed");
  const descriptionOnly = git(repo, "rev-parse", "HEAD");
  const f3 = await again("npm run test:accept-f3");
  assert.equal(f3.failure, "command_missing", "快照里没有这个脚本，这一条照旧成立");
  assert.match(f3.diagnosis ?? "", /是有定义的/, "目标分支 HEAD 读得动，存在性照常核出来");
  assert.match(f3.diagnosis ?? "", /哪次提交带进来的，这次没追出来/, "读不出来就说没追出来，不许编一个");
  assert.equal(new RegExp(descriptionOnly.slice(0, 8)).test(f3.diagnosis ?? ""), false,
    "只缩短说明文字那次不许被冒认成引入提交（审查四 F3）");
  assert.match(f3.diagnosis ?? "", /把 main 合进任务分支/, "存在性这一档的出路照给");

  // 对照组十一（审查四 F2）：任务从**父任务分支**开工，删掉继承来的验收脚本。Git 共同祖先
  // 是更早的目标分支、上面本来就没有这个脚本，真实起点上却有 —— 按共同祖先判会得出
  // 「不是你删的」并发一张免修令，而这时正确的出路恰恰是把它改回来。
  writeFileSync(join(wsPath, "package.json"), manifest({ build: "echo build", "test:accept-inherited": "echo inherited" }));
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "parent task adds the inherited acceptance script");
  const inheritedStart = git(wsPath, "rev-parse", "HEAD");
  writeFileSync(join(wsPath, "package.json"), manifest({ build: "echo build" }));
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "this task deletes the inherited acceptance script");
  // 测试自己的前提：共同祖先上没有它 —— 旧实现按 merge-base 判就会答错。
  const mergeBase = git(wsPath, "merge-base", "HEAD", "main");
  assert.equal(/test:accept-inherited/.test(git(wsPath, "show", `${mergeBase}:package.json`)), false,
    "前提：共同祖先上没有这个脚本");
  await db.update(tasks).set({ worktreeStartCommit: inheritedStart }).where(eq(tasks.id, taskId));
  const inherited = await again("npm run test:accept-inherited");
  assert.equal(inherited.missAttribution, "mine",
    "真实起点上有、这份快照里没了 = 这次改动弄没的（审查四 F2）");
  assert.equal(inherited.failure, "exit_code", "这条红要去改代码，不许摆成免修那一档");
  assert.match(inherited.diagnosis ?? "", /开工基线上/, "要说清它在开工起点上是有的");
  assert.equal(gateFailurePrompt({ command: inherited.command, summary: "未通过", logPath: inherited.logPath,
    tail: "", cwd: inherited.cwd, sourceCwd: repo, failure: inherited.failure,
    diagnosis: inherited.diagnosis, missAttribution: inherited.missAttribution as "mine" })
    .includes("不要为这件事改任何代码"), false, "继承来的脚本被自己删掉，不许发免修令");
  // 起点记不下来（旧任务、字段为空）就只能落未知 —— 不许退回共同祖先去补一个答案。
  await db.update(tasks).set({ worktreeStartCommit: null }).where(eq(tasks.id, taskId));
  const noStart = await again("npm run test:accept-inherited");
  assert.equal(noStart.missAttribution, "unknown", "没有起点就老实说未知");
  assert.equal(noStart.failure, "command_missing", "未启动这件事照旧核得出来");
  assert.match(noStart.diagnosis ?? "", /先核一眼这件事/, "未知时要让它先去核");

  // 对照组十九（第 8 轮审查 F1 的能力边界，实测钉住）：命令自己把 runner 的嘴堵上了。
  // 本机 npm 11.17.0 下 `npm run --silent nosuch` **一个字都不打印** —— 第二件必要条件
  // （runner 自己说它解析不出这个名字）拿不到。判据一个字都不放松：这里只许报观察，
  // 因为一个被 --silent 吞掉输出的脚本真跑红了也长这样，误判成「没启动」就是发错免修令。
  const silenced = await again("npm run --silent test:accept-inherited");
  assert.equal(silenced.failure, "exit_code", "嘴被堵上就只报观察，这条红照样要去看");
  assert.equal(silenced.missAttribution, null, "观察档不给归因");
  assert.match(silenced.diagnosis ?? "", /并没说它解析不出这个名字/, "说清缺的是哪一件");
  assert.match(silenced.diagnosis ?? "", /把这条命令里的「--silent」去掉再点一次验收/,
    "给一条用户自己就能拿到确切结论的出路");
  assert.equal(/\*\*|`/.test(silenced.diagnosis ?? ""), false, "这一档的结论同样要纯文本");
  assert.equal(gateFailurePrompt({ command: silenced.command, summary: "未通过", logPath: silenced.logPath,
    tail: "", cwd: silenced.cwd, sourceCwd: repo, failure: silenced.failure,
    diagnosis: silenced.diagnosis, missAttribution: silenced.missAttribution as null })
    .includes("不要为这件事改任何代码"), false, "拿不到判据就不许发免修令");
  // 恢复真实起点：下一条要单独验证「目标分支读不到 → 未知」，起点不该同时缺着。
  await db.update(tasks).set({ worktreeStartCommit: taskStart }).where(eq(tasks.id, taskId));

  // 对照组九（审查三 F2）：未启动这件事核出来了，但**归因**没核出来。旧版本把「核过、
  // 基线上也没有」和「压根没核出来」塞进同一个 command_missing，于是任务真把验收脚本删了、
  // 而目标 ref 又恰好读不到时，agent 被按住不许修。
  //
  // 这个条件真跑不出来：门禁的目标分支是验收那一刻从任务上解析的，实测把 mergeTargetBranch
  // 指向一条不存在的分支时，那一按最后落在 exit_code 上，走不到归因这一层。所以这里拿主用例
  // 那一行**真实落盘的记录**（真 npm 跑出来的日志 + 起跑前核过的入口事实），只把「目标分支
  // 读不到」这一个条件换掉 —— 非 git 项目、目标 ref 被删、诊断超预算都落在这一档。
  const unknown = await diagnoseGateFailure({ ...run, targetBranch: null, targetCommit: null },
    { failure: "exit_code", exitCode: run.exitCode });
  assert.equal(unknown?.failure, "command_missing", "未启动这件事是起跑前核过的，照旧成立");
  assert.equal(unknown?.attribution, "unknown", "目标分支读不到，归因就是没核出来 —— 不许算成 not-mine");
  assert.match(unknown?.diagnosis ?? "", /在目标分支上是什么情形，这次没能核对出来/,
    "如实说目标分支那件事没核对出来");
  assert.match(unknown?.diagnosis ?? "", /先核一眼这件事/, "归因未知时要让它先去核，不是免修");
  const unknownPrompt = gateFailurePrompt({ command: run.command, summary: "未通过",
    logPath: run.logPath, tail: "", cwd: run.cwd, sourceCwd: repo,
    failure: unknown?.failure ?? null, diagnosis: unknown?.diagnosis ?? null,
    missAttribution: unknown?.attribution ?? null });
  assert.equal(unknownPrompt.includes("不要为这件事改任何代码"), false, "归因没核出来，不许发免修令");
  assert.match(unknownPrompt, /是不是你这次改动把它弄没的/, "要先去核归因");
  assert.match(unknownPrompt, /改回来或同步改配置/, "核下来是自己弄没的就该去改");

  // 对照组十二（审查五 F1、六 F1）：命令行上一个字都看不出来 —— `.npmrc` 把 runner 指到了
  // 子项目，真跑的是那边那个脚本。只核根目录那份 manifest，就会把一次真断言失败说成「一行
  // 都没跑到、不要改代码」。
  //
  // 这里用的是**数组写法** `workspace[]=child`：第 6 轮审查实测，按键名比对的旧判据拦住了
  // `workspace=child`、却放过了它。现在这件事整块交给 npm 自己回答（它会改口给出按包分组的
  // 嵌套答案，这一层据此交白卷），两种写法在 test-accept-gate-command.ts 里都真起 npm 跑过。
  writeFileSync(join(wsPath, "package.json"), `${JSON.stringify({
    name: "gate-fixture", private: true, workspaces: ["child"], scripts: { build: "echo build" } }, null, 2)}\n`);
  writeFileSync(join(wsPath, "child", "package.json"), `${JSON.stringify({
    name: "child", private: true,
    scripts: { "test:accept": "echo ACCEPTANCE STARTED; echo ASSERTION FAILED >&2; exit 1" } }, null, 2)}\n`);
  writeFileSync(join(wsPath, ".npmrc"), "workspace[]=child\n");
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "npmrc points npm run at the child workspace");
  const viaRc = await again("npm run test:accept");
  assert.match(readFileSync(viaRc.logPath, "utf8"), /ACCEPTANCE STARTED/,
    "测试自己的前提：子项目那个脚本真跑起来了");
  // 第 8 轮之后这一层是纯读的：它读不出 `.npmrc` 这件事，于是会读出「根 manifest 里没有」。
  // **授权因此不在这一层** —— 真跑那次子项目的脚本往日志里写了东西，归类层第三件条件不成立。
  assert.deepEqual(JSON.parse(viaRc.entryProbe ?? "null"),
    { ask: "test:accept", resolved: false, by: "被测快照 package.json 的 scripts" },
    "这一层只报它读到的（命令行上解释出来的那份 manifest）");
  assert.equal(viaRc.failure, "exit_code", "一次真的断言失败，不许说成「没启动」（审查五/六/八 F1）");
  assert.equal(viaRc.missAttribution, null, "它不是「没解析出来」那一档");
  assert.match(viaRc.diagnosis ?? "", /有别的程序写过东西/, "要说清凭什么不敢下那个结论");
  assert.equal(/一行都没跑到，这不是断言失败/.test(viaRc.diagnosis ?? ""), false, "不许摆成免修那一档");
  assert.equal(gateFailurePrompt({ command: viaRc.command, summary: "未通过", logPath: viaRc.logPath, tail: "",
    cwd: viaRc.cwd, sourceCwd: repo, failure: viaRc.failure, diagnosis: viaRc.diagnosis,
    missAttribution: viaRc.missAttribution as null }).includes("不要为这件事改任何代码"), false,
    "更不许发免修令");

  // 对照组十三（审查六 F1 反例②）：shell 的分组括号。`(./runner.sh)` 里那条**真被跑了**，
  // 旧版却把整个 `(./runner.sh)` 当成一个文件名去查，查不到就判「入口不在树里」并发免修令。
  writeFileSync(join(wsPath, "grouped.sh"),
    "#!/bin/sh\necho ACCEPTANCE STARTED\necho ASSERTION FAILED >&2\nexit 1\n", { mode: 0o755 });
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "entry runnable through a subshell group");
  const grouped = await again("(./grouped.sh)");
  assert.match(readFileSync(grouped.logPath, "utf8"), /ACCEPTANCE STARTED/,
    "测试自己的前提：括号里那条 shell 真跑了");
  assert.equal(grouped.entryProbe, null, "读不准的 shell 语义一律交白卷，不许拿字面文件名去查");
  assert.equal(grouped.failure, "exit_code", "一次真的断言失败，不许说成「没启动」");
  assert.equal(grouped.diagnosis, null, "也不许给出任何「不是你的代码」的结论");

  // 对照组十四（审查六 F1 反例③）：npm 内建的 `env`。`npm run --json` 列的表里没有它，可它
  // 真能跑 —— 实测 `npm run env -- node fail.cjs` 把 fail.cjs 跑了。「表里没有」在这个名字上
  // 推不出「没东西可跑」。
  rmSync(join(wsPath, ".npmrc"), { force: true });
  writeFileSync(join(wsPath, "fail.cjs"), 'console.log("FAIL SCRIPT RAN"); process.exit(1);\n');
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "builtin npm env script forwards to a real failing script");
  const builtin = await again("npm run env -- node fail.cjs");
  assert.match(readFileSync(builtin.logPath, "utf8"), /FAIL SCRIPT RAN/,
    "测试自己的前提：内建 env 真把后面那条命令跑了");
  assert.equal(builtin.entryProbe, null, "有默认行为的名字一律不认，哪怕它不在 scripts 表里");
  assert.equal(builtin.failure, "exit_code", "真跑起来、真红了，不许说成「没启动」");
  assert.equal(builtin.diagnosis, null, "也不许给出任何「不是你的代码」的结论");

  // 对照组十五（审查七 F1）：命令自己挑了另一个启动器 —— 前置 `PATH=bin` 把 `npm` 指到项目
  // 自带的那个脚本。起跑前这一问必须问**它**：上一版自己 execFile 起系统 npm，于是问的那个
  // 和跑的那个不是一回事，一次真断言失败被说成「入口不存在、不要改代码」。
  mkdirSync(join(wsPath, "bin"), { recursive: true });
  writeFileSync(join(wsPath, "bin", "npm"),
    "#!/bin/sh\necho ACCEPTANCE STARTED\necho ASSERTION FAILED >&2\nexit 1\n", { mode: 0o755 });
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "project ships its own npm launcher");
  const ownNpm = await again("PATH=bin npm run test:accept");
  assert.match(readFileSync(ownNpm.logPath, "utf8"), /ACCEPTANCE STARTED/,
    "测试自己的前提：真跑的是项目自带那个启动器");
  // 同上：这一层读的是根 manifest（它看不出 `PATH=bin` 换掉了 npm 本身），挡住它的是日志里
  // 那两行 —— 启动器自己写的输出不属于 npm 的自有报错。
  assert.deepEqual(JSON.parse(ownNpm.entryProbe ?? "null"),
    { ask: "test:accept", resolved: false, by: "被测快照 package.json 的 scripts" },
    "这一层只报它读到的那份");
  assert.equal(ownNpm.failure, "exit_code", "一次真的断言失败，不许说成「没启动」（审查七 F1）");
  assert.match(ownNpm.diagnosis ?? "", /有别的程序写过东西/, "要说清凭什么不敢下那个结论");
  assert.equal(gateFailurePrompt({ command: ownNpm.command, summary: "未通过", logPath: ownNpm.logPath, tail: "",
    cwd: ownNpm.cwd, sourceCwd: repo, failure: ownNpm.failure, diagnosis: ownNpm.diagnosis,
    missAttribution: ownNpm.missAttribution as null }).includes("不要为这件事改任何代码"), false,
    "更不许发免修令");

  // 对照组十六（审查七 F3、F4 共用一个拓扑）：定义在**共同祖先**上就有，父任务分支把它删了，
  // 本任务从那一版开工；目标分支这一侧只有一次「只改说明文字」的提交碰过那个文件。
  //   · F3：这时「目标分支上有」推不出「合它进来就有」—— 合并会保留源侧那个删除。
  //   · F4：`--not 快照` 剩下的最早一次提交只是「目标独有历史里最早看见它」，不是把它加
  //     进来的那次。旧实现把那次只改 description 的提交报成了引入提交。
  const f4Scripts = { ...scriptsWithF3, "test:accept-f4": "echo f4" };
  const described = (description: string) => `${JSON.stringify({
    name: "gate-fixture", private: true, description, scripts: f4Scripts }, null, 2)}\n`;
  writeFileSync(join(repo, "package.json"), described("acceptance docs v1"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "introduce test:accept-f4 on the shared history");
  const f4Introduced = git(repo, "rev-parse", "HEAD");
  // 任务这一侧先继承它（共同祖先因此落在上面那次提交上），再由父任务把它删掉。
  git(wsPath, "merge", "--no-edit", "-X", "theirs", "main");
  writeFileSync(join(wsPath, "package.json"), manifest(BASELINE_SCRIPTS));
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "parent task drops test:accept-f4");
  const droppedAt = git(wsPath, "rev-parse", "HEAD");
  // 目标分支这一侧：只改说明文字，定义一直在。
  writeFileSync(join(repo, "package.json"), described("acceptance docs v2, wording only"));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "WORDING ONLY on the acceptance docs");
  const wordingOnly = git(repo, "rev-parse", "HEAD");
  await db.update(tasks).set({ worktreeStartCommit: droppedAt }).where(eq(tasks.id, taskId));
  const kept = await again("npm run test:accept-f4");
  assert.equal(kept.failure, "command_missing", "快照里没有这个脚本，这一条照旧成立");
  assert.equal(kept.missAttribution, "not-mine", "开工起点上就没有了，不是本任务弄没的");
  assert.match(kept.diagnosis ?? "", /是有定义的/, "目标分支上确实有，存在性照说");
  // F4：引入提交只能是真正完成 absent→present 那一次,追不到就说追不到。
  assert.equal(new RegExp(wordingOnly.slice(0, 8)).test(kept.diagnosis ?? ""), false,
    "只改说明文字那次不许被报成「把这个定义加进去的」（审查七 F4）");
  assert.equal(new RegExp(f4Introduced.slice(0, 8)).test(kept.diagnosis ?? ""), false,
    "真正引入它的那次在共同历史上，不在目标分支独有的那段里,这次本来就追不到");
  assert.match(kept.diagnosis ?? "", /哪次提交带进来的，这次没追出来/, "追不到就如实说");
  // F3：合它进来恢复不了,就不许给那条出路。
  assert.match(kept.diagnosis ?? "", /一般保留这个删除/, "明说合进来一般恢复不了（审查七 F3）");
  assert.match(kept.diagnosis ?? "", /共同祖先上就有/, "说清为什么：删除在任务这一侧");
  assert.match(kept.diagnosis ?? "", /把那个定义取回来/, "给真正能解决的那条出路");
  assert.equal(/把 main 合进任务分支/.test(kept.diagnosis ?? ""), false,
    "恢复不了就不许摆出「合进来再点验收」那条出路");
  assert.match(kept.diagnosis ?? "", /跳过前置命令/, "另一条出路照给");
  assert.equal(/\*\*|`/.test(kept.diagnosis ?? ""), false,
    "结论要纯文本:这一档的出路也走日志和 MCP 回执,两边都不渲染 markdown");
  assert.equal(gateFailurePrompt({ command: kept.command, summary: "未通过", logPath: kept.logPath,
    tail: "", cwd: kept.cwd, sourceCwd: repo, failure: kept.failure, diagnosis: kept.diagnosis,
    missAttribution: kept.missAttribution as "not-mine" }).includes("不要为这件事改任何代码"), true,
    "归因核出来不是本任务弄没的,这一档仍然是免修");

  // 对照组十七（审查八 F2）：**一次验收只许跑一次项目代码**。
  //   判据不是「诊断有没有副作用的自觉」，而是数出来：项目把 `NODE_OPTIONS` 的 preload 当
  //   计数器，每起一个 node 进程追加一行。第 7 轮那版把两条 npm 查询插在用户命令前面，于是
  //   一次验收变成 3 次（审查实测，不插是 1 次）—— 继承的 NODE_OPTIONS、前置赋值里的
  //   preload、自带 npm 包装器的初始化动作都会跟着多跑。这一条钉住它回不来。
  const counter = join(mkdtempSync(join(tmpdir(), "ash-gate-count-")), "runs.log");
  writeFileSync(join(wsPath, "count.cjs"), [
    'const fs = require("node:fs");',
    `fs.appendFileSync(${JSON.stringify(counter)}, process.argv.slice(1).join(" ") + "\\n");`,
    "",
  ].join("\n"));
  // 夹具自己先过一遍语法：这份 preload 是拼出来的，拼坏了它一行都加载不了，而现象（计数为
  // 0、日志里有别的程序写过东西）跟「门禁把用户命令的环境改掉了」长得一模一样 —— 真撞过。
  execFileSync(process.execPath, ["--check", join(wsPath, "count.cjs")]);
  writeFileSync(join(wsPath, "package.json"), manifest({ build: "echo build" }));
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "preload counts every node process");
  const counted = await again("NODE_OPTIONS=--require=./count.cjs npm run test:accept");
  // 计数文件不在 = 一次都没跑到 —— 那同样是这一条要报的失败,但得把门禁日志一起打出来,
  // 否则只看见一个 ENOENT,分不清是「命令没起来」「preload 没加载」还是「这一按复用了旧结果」。
  const started = existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean) : [];
  assert.equal(started.length, 1,
    `一次验收只许跑一次项目代码，实际 ${started.length} 次（审查八 F2）：\n${started.join("\n")}`
    + `\n门禁日志（${counted.logPath}）：\n${readFileSync(counted.logPath, "utf8")}`);
  assert.equal(counted.failure, "command_missing", "这条命令确实没跑起来，结论照旧给得出");

  // 对照组十八（审查八 F1 反例）：脚本在**真跑那一刻**才被生成出来。
  //   起跑前读那份 manifest 时它不在；preload 一看 argv 里点名了 `test:accept` 就把它写进
  //   manifest，于是真跑那次解析得出来、跑了、报了断言失败。第 7 轮那版「起跑时问 npm 自己」
  //   问的是查询那一次（argv 里没有那个名字），答「没有」，于是一次真的失败被说成「一行都
  //   没跑到、不要改代码」。现在挡住它的是日志里那两行。
  writeFileSync(join(wsPath, "grow.cjs"), [
    'const fs = require("node:fs");',
    'if (process.argv.join(" ").includes("test:accept")) {',
    '  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));',
    '  if (!manifest.scripts["test:accept"]) {',
    '    manifest.scripts["test:accept"] = "echo ACCEPTANCE STARTED; echo ASSERTION FAILED >&2; exit 1";',
    '    fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2));',
    "  }",
    "}",
    "",
  ].join("\n"));
  execFileSync(process.execPath, ["--check", join(wsPath, "grow.cjs")]);
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "preload grows the acceptance script at real run time");
  const grown = await again("NODE_OPTIONS=--require=./grow.cjs npm run test:accept");
  assert.match(readFileSync(grown.logPath, "utf8"), /ACCEPTANCE STARTED/,
    "测试自己的前提：那个脚本真被生成出来并跑了");
  assert.match(readFileSync(grown.logPath, "utf8"), /ASSERTION FAILED/, "测试自己的前提：它报的是断言失败");
  assert.deepEqual(JSON.parse(grown.entryProbe ?? "null"),
    { ask: "test:accept", resolved: false, by: "被测快照 package.json 的 scripts" },
    "起跑前读那份 manifest 时它确实不在 —— 这一件成立也不够");
  assert.equal(grown.failure, "exit_code", "可它真跑了、真红了，不许说成「没启动」（审查八 F1）");
  assert.equal(grown.missAttribution, null, "它不是「没解析出来」那一档");
  assert.match(grown.diagnosis ?? "", /有别的程序写过东西/, "要说清凭什么不敢下那个结论");
  assert.equal(/一行都没跑到，这不是断言失败/.test(grown.diagnosis ?? ""), false, "不许摆成免修那一档");
  assert.equal(gateFailurePrompt({ command: grown.command, summary: "未通过", logPath: grown.logPath, tail: "",
    cwd: grown.cwd, sourceCwd: repo, failure: grown.failure, diagnosis: grown.diagnosis,
    missAttribution: grown.missAttribution as null }).includes("不要为这件事改任何代码"), false,
    "更不许发免修令");

  console.log("accept gate missing-command: 定义级核实 / 入口文件 / 这次改动删的 / 同名嵌套 / 目标也没有 / 自删入口 / 换目录 / 不可执行 / 归因未知 / 引入历史读不动 / 继承后删除 / npmrc 换落点 / shell 分组 / npm 内建 env / 自带启动器 / 合入恢复不了 + 引入提交 / 只跑一次项目代码 / 真跑时才生成的脚本 全部通过");
}

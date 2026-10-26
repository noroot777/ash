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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { acceptGateRuns, projects, sessions, tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { gateFailurePrompt } from "../src/accept-gate-messages.js";
import { diagnoseGateFailure } from "../src/accept-gate-diagnosis.js";
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
  assert.match(conclusion, /起跑前核过/, "① 判据是起跑前那份事实，不是日志措辞");
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
  assert.match(conclusion, /跳过前置命令/, "③ 出路二：这次显式跳过");
  assert.equal(/\*\*|`/.test(conclusion), false, "结论要纯文本：日志和 MCP 回执都不渲染 markdown");
  assert.match(readFileSync(run.logPath, "utf8"), /一行都没跑到/, "结论也要写进这一次的日志");
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

  console.log("accept gate missing-command: 定义级核实 / 入口文件 / 这次改动删的 / 同名嵌套 / 目标也没有 / 自删入口 / 换目录 / 不可执行 / 归因未知 全部通过");
}

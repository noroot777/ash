// 「发给模型的那几类消息，渲染出来到底多大」—— 体积闸和金样对比共用的同一台渲染机。
//
// 为什么盯渲染结果而不是源码文件：这些文本是由十几个常量拼起来的，源码行数跟实际注入
// 的字节数早就对不上（`scripts/root-budget.mjs` 盯的是源码，这里盯的是产物）。一条规则
// 从 A 文件搬到 B 文件，源码两边都变、注入体积一个字节没少。
//
// 路径会进正文（证据目录、报告路径），而 `mkdtemp` 的长度逐机不同 —— 所以**所有样本在
// 量之前都把舞台根路径替换成 `<ROOT>`**，否则同一份代码在两台机器上算出两个字节数。
//
// 调用方负责在 import 之前设好 `ASH_DB` / `ASH_RUNS_DIR`（都得在临时目录里）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";

export interface PromptSample {
  /** 预算表里的键，也是金样文件名。 */
  id: string;
  /** 已经把舞台路径归一成 `<ROOT>` 的正文。 */
  text: string;
  /**
   * **没归一过**的那一份。
   *
   * 归一会把舞台根缩成 7 个字节，于是「路径长到撑破整节」这类形态在归一之后恰好量不到 ——
   * 而那正是第 1 轮审查复现盲截用的输入。所以「固定契约完整 + 入口完整 + 总字节」那张表
   * 量的是这一份，顺带还能拿路径去盘上核实入口是不是真读得到。
   */
  raw: string;
  /**
   * 这一节**应当指得到的那几个地方**（绝对路径），由夹具自己说出来，不从正文里反解。
   *
   * 第 2 轮审查复现的就是「反解」那条路的死法：上一版用 `\S+` 从自然语言里抠地址，
   * 舞台根一旦含空格（含空格的 `TMPDIR` 是合法的），完整可读的地址被当成「没有入口」，
   * 而 `test:prompt-budget` 挂在验收前置 —— 于是验收被一条假红挡住。
   * 「整个地址都是非空白字符」根本不是存在性判据，所以这里改成**夹具给出预期**、闸只做
   * 「原文里有没有这个完整地址」和「这个地址读不读得到」两件事，与空白字符无关。
   */
  entries?: ReadonlyArray<{ text: string; onDisk: boolean }>;
  /**
   * 这份样本**必须原样含有**的那几段动态内容（路径由夹具构造，闸不反解）。
   *
   * 为什么要有这一栏：`REQUIRED` 那张表只能写死字面量，而「本轮清单的**完整**地址有没有
   * 活着出现在投递消息里」是一条随夹具变的事实 —— 第 1 轮审查复现的正是它被去重误删。
   */
  requires?: readonly string[];
}

export const ROOT_TOKEN = "<ROOT>";

/** 量的是 UTF-8 字节：中文一个字三字节，按 `length` 量会把中英混排的预算算错一倍。 */
export function sizeOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * MCP 工具的 description 与**全部**字段说明——两者都随工具一起进每个回合的上下文。
 *
 * 字段说明必须从 **SDK 真正发给客户端的那份 JSON Schema** 上摘，不能自己遍历 zod 的
 * `_def`：手写遍历会把包装类型（`.optional()` / `.default()`）继承到的说明和内层原类型的
 * 说明各算一遍，而 SDK 序列化后只出现一次；同一个 schema 对象被两处引用时（`WORKFLOW_MODE`
 * 同时挂在 `taskShape` 和顶层）序列化器会折成 `$ref`，手写遍历又算了两份。第 1 轮审查用
 * 真实 `tools/list` 比对，`batch_create_tasks` / `create_task_chain` 各多算 798B。
 *
 * 这里调的 `toJsonSchemaCompat` 就是 `server/mcp.js` 列工具时调的那一个（同参数），所以
 * 量到的是真实注入量，不是一份近似。
 */
function toolTexts(config: {
  description?: string;
  inputSchema?: Record<string, never>;
}): { description: string; fields: string } {
  const json = toJsonSchemaCompat(z.object(config.inputSchema ?? {}), {
    strictUnions: true, pipeStrategy: "input",
  });
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const record = node as Record<string, unknown>;
    if (typeof record.description === "string") found.push(record.description);
    for (const [key, value] of Object.entries(record)) if (key !== "description") walk(value);
  };
  walk(json);
  return { description: config.description ?? "", fields: found.join("") };
}

export async function renderPromptSamples(root: string): Promise<PromptSample[]> {
  const { ensureSchema, db } = await import("../src/db/index.js");
  await ensureSchema();
  const { tasks, projects, freeReviewRuns, freeReviewRounds } = await import("../src/db/schema.js");
  const { freeReviewReportPath } = await import("../src/free-review-files.js");
  const at = "2026-10-27T00:00:00.000Z";
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });

  await db.insert(projects).values({ id: "pb-p", name: "budget", repoPath: repo, createdAt: at } as never);
  // `pb-dot。task` 的 id 会原样成为 runs 下的目录名 —— 目录名里带一个「。」是合法的，
  // 而它正是第 1 轮审查复现入口误删用的那个形状（见下面 delivered/review-resume-dotdir）。
  for (const id of ["pb-task", "pb-bare", "pb-stress", "pb-heavy", "pb-nomanifest", "pb-dot。task"]) {
    await db.insert(tasks).values({
      id, projectId: "pb-p", title: "示例任务", body: "把某个功能做出来，要点若干。",
      status: "running", mode: "single", workflowMode: "free", createdAt: at, updatedAt: at,
    } as never);
  }
  // 已被用户裁定过的两轮：重播那一节的体积由它们决定。
  for (const [index, resolution] of [["1", "deferred"], ["2", "withdrawn"]] as const) {
    await db.insert(freeReviewRuns).values({
      id: `pb-old-${index}`, taskId: "pb-task", reviewerId: null, reviewerName: "逻辑审查者",
      agentType: "codex", executorId: null, checkMode: "logic", retryLimit: 1, currentRound: 1,
      status: "stopped", createdAt: at, updatedAt: at, finishedAt: at,
    } as never);
    await db.insert(freeReviewRounds).values({
      id: `pb-old-${index}-round`, runId: `pb-old-${index}`, round: 1, status: "failed",
      conclusion: "verify_failed", reviewedCommit: "0".repeat(40),
      disputeSummary: "这几条我认，但不该在这个任务里改。",
      disputeReason: "第 1 条读错了行号：那段代码只在单线程里跑。".repeat(8),
      disputeDeferReason: "第 2、3 条落在与本任务无关的脚本里，基线上就有。".repeat(8),
      disputeResolutionNote: "这几条连同上一轮那个 helper 一起重写。".repeat(4),
      disputeResolution: resolution,
      disputeResolvedAt: `2026-10-2${index}T00:00:00.000Z`,
      disputeDeferredTaskId: resolution === "deferred" ? "pb-derived" : null,
      startedAt: at, endedAt: at,
    } as never);
  }

  // ── 压力形状：**合法输入下这几节最大能长到多少** ──────────────────────────────
  //
  // 固定夹具只能证明「这个夹具不超」，证明不了「生产渲染受预算约束」—— 第 2 轮审查把
  // 条数撑到 40/60/100 后复现：20 条通过的那一版，40 条起执行者那一侧就破顶，100 条时
  // 两侧都到 6KB 以上。所以这里种两份：20 条（典型上限）和 100 条（条数压力），后者还
  // 另有一份**落盘失败**（证据目录被普通文件占住，`full=null`）的变体。
  const filler = (word: string) => word.repeat(400);
  /** 返回这一批真写到盘上的报告路径：样本拿它声明「这一节应当指得到哪几个地方」。 */
  const seedRulings = async (taskId: string, count: number, rounds: number): Promise<string[]> => {
    const reports: string[] = [];
    for (let index = 1; index <= rounds; index += 1) {
      const stamp = new Date(Date.UTC(2026, 8, 1) + index * 86_400_000).toISOString();
      await db.insert(freeReviewRuns).values({
        id: `${taskId}-${index}`, taskId, reviewerId: null, reviewerName: "逻辑审查者",
        agentType: "codex", executorId: null, checkMode: "logic", retryLimit: 1, currentRound: 1,
        status: "stopped", createdAt: stamp, updatedAt: stamp, finishedAt: stamp,
      } as never);
      const settled = index <= count;
      await db.insert(freeReviewRounds).values({
        id: `${taskId}-${index}-round`, runId: `${taskId}-${index}`, round: index, status: "failed",
        conclusion: "verify_failed", reviewedCommit: "0".repeat(40), startedAt: stamp, endedAt: stamp,
        ...(settled
          ? {
            disputeSummary: "这几条不该在这个任务里改。",
            disputeReason: filler("不成立的依据"),
            disputeDeferReason: filler("越界的依据"),
            disputeResolutionNote: filler("裁定要点"),
            disputeResolution: index % 2 ? "deferred" : "withdrawn",
            disputeResolvedAt: stamp,
            disputeDeferredTaskId: index % 2 ? `${taskId}-derived-${index}` : null,
          }
          : {}),
      } as never);
      // 历史发现读的是**盘上的 report.md**，所以得真写出来。
      const report = freeReviewReportPath(taskId, `${taskId}-${index}`, index);
      mkdirSync(dirname(report), { recursive: true });
      writeFileSync(report, `## 结论\n\n### 发现 ${index}：${"这一轮复现到的现象行".repeat(12)}\n\n正文。\n`);
      reports.push(report);
    }
    return reports;
  };
  // 20 条裁定 + 26 轮（轮数撑过 `MAX_ITEMS` 的取样分支），以及 100 条裁定 + 100 轮。
  await seedRulings("pb-stress", 20, 26);
  const heavyReports = await seedRulings("pb-heavy", 100, 100);

  const run = {
    id: "pb-run", taskId: "pb-task", reviewerId: null, reviewerName: "逻辑审查者",
    agentType: "codex", executorId: null, model: null, reasoningEffort: null,
    checkMode: "logic", note: null, retryLimit: 3, currentRound: 2, status: "reviewing",
    targetKind: "workspace", targetBranch: null, targetBaseCommit: null, targetCommit: null,
    repairTaskId: null, createdAt: at, updatedAt: at, finishedAt: null,
  } as never;
  // 投递态样本里的每回合提醒由 `freeReviewReminder` 现查「这个任务正在审哪一轮」，所以
  // 这一条 run 必须真的落库（上面那个字面量只够给渲染函数当参数）。
  await db.insert(freeReviewRuns).values({ ...(run as object), createdAt: "2026-10-27T01:00:00.000Z" } as never);
  // 「这一轮的证据清单读不出来」那一路：目录被一个普通文件占住，`safeRunDirectory` 判否，
  // 于是每回合提醒改说「清单不可用，把回归面写成留白」。第 2 轮审查 F2 实测这条**本轮才
  // 出现**的警告被整条去重吞掉了，所以它必须进样本。
  const noManifestRun = { ...(run as object), id: "pb-run-nomanifest", taskId: "pb-nomanifest" } as never;
  await db.insert(freeReviewRuns).values({ ...(noManifestRun as object), createdAt: "2026-10-27T01:00:00.000Z" } as never);
  // 目录名含「。」那一路：清单入口照常产生，但用户消息里引着**上一轮**的地址，两条路径
  // 共享「第一个句号之前」的那一段。上一版按句号切地址，于是本轮地址被当成重复删掉。
  const dotRun = { ...(run as object), id: "pb-run-dot", taskId: "pb-dot。task" } as never;
  await db.insert(freeReviewRuns).values({ ...(dotRun as object), createdAt: "2026-10-27T01:00:00.000Z" } as never);

  const {
    debatePrompt, freeManualRepairPrompt, freeRepairPrompt, freeReviewPrompt, freeReviewResumeMessage,
  } = await import("../src/free-review-prompts.js");
  const { freeReviewReminder } = await import("../src/free-workflow.js");
  const { regressionManifestEntry } = await import("@ash/shared/free-workflow");
  const { settledRulingsFor } = await import("../src/free-review-settled.js");
  const { commonDirectory, freeReviewHistorySection } = await import("../src/review-history.js");
  // 一节历史说明可能把地址列全，也可能折成一个公共目录 —— 两种形态都是合法入口，所以
  // 预期清单两样都给，闸只要求「至少有一个完整地出现在正文里，且凡是出现的都读得到」。
  const entryCandidates = (reports: string[]) =>
    [...reports, commonDirectory(reports)].map((text) => ({ text, onDisk: true }));
  const { freeReviewEvidenceDir } = await import("../src/free-review-files.js");
  const { assembleTurnPrompt } = await import("../src/turn-prompt.js");
  type TurnReminder = Parameters<typeof assembleTurnPrompt>[0]["reviewReminder"];
  const { invitedTaskBrief } = await import("../src/invited-task-brief.js");
  const { COLLAB_INVITE, COMPLETION_PROTOCOL, COMPLETION_REMINDER, DIRECTION_PROTOCOL, FOLLOW_UP_REMINDER } =
    await import("../src/run-prompts.js");
  const { withGlobalBrowserPolicy } = await import("../src/browser-verification-policy.js");
  const { gateFailurePrompt } = await import("../src/accept-gate-messages.js");
  const task = (await db.select().from(tasks)).find((row) => row.id === "pb-task")!;

  const debate = { id: "pb-debate", roundId: "pb-round", round: 2, exchanges: 1, status: "running",
    currentSide: "executor", verdict: null, startedAt: at, finishedAt: null } as never;
  const segment = (seq: number, side: "reviewer" | "executor") => ({
    id: `pb-turn-${seq}`, debateId: "pb-debate", seq, side, status: "speaking",
    statement: "", summary: null, startedAt: at, endedAt: null,
  }) as never;

  const samples: PromptSample[] = [];
  const add = (
    id: string,
    text: string,
    extra?: Pick<PromptSample, "entries" | "requires">,
  ) => samples.push({ id, text: text.split(root).join(ROOT_TOKEN), raw: text, ...extra });

  // 「不含动态段」的那一版：同一条消息，但任务身上没有裁定、也没有历史发现。预算表靠
  // 这一对把**正文**和**动态段**分开盯——正文是改措辞改出来的，动态段是攒轮次攒出来的。
  const bare = (await db.select().from(tasks)).find((row) => row.id === "pb-bare")!;
  const bareRun = { ...(run as object), id: "pb-run-bare", taskId: "pb-bare" } as never;
  add("review/dispatch-bare", await freeReviewPrompt(bare as never, bareRun, 1, repo));
  add("repair/auto-bare", await freeRepairPrompt("pb-bare", bareRun));
  add("review/dispatch-logic", await freeReviewPrompt(task as never, run, 2, repo));
  add("review/dispatch-syntax", await freeReviewPrompt(task as never, { ...(run as object), checkMode: "syntax" } as never, 2, repo));
  add("review/resume", freeReviewResumeMessage(task as never, run, 2));
  add("repair/auto", await freeRepairPrompt("pb-task", run));
  add("repair/manual", await freeManualRepairPrompt("pb-task", run));
  add("repair/manual-upheld", await freeManualRepairPrompt("pb-task", run, {
    disputeUpheld: true,
    resolutionNote: "第 2 条按摘要内部折叠做，别按报告里的降档方案。",
    debateClosing: { seq: 3, total: 3, verdictLabel: "部分成立", statement: "复现步骤我补在报告末尾了，但第 1 条我撤回。" },
  }));
  add("debate/segment", debatePrompt({
    task: task as never, run, debate, turn: segment(2, "executor"),
    disputeReason: "第 2 条读错了代码。", previous: [], repoPath: repo,
  }));
  add("debate/final", debatePrompt({
    task: task as never, run, debate, turn: segment(3, "reviewer"),
    disputeReason: "第 2 条读错了代码。", previous: [], repoPath: repo,
  }));
  add("turn/completion-protocol-free", COMPLETION_PROTOCOL("pb-task", false, false, true));
  add("turn/completion-protocol-normal", COMPLETION_PROTOCOL("pb-task", false, false, false));
  add("turn/completion-reminder-free", COMPLETION_REMINDER("pb-task", false, false, true));
  add("turn/follow-up-reminder-free", FOLLOW_UP_REMINDER("pb-task", "done", false, false, "", true));
  add("browser/full-ungranted", withGlobalBrowserPolicy("", "full", null));
  add("browser/full-granted", withGlobalBrowserPolicy("", "full",
    { domains: ["x.com", "weixin.com", "excalidraw.com"] }));
  add("browser/reminder-granted", withGlobalBrowserPolicy("", "reminder", { domains: ["x.com"] }));
  add("accept/gate-failure", gateFailurePrompt({
    command: "npm run test:accept", summary: "退出码 1", logPath: join(root, "gate.log"),
    tail: "1 failing", cwd: join(root, "snapshot"), sourceCwd: repo,
  }));

  // ── 压力样本：动态段的天花板。不计入 TOTAL（它不是「一条典型消息」，是上限证明）。
  const stress = (await db.select().from(tasks)).find((row) => row.id === "pb-stress")!;
  const stressRun = { ...(run as object), id: "pb-run-stress", taskId: "pb-stress" } as never;
  add("stress/review-dispatch", await freeReviewPrompt(stress as never, stressRun, 1, repo));
  add("stress/repair-auto", await freeRepairPrompt("pb-stress", stressRun));
  const heavy = (await db.select().from(tasks)).find((row) => row.id === "pb-heavy")!;
  const heavyRun = { ...(run as object), id: "pb-run-heavy", taskId: "pb-heavy" } as never;
  add("stress/review-dispatch-100", await freeReviewPrompt(heavy as never, heavyRun, 1, repo));
  add("stress/repair-auto-100", await freeRepairPrompt("pb-heavy", heavyRun));

  // ── 分节样本：**最终渲染层**那两节各自的字节，和整条消息分开量 ────────────────
  //
  // 为什么要单独量而不是只拿整条消息作差：整条消息里还有需求引用、证据清单状态这些会跟着
  // 夹具一起变的东西，作差量到的不只是这一节。闸要钉的是「这一节有上限」，那就直接量它。
  // 落盘失败那一路（证据目录被普通文件占住 → `full=null`）同样要有界：第 2 轮审查实测它
  // 会退回无界内联，100 条时 reviewer 6613B / executor 6686B。
  const sectionFor = async (taskId: string, audience: "reviewer" | "executor", dir: string) =>
    settledRulingsFor({ taskId, current: { runId: "pb-none", round: 1 }, audience, evidenceDir: dir });
  const heavyDir = freeReviewEvidenceDir("pb-heavy", "pb-run-heavy", 1);
  const brokenDir = join(root, "runs", "pb-heavy", "broken-evidence-dir");
  mkdirSync(dirname(brokenDir), { recursive: true });
  writeFileSync(brokenDir, "这不是目录：用来逼出落盘失败那一路。\n");
  add("section/settled-reviewer-20", await sectionFor("pb-stress", "reviewer",
    freeReviewEvidenceDir("pb-stress", "pb-run-stress", 1)));
  add("section/settled-executor-20", await sectionFor("pb-stress", "executor",
    freeReviewEvidenceDir("pb-stress", "pb-run-stress", 1)));
  add("section/settled-reviewer-100", await sectionFor("pb-heavy", "reviewer", heavyDir));
  add("section/settled-executor-100", await sectionFor("pb-heavy", "executor", heavyDir));
  add("section/settled-reviewer-100-nofile", await sectionFor("pb-heavy", "reviewer", brokenDir));
  add("section/settled-executor-100-nofile", await sectionFor("pb-heavy", "executor", brokenDir));
  add("section/history-100", await freeReviewHistorySection("pb-heavy", { runId: "pb-none", round: 1 }),
    { entries: entryCandidates(heavyReports) });

  // ── 长路径形状：**合法但很深**的报告地址，两个生产消费者各一份 ────────────────
  //
  // 第 1 轮审查复现到的那一类：任务目录 + run 目录 + 轮次目录拼出 300B 量级的单条地址，
  // 几十轮下来光地址清单就撑破整节 —— 旧版末级对拼完的整节做盲截，于是最后一句话停在
  // 「另有 32 份没有列出，在 …」处，指着一个不存在的目录，末尾那两句固定契约一起没了。
  // 两个消费者都要有样本：它们走同一个 `priorFindingsSection`，但地址形状不同（自由
  // 工作流多一层 run 目录，就地验证是平铺的 round-N）。
  //
  // 名字长度写死在这里，所以**单条地址的长度与机器无关**（`mkdtemp` 的根只是额外加长）；
  // 单段 240 字符仍在文件名 255 字节的限内，是真能在盘上建出来的形状。
  //
  // 这一族的**字节数**随舞台根长短逐机不同，进不了棘轮预算表（棘轮盯不住一个随机数），
  // 所以 `deep/` 这个前缀在闸里单列，由「契约完整 + 入口可读 + 不超生产上限」那张表盯。
  const deepName = (prefix: string) => prefix + "d".repeat(240 - prefix.length);
  const deepFree = deepName("pb-deep-free-");
  const deepFreeRun = `${deepFree}-run`;
  const deepFreeReports: string[] = [];
  for (let index = 1; index <= 40; index += 1) {
    const stamp = new Date(Date.UTC(2026, 9, 1) + index * 3_600_000).toISOString();
    if (index === 1) {
      await db.insert(freeReviewRuns).values({
        id: deepFreeRun, taskId: deepFree, reviewerId: null, reviewerName: "逻辑审查者",
        agentType: "codex", executorId: null, checkMode: "logic", retryLimit: 1, currentRound: index,
        status: "stopped", createdAt: stamp, updatedAt: stamp, finishedAt: stamp,
      } as never);
    }
    await db.insert(freeReviewRounds).values({
      id: `${deepFreeRun}-${index}`, runId: deepFreeRun, round: index, status: "failed",
      conclusion: "verify_failed", reviewedCommit: "0".repeat(40), startedAt: stamp, endedAt: stamp,
    } as never);
    const report = freeReviewReportPath(deepFree, deepFreeRun, index);
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, `## 结论\n\n### 发现 ${index}：${"这一轮复现到的现象行".repeat(12)}\n\n正文。\n`);
    deepFreeReports.push(report);
  }
  add("deep/history-free", await freeReviewHistorySection(deepFree, { runId: "pb-none", round: 1 }),
    { entries: entryCandidates(deepFreeReports) });

  const { reviewRoundDir } = await import("../src/review-evidence.js");
  const { verifyHistorySection } = await import("../src/review-history.js");
  const deepVerify = deepName("pb-deep-verify-");
  const deepVerifyReports: string[] = [];
  for (let index = 1; index <= 40; index += 1) {
    const dir = reviewRoundDir(deepVerify, index);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"),
      `## 结论\n\n### 发现 ${index}：${"这一轮复现到的现象行".repeat(12)}\n\n正文。\n`);
    writeFileSync(join(dir, "conclusion.json"), JSON.stringify({ conclusion: "verify_failed" }));
    deepVerifyReports.push(join(dir, "report.md"));
  }
  add("deep/history-verify", await verifyHistorySection(deepVerify, 41),
    { entries: entryCandidates(deepVerifyReports) });

  // ── 超长地址形状：**入口地址本身比整节上限还长** ──────────────────────────────
  //
  // 第 1 轮审查在 Linux 真目录上复现：18 段目录下全文路径 1886B，执行者侧裁定重播 2806B >
  // 声明的 2500B；34 段目录下历史说明 4078B > 声明的 4000B。两处的**末级摘要**当时都是直接
  // return，只有前几级候选在按字节核对 —— 于是「与条数无关」被当成了「必然放得下」，而入口
  // 是一条随环境变长的绝对路径。
  //
  // macOS 的 PATH_MAX 是 1024，这个长度在本机**建不出来**，所以这几份样本把路径直接喂给
  // 生产渲染函数、不落盘；长度取 Linux（PATH_MAX 4096）上可创建的量级，不是凭空放大的数字。
  // 到了这个长度，入口本来就已经降级成不含路径的表达，所以它们不做盘上存在性核对。
  const longPath = (size: number, leaf: string) => {
    const segment = "d".repeat(80);
    const count = Math.max(1, Math.ceil((size - leaf.length) / (segment.length + 1)));
    return `/${Array.from({ length: count }, () => segment).join("/")}/${leaf}`;
  };
  const { settledRulingsSection } = await import("../src/free-review-settled.js");
  const { priorFindingsSection } = await import("../src/review-history.js");
  const longRulings = Array.from({ length: 100 }, (_, index) => ({
    runId: `pb-long-${index + 1}`, round: index + 1, reviewerName: "逻辑审查者",
    resolution: index % 2 ? "deferred" : "withdrawn",
    reason: filler("不成立的依据"), deferReason: filler("越界的依据"), note: filler("裁定要点"),
    deferredTaskId: index % 2 ? `pb-long-derived-${index + 1}` : null,
    deferredTaskTitle: index % 2 ? "承接这几条的独立任务" : null,
    reportPath: longPath(1_200, "report.md"),
  })) as never;
  // 入口降级后那句话里的锚点：不含路径，长度恒定。
  const settledFallback = { text: "任务详情里那几轮的审查记录", onDisk: false };
  const historyFallback = { text: "报告全文在任务详情里那几轮的审查记录里", onDisk: false };
  // 审查者侧 cap 5000 > Linux PATH_MAX 4096 + 指引，所以合法路径下它**永远**折不到兜底
  // 入口；这一份量的正是「最长的合法路径」那个最坏情况。执行者侧 cap 2500 则会折。
  for (const [audience, size] of [["reviewer", 4_000], ["executor", 2_000]] as const) {
    const reference = longPath(size, "settled-rulings.md");
    add(`deep/settled-${audience}-longref`,
      settledRulingsSection(longRulings, audience, { reference, detailed: new Set() }, false),
      { entries: [{ text: reference, onDisk: false }, settledFallback] });
  }
  const longReports = Array.from({ length: 40 }, (_, index) =>
    longPath(3_700, `round-${index + 1}-report.md`));
  add("deep/history-longpath", priorFindingsSection(longReports.map((reportPath, index) => ({
    label: `第 ${index + 1} 轮`,
    conclusion: "verify_failed",
    reportPath,
    findings: [`${"这一轮复现到的现象行".repeat(4)}`],
  }))), { entries: [{ text: commonDirectory(longReports), onDisk: false }, historyFallback] });

  // ── 投递态：**真正发出去的那一条**。片段各自压着预算、拼起来翻倍，是这一摞里最贵的
  //    一种退步，而它只在这一层量得到（第 1 轮审查 F2）。走的是 orchestrator 用的同一个
  //    `assembleTurnPrompt`，不是它的拷贝 —— 拷贝迟早和真实投递路径分叉。
  const deliver = (userText: string, reviewReminder: TurnReminder, taskId = "pb-task") => withGlobalBrowserPolicy(
    assembleTurnPrompt({
      invite: COLLAB_INVITE,
      brief: invitedTaskBrief(task.body, true, true),
      handoffNotice: "",
      peerNotice: "",
      userText,
      workspaceReset: "",
      completion: COMPLETION_REMINDER(taskId, false, true, true),
      direction: DIRECTION_PROTOCOL("pb-token"),
      reviewReminder,
    }),
    "full",
    { domains: ["x.com", "weixin.com", "excalidraw.com"] },
  );
  const reviewReminder = await freeReviewReminder("pb-task");
  add("delivered/review-dispatch", deliver(await freeReviewPrompt(task as never, run, 2, repo), reviewReminder));
  add("delivered/review-resume", deliver(freeReviewResumeMessage(task as never, run, 2), reviewReminder));
  // 证据清单不可用那一轮的两条投递消息：**本轮状态**必须活着出现在最终消息里。
  const noManifestDir = freeReviewEvidenceDir("pb-nomanifest", "pb-run-nomanifest", 2);
  mkdirSync(dirname(noManifestDir), { recursive: true });
  writeFileSync(noManifestDir, "这不是目录：用来逼出「证据清单不可用」那一路。\n");
  const noManifest = (await db.select().from(tasks)).find((row) => row.id === "pb-nomanifest")!;
  const noManifestReminder = await freeReviewReminder("pb-nomanifest");
  // 只有**续跑**那一路量得到：首次派审走 `reviewRequestReference`，目录不安全时它直接抛，
  // 派审根本发不出去（这正确 —— 证据目录是审查的前提）。会带着坏目录继续跑的只有续跑和
  // 中途提问后的那几个回合，而它们恰恰只靠这条提醒。
  add("delivered/review-resume-nomanifest", deliver(
    freeReviewResumeMessage(noManifest as never, noManifestRun, 2), noManifestReminder, "pb-nomanifest"));
  // 目录名含「。」：本轮清单的**完整**入口必须活着出现在投递消息里，哪怕用户消息里引着
  // 一条只共享前缀的旧地址。`requires` 里放的就是本轮那一句完整入口。
  const dotTask = (await db.select().from(tasks)).find((row) => row.id === "pb-dot。task")!;
  const dotReminder = await freeReviewReminder("pb-dot。task");
  const olderManifest = regressionManifestEntry(
    join(freeReviewEvidenceDir("pb-dot。task", "pb-run-dot", 1), "regression-evidence.json"));
  add("delivered/review-resume-dotdir", deliver(
    `${freeReviewResumeMessage(dotTask as never, dotRun, 2)}\n上一轮的清单在 ${olderManifest}`,
    dotReminder, "pb-dot。task"), { requires: [dotReminder.manifestEntry!] });
  add("delivered/repair", withGlobalBrowserPolicy(
    assembleTurnPrompt({
      invite: "",
      brief: "",
      handoffNotice: "",
      peerNotice: "",
      userText: await freeRepairPrompt("pb-task", run),
      workspaceReset: "",
      completion: FOLLOW_UP_REMINDER("pb-task", "done", false, false, "", true),
      direction: DIRECTION_PROTOCOL("pb-token"),
      reviewReminder: "",
    }),
    "full",
    { domains: ["x.com", "weixin.com", "excalidraw.com"] },
  ));

  const registered = new Map<string, Parameters<typeof toolTexts>[0]>();
  const sink = { registerTool(name: string, config: never) { registered.set(name, config); } } as never;
  (await import("../../mcp/src/tools/task-turn.js")).registerTaskTurnTools(sink);
  (await import("../../mcp/src/tools/monitor.js")).registerMonitorTools(sink);
  (await import("../../mcp/src/tools/orchestrate.js")).registerOrchestrationTools(sink);
  (await import("../../mcp/src/tools/read-transcript.js")).registerReadTranscriptTools(sink);
  for (const [name, config] of [...registered].sort(([a], [b]) => a.localeCompare(b))) {
    const { description, fields } = toolTexts(config);
    add(`mcp/${name}`, description + fields);
  }
  return samples;
}

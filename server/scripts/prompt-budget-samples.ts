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
  for (const id of ["pb-task", "pb-bare", "pb-stress", "pb-heavy", "pb-nomanifest"]) {
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
  const seedRulings = async (taskId: string, count: number, rounds: number): Promise<void> => {
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
    }
  };
  // 20 条裁定 + 26 轮（轮数撑过 `MAX_ITEMS` 的取样分支），以及 100 条裁定 + 100 轮。
  await seedRulings("pb-stress", 20, 26);
  await seedRulings("pb-heavy", 100, 100);

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

  const {
    debatePrompt, freeManualRepairPrompt, freeRepairPrompt, freeReviewPrompt, freeReviewResumeMessage,
  } = await import("../src/free-review-prompts.js");
  const { freeReviewReminder } = await import("../src/free-workflow.js");
  const { settledRulingsFor } = await import("../src/free-review-settled.js");
  const { freeReviewHistorySection } = await import("../src/review-history.js");
  const { freeReviewEvidenceDir } = await import("../src/free-review-files.js");
  const { assembleTurnPrompt } = await import("../src/turn-prompt.js");
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
  const add = (id: string, text: string) =>
    samples.push({ id, text: text.split(root).join(ROOT_TOKEN), raw: text });

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
  add("section/history-100", await freeReviewHistorySection("pb-heavy", { runId: "pb-none", round: 1 }));

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
  }
  add("deep/history-free", await freeReviewHistorySection(deepFree, { runId: "pb-none", round: 1 }));

  const { reviewRoundDir } = await import("../src/review-evidence.js");
  const { verifyHistorySection } = await import("../src/review-history.js");
  const deepVerify = deepName("pb-deep-verify-");
  for (let index = 1; index <= 40; index += 1) {
    const dir = reviewRoundDir(deepVerify, index);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"),
      `## 结论\n\n### 发现 ${index}：${"这一轮复现到的现象行".repeat(12)}\n\n正文。\n`);
    writeFileSync(join(dir, "conclusion.json"), JSON.stringify({ conclusion: "verify_failed" }));
  }
  add("deep/history-verify", await verifyHistorySection(deepVerify, 41));

  // ── 投递态：**真正发出去的那一条**。片段各自压着预算、拼起来翻倍，是这一摞里最贵的
  //    一种退步，而它只在这一层量得到（第 1 轮审查 F2）。走的是 orchestrator 用的同一个
  //    `assembleTurnPrompt`，不是它的拷贝 —— 拷贝迟早和真实投递路径分叉。
  const deliver = (userText: string, reviewReminder: string, taskId = "pb-task") => withGlobalBrowserPolicy(
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

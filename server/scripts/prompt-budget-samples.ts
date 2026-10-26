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
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface PromptSample {
  /** 预算表里的键，也是金样文件名。 */
  id: string;
  /** 已经把舞台路径归一成 `<ROOT>` 的正文。 */
  text: string;
}

export const ROOT_TOKEN = "<ROOT>";

/** 量的是 UTF-8 字节：中文一个字三字节，按 `length` 量会把中英混排的预算算错一倍。 */
export function sizeOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** MCP 工具的 description 与**全部**字段说明——两者都随工具一起进每个回合的上下文。 */
function toolTexts(config: {
  description?: string;
  inputSchema?: Record<string, unknown>;
}): { description: string; fields: string } {
  const walk = (node: unknown): string => {
    const def = (node as { _def?: Record<string, unknown> } | undefined)?._def;
    if (!def) return "";
    const own = typeof def.description === "string" ? def.description : "";
    // 嵌套的 object / array 里还挂着字段说明（questionItems、tasks…），它们一样会被渲染
    // 进工具清单。只摘说明文本，不碰校验逻辑。
    const inner = def.innerType ?? def.type ?? def.schema ?? null;
    const shape = typeof def.shape === "function" ? def.shape() : null;
    return own
      + (inner ? walk(inner) : "")
      + (shape ? Object.values(shape).map(walk).join("") : "");
  };
  return {
    description: config.description ?? "",
    fields: Object.values(config.inputSchema ?? {}).map(walk).join(""),
  };
}

export async function renderPromptSamples(root: string): Promise<PromptSample[]> {
  const { ensureSchema, db } = await import("../src/db/index.js");
  await ensureSchema();
  const { tasks, projects, freeReviewRuns, freeReviewRounds } = await import("../src/db/schema.js");
  const at = "2026-10-27T00:00:00.000Z";
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });

  await db.insert(projects).values({ id: "pb-p", name: "budget", repoPath: repo, createdAt: at } as never);
  for (const id of ["pb-task", "pb-bare"]) {
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

  const run = {
    id: "pb-run", taskId: "pb-task", reviewerId: null, reviewerName: "逻辑审查者",
    agentType: "codex", executorId: null, model: null, reasoningEffort: null,
    checkMode: "logic", note: null, retryLimit: 3, currentRound: 2, status: "reviewing",
    targetKind: "workspace", targetBranch: null, targetBaseCommit: null, targetCommit: null,
    repairTaskId: null, createdAt: at, updatedAt: at, finishedAt: null,
  } as never;

  const {
    debatePrompt, freeManualRepairPrompt, freeRepairPrompt, freeReviewPrompt, freeReviewResumeMessage,
  } = await import("../src/free-review-prompts.js");
  const { COMPLETION_PROTOCOL, COMPLETION_REMINDER, FOLLOW_UP_REMINDER } = await import("../src/run-prompts.js");
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
  const add = (id: string, text: string) => samples.push({ id, text: text.split(root).join(ROOT_TOKEN) });

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

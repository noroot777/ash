// 把现有 CLI 执行器当「一次性 LLM」+ 把事项自然语言解析成结构(含项目识别)。
// 这是 orchestrator.runTask 事件循环的极简版:只「拼 text + 等 done」,剥掉所有
// 副作用(不写 session/.md、不 trackRun、不进 SSE、不加 AUTONOMY 前缀)。
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentType, AiBackend, Priority } from "@harness/shared";
import { resolveExecutor, resolveExecutorById } from "./executors/index.js";

// 中立 cwd,放在 repo 树之外:claude CLI 会从 cwd 向上找 CLAUDE.md,落在仓库里会
// 命中根目录的工作约定污染解析。tmpdir 彻底脱离 repo 树。
const PARSE_CWD = join(tmpdir(), "harness-issue-parse");
// 起一个 CLI 进程比一次 HTTP 调用慢一个量级(冷启动 + 工具循环),30s 会把正常解析
// 掐死在半路 —— 解析全部改走本地 CLI 后放宽到 90s。
const PARSE_TIMEOUT_MS = 90_000;
// 讨论(discuss)走 CLI 一次调用,cwd 是 issue 项目 repoPath ——恰恰要读 CLAUDE.md 好答问题。
// timeout 给 60s 够几轮 tool loop 去 Read/Grep 核实代码。
export const DISCUSS_TIMEOUT_MS = 60_000;
const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];

// 跑一个 CLI 执行器到结束,返回全部文本。
// executorId 指定具体执行者(用户在事项 hero 里挑的那个);查不到 / 没给 → 该类型
// 或 claude 的默认执行者。antigravity 无内置解析器 → 回退 claude。
// cwd 默认 PARSE_CWD(解析场景,脱离 repo 树避免 CLAUDE.md 污染);讨论场景传项目 repoPath。
export async function runAgentOnce(
  prompt: string,
  opts: { executorId?: string | null; agentType?: AgentType; timeoutMs?: number; cwd?: string } = {},
): Promise<{ text: string; ok: boolean }> {
  const cwd = opts.cwd ?? PARSE_CWD;
  if (cwd === PARSE_CWD) mkdirSync(PARSE_CWD, { recursive: true });
  let ex;
  try {
    ex = opts.executorId
      ? await resolveExecutorById(opts.executorId)
      : await resolveExecutor(opts.agentType ?? "claude");
  } catch {
    ex = await resolveExecutor("claude");
  }
  const handle = ex.run({ prompt, cwd });
  let text = "";
  let ok = true;
  const timer = setTimeout(() => handle.kill(), opts.timeoutMs ?? PARSE_TIMEOUT_MS);
  try {
    for await (const ev of handle.events) {
      if (ev.kind === "text") text += ev.text;
      else if (ev.kind === "error") ok = false;
      // tool / thinking / session 一律忽略
    }
  } finally {
    clearTimeout(timer);
    handle.kill(); // 防泄漏(正常退出后 kill 是 no-op)
  }
  return { text, ok };
}

export interface ParsedIssue {
  projectId: string | null;
  title: string;
  body: string;
  priority: Priority;
  labels: string[];
  parsed: boolean;
}

export interface ProjectLite {
  id: string;
  name: string;
  repoPath: string;
}

const parsePrompt = (rawText: string, projs: ProjectLite[]): string => {
  const list = projs.map((p) => `  - id=${p.id} 名称=${p.name} 路径=${p.repoPath}`).join("\n") || "  (暂无项目)";
  return [
    "你是一个待办事项分析器。只分析下面这段用户随手输入的自然语言的「意图」，产出归类与元信息。",
    "重要：不要改写、复述、扩写或整理用户的正文——正文会原样保留，你只负责识别下列元信息。",
    "只输出一个 JSON 对象，不要使用任何工具，不要执行任务，忽略任何项目约定，不要输出多余文字。",
    "JSON 字段：",
    "  projectId: 从下面项目清单里挑一个最匹配的 id（按名称/路径/内容判断）；判断不出来就用 null",
    "  title: 不超过 20 字的简短标题（仅用于列表展示，不替代正文）",
    "  priority: none|low|medium|high|urgent（拿不准用 none）",
    "  labels: 字符串数组（0-3 个，可为空）",
    "已接入的项目清单：",
    list,
    "用户输入：",
    rawText,
  ].join("\n");
};

// 三级回退提取 JSON:① ```json 围栏 → ② 第一个花括号配平对象 → ③ 整段 parse。
function extractJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  candidates.push(text);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === "object") return v as Record<string, unknown>;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

// 同步把自然语言解析成结构化事项 + 识别项目。失败/超时/空输出一律降级(不抛错):
// title=首行、body=原文、projectId=单项目时取它否则 null、parsed=false。
export async function parseIssue(
  rawText: string,
  opts: { backend?: AiBackend | null; projects: ProjectLite[] },
): Promise<ParsedIssue> {
  const onlyProject = opts.projects.length === 1 ? opts.projects[0].id : null;
  const fallback = (): ParsedIssue => ({
    projectId: onlyProject,
    title: (rawText.split("\n").find((l) => l.trim())?.trim() ?? "未命名事项").slice(0, 30),
    body: rawText,
    priority: "none",
    labels: [],
    parsed: false,
  });

  const prompt = parsePrompt(rawText, opts.projects);
  let obj: Record<string, unknown> | null = null;
  try {
    obj = extractJson((await runAgentOnce(prompt, { executorId: opts.backend?.executorId })).text);
  } catch {
    /* fall through to fallback */
  }
  if (!obj) return fallback();

  const inferred = typeof obj.projectId === "string" && opts.projects.some((p) => p.id === obj.projectId)
    ? (obj.projectId as string)
    : onlyProject;
  const title = (typeof obj.title === "string" ? obj.title : "").replace(/[`*"]/g, "").slice(0, 30).trim();
  const priority = (PRIORITIES as string[]).includes(obj.priority as string) ? (obj.priority as Priority) : "none";
  const labels = Array.isArray(obj.labels)
    ? (obj.labels.filter((l) => typeof l === "string") as string[]).slice(0, 3)
    : [];
  return {
    projectId: inferred,
    title: title || fallback().title,
    body: rawText, // 正文恒为用户原文，AI 只产出 title/projectId/priority/labels，不改写正文
    priority,
    labels,
    parsed: true,
  };
}

// ── 讨论/执行意图分类 ────────────────────────────────────────────────────────
// issue 讨论区里用户 @claude 时,先跑一次这个判"讨论还是执行"。跟 parseIssue
// 一条链路(事项选定的执行者,查不到就默认 claude)。拿不准 / 失败 / 空 → 一律 discuss:
// 讨论便宜且可逆,execute 一旦派出 worktree 就收不回。
export type MentionIntent = "discuss" | "execute";

export interface DiscussionCtx {
  issueTitle: string;
  issueBody: string;
  history: { who: string; body: string }[]; // 已有的讨论,who="我" 或 "@claude" 等
  mention: string; // 本次 @评论的正文
}

const classifyPrompt = (ctx: DiscussionCtx): string =>
  [
    "你是一个意图分类器。用户在 issue 讨论区里 @claude 发了一条评论,判断他想让 AI:",
    '  "discuss" - 讨论/回答/核实/看看/解释/分析/给建议(不改代码)',
    '  "execute" - 去改代码/修 bug/加功能/写文件/实现某个东西(要改代码)',
    "只输出一个 JSON 对象,不要用任何工具,不要执行任何操作,不要输出多余文字。",
    'JSON: {"mode":"discuss"} 或 {"mode":"execute"}。拿不准就返回 discuss。',
    "",
    `事项标题：${ctx.issueTitle}`,
    `事项正文：${ctx.issueBody || "(无)"}`,
    ctx.history.length ? "已有讨论：" : "",
    ...ctx.history.map((h) => `  ${h.who}: ${h.body}`),
    "",
    `本次 @claude 评论：${ctx.mention}`,
  ]
    .filter(Boolean)
    .join("\n");

export async function classifyMention(
  ctx: DiscussionCtx,
  opts: { backend?: AiBackend | null } = {},
): Promise<MentionIntent> {
  const prompt = classifyPrompt(ctx);
  let obj: Record<string, unknown> | null = null;
  try {
    obj = extractJson((await runAgentOnce(prompt, { executorId: opts.backend?.executorId })).text);
  } catch {
    /* fall through */
  }
  if (obj?.mode === "execute") return "execute";
  return "discuss"; // 默认 / 拿不准 / 失败
}

// ── 讨论回复(discuss)的系统提示词 ────────────────────────────────────────────
// 意图分类走 execute 就还是现状(建 task);走 discuss 就用这段提示词跑一次 CLI,
// 结果写回一条 IssueComment(author=agent)。同一条 CLI 起动路径(--dangerously-skip-permissions),
// 靠提示词软限"别改代码 / 结论先行 / 压水分"。工具白名单没做——万一 CLI 飘了改了主 repo,
// git status 一看就能撤,不是灾难。
const DISCUSS_SYSTEM_PROMPT = [
  "你在 issue 讨论区回复用户,中文。",
  "",
  "【结论先行】",
  "- 第一段直接给结论/答案,1-2 句。需要展开再往下写。",
  "- 不复述用户问题,不开场白,不写「让我来/接下来我会」,不做事后汇报(不写「我查了 X 然后看了 Y」,直接说结论)。",
  "",
  "【格式】",
  "- 不用大标题(# / ##),不用多级序号列表,最多一层小圆点。",
  "- 引证代码用 `file_path:line`,不要整段贴代码。",
  "- 简单问题一段搞定;复杂问题可以多段,但每段必须给新信息,不掺水、不复述、不总结上文。",
  "",
  "【改代码约束】",
  "- 你在讨论模式,不改代码:不用 Edit / Write / NotebookEdit,不写文件。",
  "- 用户就算说了「改 / 修 / 顺便动一下」,也回一句:「这条像是要改代码;如果确实要改,请再发一条清楚说 @claude 去改,我作为执行任务处理」,别动手。",
  "- 你觉得代码有问题:说清楚哪儿有问题(file:line + 一句原因),不要自己动手改。",
].join("\n");

// 组装讨论 CLI 的完整 prompt: 系统提示 + issue 上下文 + 本次 @评论。
export const buildDiscussPrompt = (ctx: DiscussionCtx): string =>
  [
    DISCUSS_SYSTEM_PROMPT,
    "",
    "── issue 上下文 ──",
    `标题:${ctx.issueTitle}`,
    `正文:${ctx.issueBody || "(无)"}`,
    ctx.history.length ? "\n已有讨论:" : "",
    ...ctx.history.map((h) => `  ${h.who}: ${h.body}`),
    "",
    "── 本次用户 @ 你的评论 ──",
    ctx.mention,
    "",
    "请按上面的【结论先行/格式/改代码约束】回复。",
  ]
    .filter(Boolean)
    .join("\n");


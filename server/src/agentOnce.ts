// 把现有 CLI 执行器当「一次性 LLM」+ 把事项自然语言解析成结构(含项目识别)。
// 这是 orchestrator.runTask 事件循环的极简版:只「拼 text + 等 done」,剥掉所有
// 副作用(不写 session/.md、不 trackRun、不进 SSE、不加 AUTONOMY 前缀)。
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentType, AiBackend, Priority } from "@harness/shared";
import { resolveExecutor } from "./executors/index.js";
import { callModel, type LlmCall } from "./llm.js";

// 中立 cwd,放在 repo 树之外:claude CLI 会从 cwd 向上找 CLAUDE.md,落在仓库里会
// 命中根目录的工作约定污染解析。tmpdir 彻底脱离 repo 树。
const PARSE_CWD = join(tmpdir(), "harness-issue-parse");
const PARSE_TIMEOUT_MS = 30_000;
const PRIORITIES: Priority[] = ["none", "low", "medium", "high", "urgent"];

// 跑一个 CLI 执行器到结束,返回全部文本。antigravity 无内置解析器 → 回退 claude。
export async function runAgentOnce(
  prompt: string,
  opts: { agentType?: AgentType; timeoutMs?: number } = {},
): Promise<{ text: string; ok: boolean }> {
  mkdirSync(PARSE_CWD, { recursive: true });
  let ex;
  try {
    ex = await resolveExecutor(opts.agentType ?? "claude");
  } catch {
    ex = await resolveExecutor("claude");
  }
  const handle = ex.run({ prompt, cwd: PARSE_CWD });
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
    "你是一个待办事项解析器。把下面这段用户随手输入的自然语言整理成一条简洁的待办 issue。",
    "只输出一个 JSON 对象，不要使用任何工具，不要执行任务，忽略任何项目约定，不要输出多余文字。",
    "JSON 字段：",
    "  projectId: 从下面项目清单里挑一个最匹配的 id（按名称/路径/内容判断）；判断不出来就用 null",
    "  title: 不超过 20 字的简短标题",
    "  body: 把诉求整理清楚的描述（Markdown，可为空）",
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
  opts: { backend?: AiBackend | null; projects: ProjectLite[]; apiProvider?: LlmCall },
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

  let out = "";
  try {
    if (opts.backend?.kind === "api" && opts.apiProvider) {
      out = await callModel(opts.apiProvider, parsePrompt(rawText, opts.projects));
    } else {
      const r = await runAgentOnce(parsePrompt(rawText, opts.projects), {
        agentType: opts.backend?.kind === "cli" ? opts.backend.agentType : "claude",
      });
      out = r.text;
    }
  } catch {
    return fallback();
  }

  const obj = extractJson(out);
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
    body: typeof obj.body === "string" ? obj.body : rawText,
    priority,
    labels,
    parsed: true,
  };
}

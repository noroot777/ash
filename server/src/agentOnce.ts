// 把现有 CLI 执行器当「一次性 LLM」，供轻量解析等场景复用。
// 这是 orchestrator.runTask 事件循环的极简版:只「拼 text + 等 done」,剥掉所有
// 副作用(不写 session/.md、不 trackRun、不进 SSE、不加 AUTONOMY 前缀)。
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentType } from "@harness/shared";
import { resolveExecutorFor } from "./executors/index.js";

// 中立 cwd,放在 repo 树之外:claude CLI 会从 cwd 向上找 CLAUDE.md,落在仓库里会
// 命中根目录的工作约定污染解析。tmpdir 彻底脱离 repo 树。
const PARSE_CWD = join(tmpdir(), "harness-agent-once");
// 起一个 CLI 进程比一次 HTTP 调用慢一个量级(冷启动 + 工具循环),30s 会把正常解析
// 掐死在半路 —— 解析全部改走本地 CLI 后放宽到 90s。
const PARSE_TIMEOUT_MS = 90_000;
// 跑一个 CLI 执行器到结束,返回全部文本。
// executorId 指定具体执行器;查不到 / 没给 → 该类型或 claude 的默认执行器。
// cwd 默认 PARSE_CWD(解析场景,脱离 repo 树避免 CLAUDE.md 污染)。
export async function runAgentOnce(
  prompt: string,
  opts: { executorId?: string | null; agentType?: AgentType; timeoutMs?: number; cwd?: string } = {},
): Promise<{ text: string; ok: boolean }> {
  const cwd = opts.cwd ?? PARSE_CWD;
  if (cwd === PARSE_CWD) mkdirSync(PARSE_CWD, { recursive: true });
  let ex;
  try {
    ex = await resolveExecutorFor({ executorId: opts.executorId, type: opts.agentType ?? "claude" });
  } catch {
    ex = await resolveExecutorFor({ type: "claude" });
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

export interface ProjectLite {
  id: string;
  name: string;
  repoPath: string;
}

export const parsePrompt = (rawText: string, projs: ProjectLite[]): string => {
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

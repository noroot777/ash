// 「执行过程」里每一行的行内摘要。
//
// 折叠块展开后要**直接看见执行了什么**(命令、读的文件、搜的词),而不是一排
// 「Bash」「Read」还得再点一次才知道。难点在于 detail 的形状随执行器而异:
//   claude/qwen/qoder → JSON.stringify(tool_use.input),超 1500 字会被截断成半截 JSON
//   codex             → 命令原文 / 文件路径(纯文本)
// 所以先按工具名挑字段,JSON 解析失败(截断)时退回正则取值,再退回首行文本。
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";

export type ExecutionEvent = {
  kind: "tool" | "thinking" | "error";
  label: string;
  detail?: string;
};

// 工具名(小写) → 优先展示的字段。缺省走 GENERIC_KEYS。
const KEYS_BY_TOOL: Record<string, string[]> = {
  bash: ["command"],
  shell: ["command"],
  exec: ["command"],
  bashoutput: ["bash_id", "shell_id"],
  killshell: ["shell_id"],
  read: ["file_path", "notebook_path", "path"],
  write: ["file_path", "path"],
  edit: ["file_path", "path"],
  multiedit: ["file_path", "path"],
  notebookedit: ["notebook_path", "file_path"],
  ls: ["path"],
  grep: ["pattern"],
  glob: ["pattern"],
  webfetch: ["url"],
  websearch: ["query"],
  task: ["description", "prompt"],
  agent: ["description", "prompt"],
  skill: ["skill", "command"],
  askquestion: ["question"],
  ask_question: ["question"],
};

const GENERIC_KEYS = [
  "command", "cmd", "pattern", "query", "url", "file_path", "filePath", "notebook_path",
  "path", "description", "question", "prompt", "text", "message", "content", "skill", "name",
];

const PATH_KEYS = new Set(["file_path", "filePath", "notebook_path", "path", "target_file"]);

const MAX = 220;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

/**
 * 长路径只留末两段:`/Users/…/server/src/db/index.ts` → `db/index.ts`。
 *
 * 两种分隔符都认:这里的值是 agent 报上来的**本机绝对路径**,server 跑在 Windows 上
 * 时就是 `C:\repo\server\src\db\index.ts` —— 只按 `/` 切的话既切不动、又因为
 * `includes("/")` 为假直接原样返回,一整条盘符路径糊在行内摘要里。
 */
export function shortenPath(value: string): string {
  const clean = value.trim();
  if (clean.length <= 44 || !/[\\/]/.test(clean)) return clean;
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return clean;
  // 末两段用原路径里那种分隔符拼回去,免得 Windows 路径显示成半 POSIX 的混血。
  const sep = clean.includes("\\") && !clean.includes("/") ? "\\" : "/";
  return `…${sep}${parts.slice(-2).join(sep)}`;
}

function stringify(value: unknown, key: string): string {
  if (typeof value === "string") return PATH_KEYS.has(key) ? shortenPath(value) : collapse(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return collapse(value.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" "));
  return "";
}

function pickFromObject(input: Record<string, unknown>, tool: string): string {
  // TodoWrite 之流:清单本身没有一句「在干什么」,取正在做的那条。
  const todos = input.todos;
  if (Array.isArray(todos) && todos.length) {
    const active = todos.find((todo: any) => todo?.status === "in_progress") ?? todos[0];
    const text = typeof active?.activeForm === "string" ? active.activeForm : typeof active?.content === "string" ? active.content : "";
    return clip(text ? `${collapse(text)}（共 ${todos.length} 项）` : `${todos.length} 项`);
  }
  for (const key of [...(KEYS_BY_TOOL[tool] ?? []), ...GENERIC_KEYS]) {
    if (!(key in input)) continue;
    const text = stringify(input[key], key);
    if (text) return clip(text);
  }
  for (const [key, value] of Object.entries(input)) {
    const text = stringify(value, key);
    if (text) return clip(text);
  }
  return "";
}

/** 半截 JSON(detail 被执行器截断过)也要能取到值:正则扫 "key": "value"。 */
function pickFromBrokenJson(raw: string, tool: string): string {
  for (const key of [...(KEYS_BY_TOOL[tool] ?? []), ...GENERIC_KEYS]) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (!match) continue;
    let value: string;
    try {
      value = JSON.parse(`"${match[1]}"`);
    } catch {
      value = match[1];
    }
    const text = stringify(value, key);
    if (text) return clip(text);
  }
  return "";
}

/** 一行执行事件的行内摘要;拿不出更好的就返回空串(此时只显示工具名)。 */
export function traceSummary(event: ExecutionEvent): string {
  const detail = event.detail?.trim();
  if (!detail) return "";
  if (event.kind !== "tool") return clip(collapse(detail));

  const tool = event.label.trim().toLowerCase();
  if (detail.startsWith("{")) {
    try {
      const parsed = JSON.parse(detail);
      // 挑不出人话就宁可留空(只显示工具名),别把一串 JSON 塞进行内 —— 想看的人点开就是。
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return pickFromObject(parsed as Record<string, unknown>, tool);
    } catch {
      const picked = pickFromBrokenJson(detail, tool);
      if (picked) return picked;
    }
  }
  // 纯文本 detail:codex 的 exec 给命令原文、edit 给文件路径,后者缩成末两段。
  // 「像不像路径」跟 shortenPath 用同一把尺子(两种分隔符都认)—— 只认 `/` 的话,
  // server 跑在 Windows 上时 codex 报的 `C:\repo\server\src\db\index.ts` 判不成路径,
  // 一整条盘符路径原样糊在行内摘要里;同一个路径包在 JSON 的 file_path 里却是缩过的,
  // 同一份 trace 两种长相。
  const single = collapse(detail);
  const looksLikePath = /[\\/]/.test(single) && !single.includes(" ");
  return clip(looksLikePath ? shortenPath(single) : single);
}

/** 行内摘要已经把 detail 说完时,不必再让它能展开(点开只是同一句话)。 */
export function hasMoreThanSummary(event: ExecutionEvent, summary: string): boolean {
  const detail = event.detail?.trim();
  if (!detail) return false;
  return collapse(detail) !== summary;
}

// ash 强加给 agent 的回合结算协议。它们跟任务内容无关 —— agent 是被系统要求调的,
// 不是为了把活干完才调的。
const TURN_PROTOCOL = new Set(["complete_task", "pause_task", "report_stage", "ask_question", "accept_task"]);

// 待办清单的记账。载荷长这样:{"taskId":"1","status":"completed"} —— 只是把某一条划掉,
// 现场什么都没发生。claude 的 TaskCreate/TaskUpdate/TaskList 与 codex 的 update_plan
// 是同一件事的不同叫法。
const PLAN_BOOKKEEPING = new Set(["taskcreate", "taskupdate", "tasklist", "todowrite", "update_plan"]);

/** `mcp__ash__complete_task`(claude)/ `ash/complete_task`(codex)→ `complete_task`。 */
function ashMcpTool(label: string): string | null {
  for (const server of [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME]) {
    if (label.startsWith(`mcp__${server}__`)) return label.slice(`mcp__${server}__`.length);
    if (label.startsWith(`${server}/`)) return label.slice(server.length + 1);
  }
  return null;
}

/**
 * 这一步是**记账**,不是干活。
 *
 * 用途是回合折叠的切点:切点要落在最后一次真正动手的地方,而记账调用几乎总在正文写完
 * 之后才发生(complete_task 尤其 —— 全库 22% 的回合切点是它)。拿它当切点会把整篇回答
 * 折进「过程」,外面只剩收尾那一句。
 *
 * 判据是「这一步有没有改变现场」而不是「它属不属于本项目的 MCP」:同一个 ash MCP 里的
 * dispatch / run_task / create_task_chain 是 agent 拿 ash 干活,照旧算数。
 */
export function isBookkeepingEvent(event: ExecutionEvent): boolean {
  if (event.kind !== "tool") return false;
  const ash = ashMcpTool(event.label);
  if (ash !== null) return TURN_PROTOCOL.has(ash);
  return PLAN_BOOKKEEPING.has(event.label.toLowerCase());
}

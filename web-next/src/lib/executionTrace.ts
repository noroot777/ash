// 「执行过程」里每一行的行内摘要。
//
// 折叠块展开后要**直接看见执行了什么**(命令、读的文件、搜的词),而不是一排
// 「Bash」「Read」还得再点一次才知道。难点在于 detail 的形状随执行器而异:
//   claude/qwen/qoder → JSON.stringify(tool_use.input),超 1500 字会被截断成半截 JSON
//   codex             → 命令原文 / 文件路径(纯文本)
// 所以先按工具名挑字段,JSON 解析失败(截断)时退回正则取值,再退回首行文本。
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

/** 长路径只留末两段:`/Users/…/server/src/db/index.ts` → `db/index.ts`。 */
export function shortenPath(value: string): string {
  const clean = value.trim();
  if (clean.length <= 44 || !clean.includes("/")) return clean;
  const parts = clean.split("/").filter(Boolean);
  return parts.length <= 2 ? clean : `…/${parts.slice(-2).join("/")}`;
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
  const single = collapse(detail);
  const looksLikePath = single.includes("/") && !single.includes(" ");
  return clip(looksLikePath ? shortenPath(single) : single);
}

/** 行内摘要已经把 detail 说完时,不必再让它能展开(点开只是同一句话)。 */
export function hasMoreThanSummary(event: ExecutionEvent, summary: string): boolean {
  const detail = event.detail?.trim();
  if (!detail) return false;
  return collapse(detail) !== summary;
}

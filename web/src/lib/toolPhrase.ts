// 一次工具调用 → 一句人话(动词 + 对象),外加点开以后的「字段 值」和原始参数。
//
// 执行过程里每一步原来写的是工具原名加一个字段(「Bash · npm test」),点开是一坨 JSON。
// 这里把它翻成「跑 npm test」「读 ReplyBox.tsx」「搜「slash-menu」于 web/src」,同一份翻译
// 也供折叠条用:在跑时说「正在读 ReplyBox.tsx」,做完说「读了 2 个文件」(executionWords.ts)。
//
// 输入的形状随执行器而异(见 server/src/executors):
//   claude / qwen / qoder / gemini / antigravity → detail 是 JSON.stringify(input),超 1500 字被截成半截
//   codex(exec / app-server)                   → exec 给命令原文;edit 给路径,或 changes 数组的 JSON
//   opencode / kilo / pi / cursor / kimi        → 多半是已经挑好的一个值(命令、路径、标题)
//   原生子智能体调用                             → nativeWork.input 里有结构化参数
//   catalog 那几家在工具报错时会再补一条同名事件,detail 以「失败：」开头
// 认不出的工具一律「调用 <工具名>」,后面跟上能挑出来的那个值 —— 宁可说得笨,不能把它弄丢。
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";
import { shortenPath, traceSummary, type ExecutionEvent } from "./executionTrace.ts";

/** 摘要里分得开的那几类;其余的(调用 MCP、记待办、看目录……)都算 other,摘要里并成「另有 N 步」。 */
export type StepKind = "read" | "search" | "edit" | "write" | "run" | "web" | "dispatch" | "wait" | "other";

export type StepPhrase = {
  kind: StepKind;
  /** 行首那个字:读 / 搜 / 改 / 跑 / 调用 …… */
  verb: string;
  /** 进行时、过去式(折叠条用):正在读 / 读了 */
  now: string;
  past: string;
  /** 行内的对象(路径已缩短);空串 = 只有动词 */
  object: string;
  /** 折叠条上用的短对象:路径只留文件名,命令只留第一行 */
  short: string;
  /** 对象是路径、命令、工具名这类「原样的东西」,用等宽排 */
  mono: boolean;
  /** 行尾那半句淡字:「第 22–96 行」「于 web/src」「等 3 个文件」 */
  tail?: string;
  /** read/edit/write 碰到的文件(原值,去重计数用) */
  files: string[];
  /** 点开以后的「字段 值」 */
  fields: [string, string][];
  /** 再折一层的原始参数;和 fields 说的是同一句话时为空 */
  raw?: string;
  /** 这一条是执行器补报的「上一步失败了」 */
  failed: boolean;
};

const FORMS: Record<Exclude<StepKind, "other">, [verb: string, now: string, past: string]> = {
  read: ["读", "正在读", "读了"],
  search: ["搜", "正在搜", "搜了"],
  edit: ["改", "正在改", "改了"],
  write: ["写", "正在写", "写了"],
  run: ["跑", "正在跑", "跑了"],
  web: ["看网页", "正在看", "看了"],
  dispatch: ["派", "正在派", "派了"],
  wait: ["等", "在等", "等了"],
};

// 工具名归一:小写、去掉 _ - 空格,`read_file` / `ReadFile` / `readFile` 落到同一个键上。
const KIND_BY_KEY: Record<string, StepKind> = {};
const put = (kind: StepKind, keys: string) => { for (const key of keys.split(" ")) KIND_BY_KEY[key] = kind; };
put("read", "read readfile readmanyfiles notebookread view viewimage cat readtextfile readmediafile");
put("search", "grep glob search searchfilecontent grepsearch codebasesearch semsearch filesearch find findfiles rg websearch googlewebsearch searchweb toolsearch");
put("edit", "edit multiedit notebookedit replace strreplacefile strreplace strreplacebasededittool editfile applypatch patch searchreplace editnotebook");
put("write", "write writefile create createfile writetofile");
put("run", "bash shell exec execcommand runshellcommand localshell command terminal runterminalcmd runcommand shellcommand powershell execute");
put("web", "webfetch fetch fetchurl urlfetch readurl");
put("dispatch", "task agent spawnagent");

// 不进摘要分类、但值得说成人话的那些:[动词, 进行时, 过去式, 取对象的字段]。
const OTHER: Record<string, [string, string, string, string[]]> = {};
const other = (keys: string, verb: string, now: string, past: string, pick: string[]) => {
  for (const key of keys.split(" ")) OTHER[key] = [verb, now, past, pick];
};
other("ls listdirectory list listdir listfiles", "看目录", "正在看目录", "看了目录", ["path", "dir_path", "directory", "target_directory"]);
other("todowrite updateplan taskcreate taskupdate tasklist taskget settodolist todoread", "记待办", "正在记待办", "记了待办", ["subject", "taskId", "explanation"]);
other("askuserquestion askquestion askfollowupquestion", "提问", "正在提问", "问了", ["question"]);
other("skill", "用技能", "正在用技能", "用了技能", ["skill", "command", "name"]);
other("imagegen generateimage", "生成图片", "正在生成图片", "生成了图片", ["prompt", "description"]);
other("writestdin", "往命令里输入", "正在往命令里输入", "往命令里输入了", ["chars", "input"]);
other("bashoutput taskoutput", "看后台输出", "正在看后台输出", "看了后台输出", ["bash_id", "shell_id", "task_id", "id"]);
other("killshell killbash taskstop", "停后台命令", "正在停后台命令", "停了后台命令", ["shell_id", "bash_id", "task_id", "id"]);
other("wait waitagent", "等子智能体", "正在等子智能体", "等了子智能体", ["id", "ids"]);
other("sendinput sendmessage followuptask", "给子智能体补话", "正在给子智能体补话", "给子智能体补了话", ["message", "prompt", "input"]);
other("closeagent interruptagent", "停子智能体", "正在停子智能体", "停了子智能体", ["id"]);
other("resumeagent", "唤回子智能体", "正在唤回子智能体", "唤回了子智能体", ["id"]);
other("listagents", "看子智能体", "正在看子智能体", "看了子智能体", []);
other("exitplanmode", "交出计划", "正在交出计划", "交出了计划", ["plan"]);

/** 哨兵叫醒那一步在执行过程里用的工具名(ash 服务名下),见 task-detail/monitorWakeTurns.ts。 */
export const MONITOR_WAKE_TOOL = "monitor_wake";

// ash 自己那套 MCP 工具:名字说的就是动作,翻一下就不必让人去认 `mcp__ash__start_monitor`。
const ASH_TOOLS: Record<string, [string, string, string, string[]]> = {
  start_monitor: ["挂哨兵", "正在挂哨兵", "挂了哨兵", ["description", "command"]],
  stop_monitor: ["停哨兵", "正在停哨兵", "停了哨兵", ["reason", "monitorId"]],
  complete_task: ["确认完成", "正在确认完成", "确认了完成", []],
  pause_task: ["暂停到检查点", "正在暂停", "暂停了", []],
  ask_question: ["提问", "正在提问", "问了", ["question"]],
  report_stage: ["上报阶段", "正在上报阶段", "上报了阶段", ["stage"]],
  dispatch: ["派活", "正在派活", "派了活", ["batchName"]],
};

const FIELD_LABEL: Record<string, string> = {
  file_path: "文件", filePath: "文件", notebook_path: "文件", absolute_path: "文件", target_file: "文件", file: "文件",
  paths: "文件", command: "命令", cmd: "命令", description: "说明", timeout: "时限", timeout_ms: "时限",
  pattern: "查找", query: "查找", regex: "查找", glob: "文件筛选", include: "文件筛选", type: "类型",
  url: "网址", offset: "起始行", limit: "行数", line_offset: "起始行", n_lines: "行数",
  old_string: "原文", new_string: "改成", replace_all: "全部替换", content: "内容", edits: "改动",
  cwd: "目录", workdir: "目录", dir_path: "目录", directory: "目录", output_mode: "输出",
  subagent_type: "类型", agent_type: "类型", run_in_background: "后台运行", todos: "待办",
  skill: "技能", question: "问题", options: "选项", subject: "事项", message: "内容", input: "输入",
  model: "模型", reasoning_effort: "智能水平", effort: "智能水平",
};

const MAX_OBJECT = 160;
const MAX_FIELD = 600;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(" ");
  return "";
}

function firstOf(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = asText(input[key]).trim();
    if (text) return text;
  }
  return "";
}

/** 工具名拆成服务 + 工具:`mcp__kb__kb_search`(claude)/ `kb/kb_search`(codex)。 */
export function splitToolName(label: string): { server?: string; tool: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(label);
  if (mcp) return { server: mcp[1], tool: mcp[2]! };
  const slash = /^([\w.-]+)\/([\w.-]+)$/.exec(label);
  if (slash) return { server: slash[1], tool: slash[2]! };
  return { tool: label };
}

/** 动词接对象:「读 a.ts」;引号打头的不空格 —— 「搜「slash-menu」」。 */
export const joinVerb = (verb: string, object: string) => (!object ? verb : object.startsWith("「") ? `${verb}${object}` : `${verb} ${object}`);

const toolKey = (tool: string) => tool.toLowerCase().replace(/[^a-z0-9]/g, "");

type Parsed = { input?: Record<string, unknown>; list?: unknown[]; text?: string; raw?: string };

/** detail 拆回结构:完整 JSON、被截断的半截 JSON(按 "key": 值 一对对捞)、或纯文本。 */
function parseDetail(event: ExecutionEvent): Parsed {
  const native = event.nativeWork?.type === "call" ? event.nativeWork.input : undefined;
  if (isRecord(native) && Object.keys(native).length) return { input: native, raw: JSON.stringify(native, null, 2) };
  const detail = event.detail?.trim();
  if (!detail) return {};
  if (detail.startsWith("{") || detail.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (isRecord(parsed)) return { input: parsed, raw: JSON.stringify(parsed, null, 2) };
      if (Array.isArray(parsed)) return { list: parsed, raw: JSON.stringify(parsed, null, 2) };
    } catch {
      if (detail.startsWith("{")) {
        const input: Record<string, unknown> = {};
        for (const match of detail.matchAll(/"([\w$.-]+)"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false)/g)) {
          try { input[match[1]!] ??= JSON.parse(match[2]!); } catch { input[match[1]!] ??= match[2]; }
        }
        // 截断的原文照原样给:pretty 一份半截 JSON 没有意义,也骗人。
        if (Object.keys(input).length) return { input, raw: detail };
      }
    }
  }
  return { text: detail, raw: detail };
}

/** `/bin/zsh -lc 'npm test'` → `npm test`;数组形式 `["bash","-lc","npm test"]` 同理。 */
export function unwrapShell(command: string | string[]): string {
  if (Array.isArray(command)) {
    const shell = command.findIndex((part) => /^-\w*c$/.test(part) || /^-command$/i.test(part));
    return (shell >= 0 && shell === command.length - 2 ? command.at(-1)! : command.join(" ")).trim();
  }
  const text = command.trim();
  const posix = /^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text);
  if (posix) return posix[1] === "'" ? posix[2]!.replace(/'\\''/g, "'") : posix[2]!.replace(/\\(["\\$`])/g, "$1");
  const pwsh = /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?(?:\s+-NoProfile)?\s+-Command\s+([\s\S]+)$/i.exec(text);
  if (pwsh) return pwsh[1]!.replace(/^(['"])([\s\S]*)\1$/, "$2");
  return text;
}

function formatValue(key: string, value: unknown, kind: StepKind): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  // claude 的 Bash timeout 是毫秒。
  if (typeof value === "number" && kind === "run" && /^timeout/.test(key)) {
    return value >= 60_000 && value % 60_000 === 0 ? `${value / 60_000} 分钟` : `${Math.round(value / 1000)} 秒`;
  }
  if (typeof value === "string") return clip(value, MAX_FIELD);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    // 命令的 argv 数组拼回一行;别的字符串列表(多个文件)一项一行。
    return clip(value.join(/^(command|cmd|argv)$/.test(key) ? " " : "\n"), MAX_FIELD);
  }
  try { return clip(JSON.stringify(value), MAX_FIELD); } catch { return ""; }
}

function fieldsOf(parsed: Parsed, kind: StepKind, textLabel: string): [string, string][] {
  if (parsed.input) {
    return Object.entries(parsed.input)
      .map(([key, value]): [string, string] => {
        const label = key === "path" ? (kind === "search" ? "范围" : kind === "run" ? "目录" : "文件")
          : key === "prompt" ? (kind === "dispatch" ? "任务" : "提示词")
          : FIELD_LABEL[key] ?? key;
        return [label, formatValue(key, value, kind)];
      })
      .filter(([, value]) => value !== "");
  }
  if (parsed.list) {
    const paths = parsed.list.map((item) => (isRecord(item) ? asText(item.path) : asText(item))).filter(Boolean);
    return paths.length ? [["文件", paths.join("\n")]] : [];
  }
  return parsed.text ? [[textLabel, clip(parsed.text, MAX_FIELD)]] : [];
}

/** 改文件那一类:路径可能在 file_path 里、在 codex 的 changes 数组里、在 apply_patch 的补丁正文里。 */
function editedFiles(parsed: Parsed): { files: string[]; adds: boolean } {
  const files: string[] = [];
  let adds = true;
  const fromPatch = (patch: string) => {
    for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
      files.push(match[2]!.trim());
      if (match[1] !== "Add") adds = false;
    }
  };
  if (parsed.input) {
    const one = firstOf(parsed.input, ["file_path", "filePath", "notebook_path", "target_file", "absolute_path", "path", "file"]);
    if (one) { files.push(one); adds = false; }
    for (const key of ["patch", "input", "content"]) {
      const value = parsed.input[key];
      if (!files.length && typeof value === "string" && value.includes("*** ")) fromPatch(value);
    }
  } else if (parsed.list) {
    for (const item of parsed.list) {
      if (!isRecord(item)) continue;
      const path = asText(item.path);
      if (path) files.push(path);
      const type = isRecord(item.kind) ? asText(item.kind.type) : asText(item.kind);
      if (type !== "add") adds = false;
    }
  } else if (parsed.text) {
    if (parsed.text.includes("*** ")) fromPatch(parsed.text);
    else { files.push(collapse(parsed.text)); adds = false; }
  }
  return { files: [...new Set(files)], adds: adds && files.length > 0 };
}

function lineRange(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const start = Number(input.offset ?? input.line_offset);
  const count = Number(input.limit ?? input.n_lines);
  const hasStart = Number.isFinite(start) && start > 0;
  const hasCount = Number.isFinite(count) && count > 0;
  if (hasStart && hasCount) return `第 ${start}–${start + count - 1} 行`;
  if (hasStart) return `从第 ${start} 行起`;
  return hasCount ? `前 ${count} 行` : "";
}

function phrase(
  kind: StepKind,
  forms: [string, string, string],
  parts: Partial<Pick<StepPhrase, "object" | "short" | "mono" | "tail" | "files" | "fields">>,
  parsed: Parsed,
  textLabel: string,
): StepPhrase {
  const fields = parts.fields ?? fieldsOf(parsed, kind, textLabel);
  const object = clip(parts.object ?? "", MAX_OBJECT);
  // 纯文本 detail 点开只是同一句话时不再给「原始参数」,也不再让它能点开(见 isFlatStep)。
  const sameAsField = !parsed.input && !parsed.list && fields.length === 1 && fields[0]![1] === parsed.raw;
  // 行内已经一字不差地说完了(codex 的 `ls -la`、opencode 挑好的那个标题),点开只会是同一句。
  const saidInline = sameAsField && collapse(fields[0]![1]) === object;
  return {
    kind,
    verb: forms[0],
    now: forms[1],
    past: forms[2],
    object,
    short: clip(parts.short ?? object, 48),
    mono: parts.mono ?? false,
    tail: parts.tail || undefined,
    files: parts.files ?? [],
    fields: saidInline ? [] : fields,
    raw: sameAsField ? undefined : parsed.raw,
    failed: false,
  };
}

/** 一条工具事件的人话。只认 kind:"tool";别的种类由 executionWords 处理。 */
export function describeTool(event: ExecutionEvent): StepPhrase {
  const label = event.label.trim() || "工具";
  const { server, tool } = splitToolName(label);
  const key = toolKey(tool);
  const detail = event.detail?.trim() ?? "";

  // catalog 那几家在工具报错时补的那一条:原参数早已报过,这里只剩原因。
  if (/^失败[：:]?/.test(detail) && !event.nativeWork) {
    const why = detail.replace(/^失败[：:]?\s*/, "");
    return {
      kind: "other", verb: "失败", now: "失败了", past: "失败了", object: tool, short: tool, mono: true,
      tail: why ? clip(collapse(why), MAX_OBJECT) : undefined, files: [],
      fields: why ? [["原因", clip(why, MAX_FIELD)]] : [], raw: undefined, failed: true,
    };
  }

  const parsed = parseDetail(event);
  const input = parsed.input;
  const isAsh = server === ASH_MCP_SERVER_NAME || server === LEGACY_ASH_MCP_SERVER_NAME;
  const kind: StepKind = isAsh ? "other" : KIND_BY_KEY[key] ?? "other";

  if (kind === "read") {
    const path = (input && (firstOf(input, ["file_path", "filePath", "notebook_path", "absolute_path", "path", "file", "target_file", "uri"])
      || asText(Array.isArray(input.paths) ? input.paths[0] : ""))) || collapse(parsed.text ?? "");
    const many = input && Array.isArray(input.paths) && input.paths.length > 1 ? `等 ${input.paths.length} 个文件` : "";
    return phrase(kind, FORMS.read, {
      object: shortenPath(path), short: baseName(path), mono: true,
      tail: many || lineRange(input), files: path ? [path] : [],
    }, parsed, "文件");
  }
  if (kind === "search") {
    const web = /web/.test(key);
    const pattern = (input && firstOf(input, ["pattern", "query", "regex", "search", "q", "glob_pattern", "search_term", "text"]))
      || collapse(parsed.text ?? "");
    const scope = input && !web ? firstOf(input, ["path", "dir_path", "directory", "target_directory", "include", "glob", "cwd"]) : "";
    const quoted = pattern ? `「${clip(collapse(pattern), 80)}」` : "";
    return phrase(kind, FORMS.search, {
      object: quoted, short: quoted,
      tail: web ? "网页" : scope && scope !== pattern ? `于 ${shortenPath(scope)}` : "",
    }, parsed, "查找");
  }
  if (kind === "edit" || kind === "write") {
    const { files, adds } = editedFiles(parsed);
    const real: StepKind = kind === "write" || adds ? "write" : "edit";
    const first = files[0] ?? "";
    // 补丁正文当字段看不出改了谁:字段只列文件,补丁本身留在原始参数里。
    const patchText = !parsed.input && !parsed.list && files.length && parsed.text !== files[0];
    return phrase(real, FORMS[real], {
      object: first ? shortenPath(first) : "", short: first ? baseName(first) : "", mono: true,
      tail: files.length > 1 ? `等 ${files.length} 个文件` : "", files,
      ...(patchText ? { fields: [["文件", files.join("\n")]] as [string, string][] } : {}),
    }, parsed, "文件");
  }
  if (kind === "run") {
    const argv = input && [input.command, input.cmd].find(Array.isArray);
    const raw = argv ? argv.map(String) : input ? firstOf(input, ["command", "cmd", "commandLine", "script"]) : parsed.text ?? "";
    const command = unwrapShell(raw);
    const lines = command.split("\n").map((line) => line.trim()).filter(Boolean);
    const firstLine = lines[0] ?? "";
    const description = input ? firstOf(input, ["description"]) : "";
    const object = firstLine ? `${firstLine}${lines.length > 1 ? " …" : ""}` : description;
    return phrase(kind, FORMS.run, { object, short: object, mono: !!firstLine }, parsed, "命令");
  }
  if (kind === "web") {
    const url = (input && firstOf(input, ["url", "uri", "href"])) || collapse(parsed.text ?? "");
    const bare = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return phrase(kind, FORMS.web, { object: bare, short: bare, mono: true }, parsed, "网址");
  }
  if (kind === "dispatch") {
    const what = (input && firstOf(input, ["description", "title", "task_name", "name", "message", "prompt"]))
      || collapse(parsed.text ?? "");
    const line = collapse(what.split("\n")[0] ?? "");
    // 折叠条上单说一句「派了 找工具渲染点」读不通,补上派的是什么。
    return phrase(kind, FORMS.dispatch, { object: line, short: line ? `子智能体「${clip(line, 40)}」` : "子智能体" }, parsed, "任务");
  }

  // 哨兵叫醒了它:不是它调的工具,是 ash 把等来的东西喂回这一回合(task-detail/monitorWakeTurns.ts
  // 造的那一步)。说成「等 哨兵「…」」,后面是等了多久、等到了什么;点开是送回来的那几行。
  if (isAsh && tool === MONITOR_WAKE_TOOL && input) {
    const name = asText(input.source) || "哨兵";
    const output = asText(input.output);
    return {
      kind: "wait", verb: FORMS.wait[0], now: FORMS.wait[1], past: FORMS.wait[2], object: `哨兵「${clip(collapse(name), 60)}」`, short: `哨兵「${clip(collapse(name), 24)}」`,
      mono: false, tail: [asText(input.waited), asText(input.got)].filter(Boolean).join(" · ") || undefined, files: [],
      fields: output ? [["送回", clip(output, MAX_FIELD)]] : [], raw: asText(input.raw) || undefined,
      failed: input.bad === true,
    };
  }

  // 其余:有专门说法的用专门说法,否则「调用 <工具名>」后面跟一个挑得出来的值。
  const known = isAsh ? ASH_TOOLS[tool] : OTHER[key];
  if (known) {
    const [verb, now, past, pick] = known;
    let object = input ? firstOf(input, pick) : collapse(parsed.text ?? "");
    const todos = input?.todos;
    if (!object && Array.isArray(todos) && todos.length) object = traceSummary({ ...event, kind: "tool", label: "todowrite" });
    object = collapse(object);
    const isPath = pick.some((name) => /path|directory/.test(name)) && !!object;
    return phrase("other", [verb, now, past], {
      object: isPath ? shortenPath(object) : object, short: isPath ? baseName(object) : object, mono: isPath,
    }, parsed, "内容");
  }
  const value = traceSummary({ ...event, label: tool });
  return phrase("other", ["调用", "正在调用", "调用了"], {
    object: tool, short: tool, mono: true,
    tail: [server && !isAsh ? server : "", value].filter(Boolean).join(" · "),
  }, parsed, "参数");
}

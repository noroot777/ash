// Claude Code 计划模式（`/plan`）回合的权限闸。
//
// headless 下进计划模式只有一条路（claude 2.1.283 实测，2026-11-20）：起跑时
// `--permission-mode plan` **加** `--permission-prompt-tool stdio`、输入走 stream-json。
//   · 只给 `--permission-mode plan`：init 的 tools 里没有 ExitPlanMode，计划文件（配置目录
//     下 `plans/<slug>.md`）被当敏感文件拒写——模型交不出计划，回合白跑。
//   · 跟 `--dangerously-skip-permissions` 同传：后者赢（init 报 bypassPermissions），等于没进计划模式。
//   · 加了 stdio：CLI 把每一次要权限的工具调用以 `control_request{subtype:"can_use_tool"}` 写到
//     stdout，等 stdin 回 `control_response`。ExitPlanMode 也走这条，`input` 是空对象——计划正文
//     不在调用里，在计划文件里。
//
// 一回合一进程：ExitPlanMode 到达时把计划正文推成 `{kind:"plan"}` 事件、**拒掉**这次调用，
// 模型据拒绝消息收尾，回合自然结束。不放行——放行等于让它当场退出计划模式接着动手，用户还没批准。
// 用户批准后由 `/plan implement` 以默认权限 `--resume` 同一会话开工（orchestrator.ts）。
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentEvent, QuestionItem } from "@navi/shared";
import { claudeConfigDirOf, claudePlansDirectory, userConfigDir } from "./claude-settings.js";

/** 计划回合追加的起跑参数（替换 `--dangerously-skip-permissions`）。 */
export const CLAUDE_PLAN_ARGS = ["--permission-mode", "plan", "--permission-prompt-tool", "stdio"] as const;

// 只读、不碰外部状态的工具：CLI 只在目标落在工作目录外时才来问（`decision_reason_type: workingDir`），放行。
// Bash 不在其列：CLI 认得出的只读命令根本不来问，来问的就是它判不了的那种，一律拒。
const READ_ONLY = new Set([
  "Read", "Glob", "Grep", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "Task", "Agent",
  "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "BashOutput", "TaskOutput",
]);
const PLAN_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
/** 由闸换成计划 / 澄清问题事件的两种工具：流里不再把它们画成一次工具调用。 */
export const PLAN_HANDOFF_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

const SUBMITTED = "计划已提交给用户审阅。不要再调用任何工具，用一两句话说明计划要点后结束本回合；用户确认后会让你开始实施。";
const ASKED = "问题已转交给用户。不要再调用任何工具，结束本回合等待答复。";
const NO_PLAN = "没有找到计划正文。先把完整计划写进计划文件，再调用 ExitPlanMode。";
const WRITE_FAILED = "最近一次写计划文件失败了，计划文件里不是你最新的计划。先把完整计划成功写进计划文件，再调用 ExitPlanMode。";
const WRITE_PENDING = "计划文件最近一次修改还没完成。等它完成后再调用 ExitPlanMode。";
const READ_ONLY_DENIAL = (tool: string) => `计划模式只读：本回合不能执行 ${tool}。需要的话把这一步写进计划，用户确认实施后再做。`;

// 额外参数里能把权限模式改掉的那几个：跟计划参数同传时 CLI 认后来的（实测 `--dangerously-skip-permissions`
// 在后 → init 报 bypassPermissions），计划回合装配时一律摘掉。带值的两个连值一起摘。
const PERMISSION_SWITCHES = new Set(["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"]);
const PERMISSION_OPTIONS = ["--permission-mode", "--permission-prompt-tool"];

/** 计划回合的额外参数：摘掉会改权限模式的那几个，其余原样。 */
export function planSafeExtraArgs(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (PERMISSION_SWITCHES.has(arg) || PERMISSION_OPTIONS.some((option) => arg.startsWith(`${option}=`))) continue;
    if (PERMISSION_OPTIONS.includes(arg)) { i++; continue; }
    kept.push(arg);
  }
  return kept;
}

// 计划文件目录随起跑命令落库：重启接管拿不到起跑时的环境和配置，只能从这里认回同一个目录。
const PLAN_FILES_TAG = "navi-plan-files";
const PLAN_FILES_RE = new RegExp(`<${PLAN_FILES_TAG}:("(?:[^"\\\\]|\\\\.)*")>`);

/** 追加在计划回合 commandLine 末尾的目录标记。 */
export const planFilesMarker = (plansDir: string) => ` <${PLAN_FILES_TAG}:${JSON.stringify(plansDir)}>`;

/** 接管时：这条命令是计划回合就给出它起跑时的计划文件目录，否则 undefined。 */
export function plansDirOfCommandLine(commandLine: string): string | undefined {
  if (!commandLine.includes(CLAUDE_PLAN_ARGS.join(" "))) return undefined;
  const raw = PLAN_FILES_RE.exec(commandLine)?.[1];
  if (raw) {
    try { return JSON.parse(raw) as string; } catch { /* 坏标记按没有处理 */ }
  }
  // 没有标记的计划回合（不该出现）：权限请求照样得有人回，目录按本机默认算。
  return join(userConfigDir(undefined), "plans");
}

/** 这次起跑子进程的计划文件目录：按它自己的配置目录、项目与额外参数解（claude-settings.ts）。 */
export function claudePlansDir(cwd: string | undefined, env: Readonly<Record<string, string | undefined>> | undefined, extraArgs: readonly string[]): string {
  return claudePlansDirectory(cwd, claudeConfigDirOf(env), extraArgs);
}

type ControlLine = (line: string) => void;

const response = (requestId: string, body: Record<string, unknown>) =>
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: body } }) + "\n";
const failure = (requestId: string, error: string) =>
  JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error } }) + "\n";

const within = (dir: string, path: string) => {
  const inside = relative(dir, path);
  return !!inside && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
};

/**
 * 解开软链接后的真实路径；路径本身还不存在时解它最近一级存在的祖先。某一级是悬空软链接或读不了
 * （权限）时证明不了真实落点，给 null —— 不能把它当成「还没建的新文件」放过去。
 */
function realPath(path: string): string | null {
  const rest: string[] = [];
  for (let dir = path; ;) {
    try {
      return join(realpathSync(dir), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try {
        lstatSync(dir);
        return null; // 自己在、指向的东西不在：悬空软链接
      } catch {
        // 这一级确实还不存在，往上找
      }
      const parent = dirname(dir);
      if (parent === dir) return path;
      rest.push(basename(dir));
      dir = parent;
    }
  }
}

function questionsOf(input: any): QuestionItem[] {
  return (Array.isArray(input?.questions) ? input.questions : []).flatMap((question: any) => {
    if (typeof question?.question !== "string" || !question.question.trim()) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((option: any) =>
      typeof option?.label === "string" ? [option.description ? `${option.label}：${option.description}` : option.label] : []);
    return [{ question: question.question, ...(options.length ? { options } : {}) }];
  });
}

/** 一次对文件的修改（Write / Edit / MultiEdit）。账按 tool_use 出现的先后记，状态只认工具回执。 */
interface Mutation { path: string; state: "pending" | "ok" | "failed" }

/**
 * 交给用户确认的计划只有一个来源判据：**计划文件最近一次修改成功之后的那一版**。正文从哪来
 * （CLI 在 ExitPlanMode 入参里带的 `plan`、计划文件本身、模型说过的话）都要先过这道：
 *   · 计划文件最后一次修改失败了或还没回执 → 不收，让模型改成了再交（CLI 会把盘上的旧正文
 *     自己补进 `input.plan`，2.1.283 实测，所以不能因为入参有正文就跳过）；
 *   · 先后以 tool_use 出现的顺序为准，回执晚到的旧修改成功不会冲掉新修改的失败；
 *   · 交完之后计划文件又改成了 → 按改后的正文重新交一次，卡上永远是会话里最新的那一版。
 * 哪个文件是计划文件以 CLI 自己在 ExitPlanMode 里报的 `planFilePath` 为准，没报（老版本）才用目录判。
 * 主智能体与子智能体的修改、直播与接管重放都记进同一本账。
 */
export class ClaudePlanGate {
  private readonly mutations = new Map<string, Mutation>();
  /** 已交出的计划对应的计划文件（null = 交的是模型说的话，没有文件）；还没交过 = undefined。 */
  private submitted: { path: string | null } | undefined;
  /** 交计划那次 ExitPlanMode 的 tool_use_id → 它报的计划文件：重放时靠回执认出「交过了」。 */
  private readonly exits = new Map<string, string | null>();
  /**
   * 没有计划文件时的兜底正文：最后一次工具调用之后模型说的话。工具调用前那几句是「我先看看 X」
   * 这类过程叙述，计划本身写在交计划之前那一段里。
   */
  private spoken = "";
  private readonly realPlansDir: string | null;
  /** init 报的权限模式不对：进程正在被停掉，这期间到达的请求一律拒。 */
  private halted = false;

  constructor(private readonly plansDir: string, private readonly write: ControlLine) {
    this.realPlansDir = realPath(resolve(plansDir));
  }

  /** init 报告的权限模式不是 plan（被别的配置顶掉了）时给出停下本回合的原因。 */
  initProblem(permissionMode: unknown): string | null {
    if (permissionMode === "plan") return null;
    this.halted = true;
    return `计划模式没有生效：claude 起跑后报告的权限模式是 ${String(permissionMode ?? "未知")}，本回合已停止，以免在你确认计划前改动文件。请检查执行器的 settings 里有没有改权限模式的设置。`;
  }

  // 计划目录内、.md 结尾；软链接解开后也得还在目录里（目录内一个指向外面的链接不能借道写出去）。
  private isPlanFile(path: unknown): path is string {
    if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".md")) return false;
    const target = resolve(path);
    const real = realPath(target);
    return within(resolve(this.plansDir), target) && !!this.realPlansDir && !!real && within(this.realPlansDir, real);
  }

  /** 任一智能体（主 / 子）的一次工具调用：文件修改记账，交计划记下它报的计划文件。 */
  noteToolUse(block: any): void {
    const id = block?.id;
    if (typeof id !== "string") return;
    if (block.name === "ExitPlanMode") this.exits.set(id, absolutePath(block.input?.planFilePath));
    const path = PLAN_FILE_TOOLS.has(block.name) ? absolutePath(block.input?.file_path) : null;
    if (path && !this.mutations.has(id)) this.mutations.set(id, { path, state: "pending" });
  }

  /** 主智能体的每条 assistant 消息（重放时也要喂：接管回来照样认得出计划文件和兜底正文）。 */
  noteAssistant(content: unknown): void {
    for (const block of Array.isArray(content) ? content as any[] : []) {
      if (block?.type === "text" && typeof block.text === "string") this.spoken += block.text;
      if (block?.type !== "tool_use") continue;
      this.noteToolUse(block);
      if (!PLAN_HANDOFF_TOOLS.has(block.name)) this.spoken = "";
    }
  }

  /** 任一智能体的工具回执（同样要在重放时喂）。交过计划之后计划文件又改成了，返回重新交的那份计划。 */
  noteToolResult(block: any): AgentEvent[] {
    const id = block?.tool_use_id;
    if (typeof id !== "string") return [];
    if (this.exits.has(id) && resultText(block.content).includes(SUBMITTED)) this.submitted = { path: this.exits.get(id) ?? null };
    const mutation = this.mutations.get(id);
    if (!mutation || mutation.state !== "pending") return [];
    mutation.state = block.is_error === true ? "failed" : "ok";
    if (mutation.state !== "ok" || !this.submitted || !this.isSubmittedPlan(mutation.path)) return [];
    const text = readText(mutation.path);
    if (!text) return [];
    this.submitted = { path: mutation.path };
    return [{ kind: "plan", id: `plan:${id}`, text, status: "complete" }];
  }

  private isSubmittedPlan(path: string): boolean {
    return this.submitted?.path ? path === this.submitted.path : this.isPlanFile(path);
  }

  /** 这次交计划的正文；计划文件最后一次修改没成功 / 没完成时给出拒收原因。 */
  private planText(input: any): { text: string; path: string | null } | { refuse: string } {
    const path = absolutePath(input?.planFilePath);
    const changes = [...this.mutations.values()].filter((m) => path ? m.path === path : this.isPlanFile(m.path));
    const latest = changes.at(-1);
    if (latest?.state === "pending") return { refuse: WRITE_PENDING };
    if (latest?.state === "failed") return { refuse: WRITE_FAILED };
    const file = path ?? latest?.path ?? null;
    const given = typeof input?.plan === "string" ? input.plan.trim() : "";
    const text = given || (file ? readText(file) : "") || (changes.length ? "" : this.spoken.trim());
    return { text, path: file };
  }

  /** 回一条 control_request；返回要推进事件流的事件（计划、澄清问题）。 */
  request(ev: any): AgentEvent[] {
    const requestId = ev?.request_id;
    if (typeof requestId !== "string") return [];
    const request = ev.request ?? {};
    if (request.subtype !== "can_use_tool") {
      this.write(failure(requestId, `Navi 不处理 ${String(request.subtype)} 控制请求`));
      return [];
    }
    const tool = String(request.tool_name ?? "");
    const input = request.input ?? {};
    const allow = () => this.write(response(requestId, { behavior: "allow", updatedInput: input }));
    const deny = (message: string) => this.write(response(requestId, { behavior: "deny", message }));
    if (this.halted) { deny("计划模式没有生效，本回合已停止。"); return []; }
    if (tool === "ExitPlanMode") {
      const plan = this.planText(input);
      if ("refuse" in plan) { deny(plan.refuse); return []; }
      if (!plan.text) { deny(NO_PLAN); return []; }
      deny(SUBMITTED);
      this.spoken = "";
      this.submitted = { path: plan.path };
      return [{ kind: "plan", id: `plan:${String(request.tool_use_id ?? requestId)}`, text: plan.text, status: "complete" }];
    }
    if (tool === "AskUserQuestion") {
      const questions = questionsOf(input);
      if (!questions.length) { deny(READ_ONLY_DENIAL(tool)); return []; }
      deny(ASKED);
      return [{ kind: "userInput", questions }];
    }
    if (PLAN_FILE_TOOLS.has(tool) && this.isPlanFile(input.file_path)) {
      this.noteToolUse({ id: request.tool_use_id, name: tool, input });
      allow();
      return [];
    }
    if (READ_ONLY.has(tool)) { allow(); return []; }
    deny(READ_ONLY_DENIAL(tool));
    return [];
  }
}

const absolutePath = (path: unknown): string | null => typeof path === "string" && isAbsolute(path) ? resolve(path) : null;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

const resultText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("") : "";

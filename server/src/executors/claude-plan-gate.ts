// Claude Code 计划模式（`/plan`）回合的权限闸。
//
// headless 下进计划模式只有一条路（claude 2.1.283 实测，2026-11-20）：起跑时
// `--permission-mode plan` **加** `--permission-prompt-tool stdio`、输入走 stream-json。
//   · 只给 `--permission-mode plan`：init 的 tools 里没有 ExitPlanMode，计划文件（配置目录
//     下 `plans/<slug>.md`）被当敏感文件拒写——模型交不出计划，回合白跑。
//   · 跟 `--dangerously-skip-permissions` 同传：后者赢（init 报 bypassPermissions），等于没进计划模式。
//   · 加了 stdio：CLI 把每一次要权限的工具调用以 `control_request{subtype:"can_use_tool"}` 写到
//     stdout，等 stdin 回 `control_response`。ExitPlanMode 也走这条，`input` 里是 CLI 自己从计划文件
//     读出的正文（`plan`）和计划文件路径（`planFilePath`）。
//   · 本会话的计划文件（CLI 告诉模型的那一份，`<计划目录>/<slug>.md`）CLI 自己放行，**从不来问**——
//     默认 `~/.claude/plans`、自定义配置目录、项目内 `plansDirectory` 都实测过（2026-11-20）。来问的
//     写文件请求（`decision_reason_type: "mode"`）都是别的文件：项目文档、别的会话的计划、新建的 md，
//     哪怕它们也在计划目录里、也是 .md。所以计划回合 Navi 一个写请求都不放行，授权不靠按目录猜。
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
/** 改文件的工具：只为记账（交计划那一刻计划文件最近一次修改成没成），不据它放行。 */
const PLAN_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
/** 由闸换成计划 / 澄清问题事件的两种工具：流里不再把它们画成一次工具调用。 */
export const PLAN_HANDOFF_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

const SUBMITTED = "计划已提交给用户审阅。不要再调用任何工具，用一两句话说明计划要点后结束本回合；用户确认后会让你开始实施。";
const ASKED = "问题已转交给用户。不要再调用任何工具，结束本回合等待答复。";
const NO_PLAN = "没有找到计划正文。先把完整计划写进计划文件，再调用 ExitPlanMode。";
const WRITE_FAILED = "最近一次写计划文件失败了，计划文件里不是你最新的计划。先把完整计划成功写进计划文件，再调用 ExitPlanMode。";
const WRITE_PENDING = "计划文件最近一次修改还没完成。等它完成后再调用 ExitPlanMode。";
const READ_ONLY_DENIAL = (tool: string) => `计划模式只读：本回合不能执行 ${tool}。需要的话把这一步写进计划，用户确认实施后再做。`;
const WRITE_DENIAL = (path: unknown) => `计划模式只读：${String(path ?? "这个文件")} 不是本会话的计划文件，不能写。计划只写进 Claude Code 指定给你的那份计划文件（写它不需要批准）；其他文件的改动写进计划，用户确认实施后再做。`;

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

/** 一次对文件的修改（Write / Edit / MultiEdit）。`seq` 是它在会话历史里出现的先后，状态只认工具回执。 */
interface Mutation { seq: number; path: string; state: "pending" | "ok" | "failed" }

/**
 * 计划卡是**交计划那一刻的快照**：ExitPlanMode 到达时判一次能不能交、交哪份正文，出一张卡，此后
 * 这张卡不再变。用户批准的就是卡上这份原文，「实施此计划」时服务端从会话记录里取出它交给模型
 * （task-plan.ts `assertPlanReady` → plan-turn.ts），所以交出之后计划文件怎么改都不影响实施内容；
 * 模型要改计划只能再交一次，出一张新卡（实施只认最新那张）。不追交出之后的修改——那等于持续证明一个
 * Navi 管不着的文件没变，乱序、并发、接管重放、停机期间改盘，每一种都是新的对不上的窗口。
 *
 * 交的那一刻按会话历史判（`settle`）：改到计划文件的修改里还有没回执的、或最后发起的那次失败了，
 * 不收（模型的最新意图没落盘）；都结清且最后那次成功，正文还得非空才收。CLI 会把盘上的旧正文自己
 * 补进 ExitPlanMode 的 `input.plan`（2.1.283 实测），所以入参有正文不等于能交。哪个文件是计划文件
 * 以 CLI 在 ExitPlanMode 里报的 `planFilePath` 为准，没报（老版本）才用目录判。
 *
 * 接管重放只记账（文件修改的先后与回执，供之后直播里的交计划判），不回 CLI、不出卡：当年出的卡已经
 * 在会话记录里了。
 */
export class ClaudePlanGate {
  private seq = 0;
  private readonly mutations = new Map<string, Mutation>();
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

  // 没报计划文件路径的老版本 CLI 才用：计划目录内、.md 结尾。两边都按真实路径比（`/tmp` 与 `/private/tmp`、
  // 项目软链接这类等价拼写是同一个文件）。只用于记账，不据它放行。
  private isPlanFile(path: string): boolean {
    return path.endsWith(".md") && within(this.realPlansDir ?? resolve(this.plansDir), path);
  }

  /** 这一刻能交哪份正文；不能交时给出原因。`given` 是 CLI 随 ExitPlanMode 带来的正文。 */
  private current(planPath: string | null, given: unknown): { text: string } | { refuse: string } {
    const target = planPath ? identity(planPath) : null;
    const changes = [...this.mutations].filter(([, m]) => target ? m.path === target : this.isPlanFile(m.path));
    const last = changes.length ? changes.reduce((a, b) => b[1].seq > a[1].seq ? b : a)[1] : undefined;
    if (changes.some(([, m]) => m.state === "pending")) return { refuse: WRITE_PENDING };
    if (last?.state === "failed") return { refuse: WRITE_FAILED };
    const file = planPath ?? last?.path ?? null;
    const text = (typeof given === "string" ? given.trim() : "") || (file ? readText(file) : "") || (last ? "" : this.spoken.trim());
    return text ? { text } : { refuse: NO_PLAN };
  }

  /** 任一智能体（主 / 子）的一次工具调用：改文件的记进历史。 */
  noteToolUse(block: any): void {
    const id = block?.id;
    const path = typeof id === "string" && PLAN_FILE_TOOLS.has(block.name) ? absolutePath(block.input?.file_path) : null;
    if (path && !this.mutations.has(id)) this.mutations.set(id, { seq: ++this.seq, path: identity(path), state: "pending" });
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

  /** 任一智能体的工具回执（同样要在重放时喂）。 */
  noteToolResult(block: any): void {
    const mutation = typeof block?.tool_use_id === "string" ? this.mutations.get(block.tool_use_id) : undefined;
    if (mutation?.state === "pending") mutation.state = block.is_error === true ? "failed" : "ok";
  }

  /**
   * 回一条 control_request；返回要推进事件流的事件（计划、澄清问题）。接管重放（`replaying`）时那条请求
   * 当年已经回过、卡也出过了：只记账，不回 CLI、不出事件。
   */
  request(ev: any, replaying = false): AgentEvent[] {
    const requestId = ev?.request_id;
    if (typeof requestId !== "string") return [];
    const request = ev.request ?? {};
    const tool = String(request.tool_name ?? "");
    const input = request.input ?? {};
    if (replaying) {
      if (tool === "ExitPlanMode") this.spoken = "";
      return [];
    }
    if (request.subtype !== "can_use_tool") {
      this.write(failure(requestId, `Navi 不处理 ${String(request.subtype)} 控制请求`));
      return [];
    }
    const allow = () => this.write(response(requestId, { behavior: "allow", updatedInput: input }));
    const deny = (message: string) => this.write(response(requestId, { behavior: "deny", message }));
    if (this.halted) { deny("计划模式没有生效，本回合已停止。"); return []; }
    if (tool === "ExitPlanMode") {
      const plan = this.current(absolutePath(input.planFilePath), input.plan);
      if ("refuse" in plan) { deny(plan.refuse); return []; }
      deny(SUBMITTED);
      this.spoken = "";
      return [{ kind: "plan", id: `plan:${String(request.tool_use_id ?? requestId)}`, text: plan.text, status: "complete" }];
    }
    if (tool === "AskUserQuestion") {
      const questions = questionsOf(input);
      if (!questions.length) { deny(READ_ONLY_DENIAL(tool)); return []; }
      deny(ASKED);
      return [{ kind: "userInput", questions }];
    }
    if (PLAN_FILE_TOOLS.has(tool)) { deny(WRITE_DENIAL(input.file_path)); return []; }
    if (READ_ONLY.has(tool)) { allow(); return []; }
    deny(READ_ONLY_DENIAL(tool));
    return [];
  }
}

const absolutePath = (path: unknown): string | null => typeof path === "string" && isAbsolute(path) ? resolve(path) : null;
/** 一个文件的身份：解开软链接后的真实路径；证明不了（悬空链接、读不了）就用字面路径。 */
const identity = (path: string): string => realPath(path) ?? path;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

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
/** 交计划被拒时回给 CLI 的那几句：重放里认得出「当年没交成」。 */
const REFUSALS = [NO_PLAN, WRITE_FAILED, WRITE_PENDING];
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

/** 一次对文件的修改（Write / Edit / MultiEdit）。`seq` 是它在会话历史里出现的先后，状态只认工具回执。 */
interface Mutation { seq: number; path: string; state: "pending" | "ok" | "failed" }
/** 一次交出的计划：卡片 id、在历史里的位置、对应的计划文件（null = 交的是模型说的话）、正文。 */
interface Submission { id: string; seq: number; path: string | null; text: string }
type Verdict = "none" | "pending" | "failed" | "ok";

/**
 * 计划卡能不能实施，是**从会话历史推出来的**，不是一路改出来的标志：历史里记着每次文件修改（何时
 * 开始、回执成败）与每次交计划（在哪个位置交的），任何一条新输入进来都从头判一遍，再把「会话记录
 * 里这张卡此刻的样子」和判出来的样子比，差在哪就发哪条事件。于是不中断直播、从任意位置接管重放、
 * 修改并发/乱序，得到的都是同一个结果。判据只有一个 `settle()`：
 *   · 相关修改里还有没回执的 → 不可交 / 不可实施；最后发起的那次失败了 → 同上（模型的最新意图没落盘）；
 *   · 都结清且最后那次成功，正文还得非空，才可交 / 可实施。
 * 交计划时按整段历史判；交出之后按「交计划那个位置之后」的修改判：一有修改开始，卡就退回草稿（同 id
 * 追加一条 streaming，卡片与实施预检都只认最新一条 complete）；结清且可交时按盘上正文出一张新卡。
 * CLI 会把盘上的旧正文自己补进 ExitPlanMode 的 `input.plan`（2.1.283 实测），所以入参有正文不等于能交。
 * 哪个文件是计划文件以 CLI 在 ExitPlanMode 里报的 `planFilePath` 为准，没报（老版本）才用目录判。
 */
export class ClaudePlanGate {
  private seq = 0;
  private readonly mutations = new Map<string, Mutation>();
  /** ExitPlanMode 的 tool_use_id → 它在历史里的位置、报的计划文件、CLI 补进来的正文。 */
  private readonly exits = new Map<string, { seq: number; path: string | null; text: string }>();
  private readonly submissions: Submission[] = [];
  /** 会话记录里最新那张卡此刻的样子（直播发出去的，或重放里当年已发出去的）。 */
  private shown: { id: string; live: boolean } | undefined;
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

  /** 这处修改改的是不是这份计划的文件（CLI 报了路径就按路径，否则按目录）。 */
  private touches(planPath: string | null, path: string): boolean {
    return planPath ? path === planPath : this.isPlanFile(path);
  }

  /** 历史里 `since` 之后、改到这份计划文件的修改结清了没有。 */
  private settle(planPath: string | null, since: number): { verdict: Verdict; last?: Mutation & { id: string } } {
    const changes = [...this.mutations].filter(([, m]) => m.seq > since && this.touches(planPath, m.path));
    if (!changes.length) return { verdict: "none" };
    const [id, last] = changes.reduce((a, b) => b[1].seq > a[1].seq ? b : a);
    const verdict = changes.some(([, m]) => m.state === "pending") ? "pending" : last.state === "failed" ? "failed" : "ok";
    return { verdict, last: { ...last, id } };
  }

  /** 交计划这一刻能交哪份正文；不能交时给出原因。`given` 是 CLI 随 ExitPlanMode 带来的正文。 */
  private current(planPath: string | null, given: unknown): { text: string; path: string | null } | { refuse: string } {
    const { verdict, last } = this.settle(planPath, -1);
    if (verdict === "pending") return { refuse: WRITE_PENDING };
    if (verdict === "failed") return { refuse: WRITE_FAILED };
    const file = planPath ?? last?.path ?? null;
    const text = (typeof given === "string" ? given.trim() : "") || (file ? readText(file) : "") || (last ? "" : this.spoken.trim());
    return text ? { text, path: file } : { refuse: NO_PLAN };
  }

  /** 从历史判出最新那张卡此刻该是什么样，跟会话记录里的样子比，返回补齐差距要发的事件。 */
  private reduce(): AgentEvent[] {
    const latest = this.submissions.at(-1);
    if (!latest) return [];
    const { verdict, last } = this.settle(latest.path, latest.seq);
    if (verdict === "ok" && last) {
      const path = latest.path ?? last.path;
      const text = readText(path);
      // 交出之后改成了：按盘上正文重新交一份，它之后的修改再从它算起。
      if (text) this.submissions.push({ id: `plan:${last.id}`, seq: ++this.seq, path, text });
    }
    const current = this.submissions.at(-1)!;
    const live = this.settle(current.path, current.seq).verdict === "none";
    if (this.shown?.id === current.id && this.shown.live === live) return [];
    const was = this.shown;
    this.shown = { id: current.id, live };
    if (live) return [{ kind: "plan", id: current.id, text: current.text, status: "complete" }];
    // 退回草稿：同 id 追加一条 streaming，正文不动。记录里没有这张完整卡就不用退。
    return was?.id === current.id && was.live ? [{ kind: "plan", id: current.id, text: "", status: "streaming", delta: true }] : [];
  }

  /** 任一智能体（主 / 子）的一次工具调用：文件修改与交计划记进历史。 */
  noteToolUse(block: any): AgentEvent[] {
    const id = block?.id;
    if (typeof id !== "string") return [];
    if (block.name === "ExitPlanMode" && !this.exits.has(id)) {
      this.exits.set(id, { seq: ++this.seq, path: absolutePath(block.input?.planFilePath), text: typeof block.input?.plan === "string" ? block.input.plan.trim() : "" });
    }
    const path = PLAN_FILE_TOOLS.has(block.name) ? absolutePath(block.input?.file_path) : null;
    if (!path || this.mutations.has(id)) return [];
    this.mutations.set(id, { seq: ++this.seq, path, state: "pending" });
    return this.reduce();
  }

  /** 主智能体的每条 assistant 消息（重放时也要喂：接管回来照样认得出计划文件和兜底正文）。 */
  noteAssistant(content: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const block of Array.isArray(content) ? content as any[] : []) {
      if (block?.type === "text" && typeof block.text === "string") this.spoken += block.text;
      if (block?.type !== "tool_use") continue;
      events.push(...this.noteToolUse(block));
      if (!PLAN_HANDOFF_TOOLS.has(block.name)) this.spoken = "";
    }
    return events;
  }

  /** 任一智能体的工具回执（同样要在重放时喂）。 */
  noteToolResult(block: any): AgentEvent[] {
    const id = block?.tool_use_id;
    if (typeof id !== "string") return [];
    const exit = this.exits.get(id);
    if (exit) {
      // 交没交成以 CLI 收到的那句回执为准：跟权限请求那一刻判的不一致（重放时盘上正文变了）就按它改历史。
      const said = resultText(block.content);
      const at = this.submissions.findIndex((entry) => entry.id === `plan:${id}`);
      if (said.includes(SUBMITTED) && at < 0) this.submissions.push({ id: `plan:${id}`, seq: exit.seq, path: exit.path, text: exit.text || readText(exit.path ?? "") });
      if (REFUSALS.some((refusal) => said.includes(refusal)) && at >= 0) this.submissions.splice(at, 1);
      this.submissions.sort((a, b) => a.seq - b.seq);
    }
    const mutation = this.mutations.get(id);
    if (mutation?.state === "pending") mutation.state = block.is_error === true ? "failed" : "ok";
    return exit || mutation ? this.reduce() : [];
  }

  /**
   * 回一条 control_request；返回要推进事件流的事件（计划、澄清问题）。接管重放（`replaying`）时那条请求
   * 当年已经回过：照样走一遍判定，把交计划记进历史，只是不再回 CLI。
   */
  request(ev: any, replaying = false): AgentEvent[] {
    const requestId = ev?.request_id;
    if (typeof requestId !== "string") return [];
    const request = ev.request ?? {};
    const reply = (line: string) => { if (!replaying) this.write(line); };
    if (request.subtype !== "can_use_tool") {
      reply(failure(requestId, `Navi 不处理 ${String(request.subtype)} 控制请求`));
      return [];
    }
    const tool = String(request.tool_name ?? "");
    const input = request.input ?? {};
    const allow = () => reply(response(requestId, { behavior: "allow", updatedInput: input }));
    const deny = (message: string) => reply(response(requestId, { behavior: "deny", message }));
    if (this.halted) { deny("计划模式没有生效，本回合已停止。"); return []; }
    if (tool === "ExitPlanMode") {
      const plan = this.current(absolutePath(input.planFilePath), input.plan);
      if ("refuse" in plan) { deny(plan.refuse); return []; }
      deny(SUBMITTED);
      this.spoken = "";
      const toolUseId = String(request.tool_use_id ?? requestId);
      const id = `plan:${toolUseId}`;
      if (!this.submissions.some((entry) => entry.id === id)) {
        this.submissions.push({ id, seq: this.exits.get(toolUseId)?.seq ?? ++this.seq, path: plan.path, text: plan.text });
        this.submissions.sort((a, b) => a.seq - b.seq);
      }
      return this.reduce();
    }
    if (tool === "AskUserQuestion") {
      const questions = questionsOf(input);
      if (!questions.length) { deny(READ_ONLY_DENIAL(tool)); return []; }
      deny(ASKED);
      return [{ kind: "userInput", questions }];
    }
    if (PLAN_FILE_TOOLS.has(tool) && this.isPlanFile(input.file_path)) {
      const events = this.noteToolUse({ id: request.tool_use_id, name: tool, input });
      allow();
      return events;
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

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
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentEvent, QuestionItem } from "@navi/shared";
import { claudeConfigDirOf, userConfigDir } from "./claude-settings.js";

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
const READ_ONLY_DENIAL = (tool: string) => `计划模式只读：本回合不能执行 ${tool}。需要的话把这一步写进计划，用户确认实施后再做。`;

type ControlLine = (line: string) => void;

const response = (requestId: string, body: Record<string, unknown>) =>
  JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: body } }) + "\n";
const failure = (requestId: string, error: string) =>
  JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: requestId, error } }) + "\n";

/** 这次起跑子进程的计划文件目录（随 profile 的 CLAUDE_CONFIG_DIR 走，没设就是 `~/.claude/plans`）。 */
export function claudePlansDir(env: Readonly<Record<string, string | undefined>> | undefined): string {
  return join(userConfigDir(claudeConfigDirOf(env)), "plans");
}

function questionsOf(input: any): QuestionItem[] {
  return (Array.isArray(input?.questions) ? input.questions : []).flatMap((question: any) => {
    if (typeof question?.question !== "string" || !question.question.trim()) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((option: any) =>
      typeof option?.label === "string" ? [option.description ? `${option.label}：${option.description}` : option.label] : []);
    return [{ question: question.question, ...(options.length ? { options } : {}) }];
  });
}

export class ClaudePlanGate {
  private planFile: string | null = null;
  /** 上一次交计划之后模型说过的话：计划文件读不到时的兜底正文。 */
  private spoken = "";

  constructor(private readonly plansDir: string, private readonly write: ControlLine) {}

  private isPlanFile(path: unknown): path is string {
    if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".md")) return false;
    const inside = relative(this.plansDir, resolve(path));
    return !!inside && !inside.startsWith("..") && !isAbsolute(inside);
  }

  /** 主智能体的每条 assistant 消息（重放时也要喂：接管回来照样认得出计划文件和兜底正文）。 */
  noteAssistant(content: unknown): void {
    for (const block of Array.isArray(content) ? content as any[] : []) {
      if (block?.type === "text" && typeof block.text === "string") this.spoken += block.text;
      if (block?.type === "tool_use" && PLAN_FILE_TOOLS.has(block.name) && this.isPlanFile(block.input?.file_path)) this.planFile = resolve(block.input.file_path);
    }
  }

  private planText(input: any): string {
    if (typeof input?.plan === "string" && input.plan.trim()) return input.plan.trim();
    if (this.planFile) {
      try {
        const text = readFileSync(this.planFile, "utf8").trim();
        if (text) return text;
      } catch {
        // 文件没写成（路径写错、被拒）就退回模型说过的话。
      }
    }
    return this.spoken.trim();
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
    if (tool === "ExitPlanMode") {
      const text = this.planText(input);
      if (!text) { deny(NO_PLAN); return []; }
      deny(SUBMITTED);
      this.spoken = "";
      return [{ kind: "plan", id: `plan:${String(request.tool_use_id ?? requestId)}`, text, status: "complete" }];
    }
    if (tool === "AskUserQuestion") {
      const questions = questionsOf(input);
      if (!questions.length) { deny(READ_ONLY_DENIAL(tool)); return []; }
      deny(ASKED);
      return [{ kind: "userInput", questions }];
    }
    if (PLAN_FILE_TOOLS.has(tool) && this.isPlanFile(input.file_path)) {
      this.planFile = resolve(input.file_path);
      allow();
      return [];
    }
    if (READ_ONLY.has(tool)) { allow(); return []; }
    deny(READ_ONLY_DENIAL(tool));
    return [];
  }
}

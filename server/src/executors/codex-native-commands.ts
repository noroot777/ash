import type { AgentEvent, ContextUsage } from "@ash/shared";
import { goalRequest, isGoalExecution, type CliCommand, type CliGoal, type CliSessionState } from "@ash/shared/cli-commands";

type Transport = {
  request(method: string, params: Record<string, unknown>): Promise<any>;
  threadId(): string;
  turnId(): string;
  model(): string;
  reasoningEffort?(): string | null;
  cwd: string;
  prompt: string;
  state?: CliSessionState;
  turnOptions?: Record<string, unknown>;
  usage?(): unknown;
  context?(): Promise<ContextUsage | null>;
  push(event: AgentEvent): void;
};

const statusNames: Record<string, string> = {
  active: "运行中", paused: "已暂停", blocked: "被阻塞", usageLimited: "额度不足", budgetLimited: "预算已耗尽", complete: "已完成",
};

export function redactCommandData(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[已隐藏]@").replace(/([?&](?:api[_-]?key|(?:access[_-]?)?token|key|auth|password)=)[^&#\s]+/gi, "$1[已隐藏]");
  if (Array.isArray(value)) return value.map(redactCommandData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, /api.?key|password|secret|(?:key|token)$|authorization|credentials|bearer|cookie|^(env|env_vars|headers|http_headers|env_http_headers)$/i.test(key) ? "[已隐藏]" : redactCommandData(field)]));
}

export function formatGoal(goal: CliGoal | null): string {
  if (!goal) return "当前没有目标。使用 /goal 描述 设置持续目标。";
  return `目标：${goal.objective}\n状态：${statusNames[goal.status] ?? goal.status}\n用量：${goal.tokensUsed ?? 0}${goal.tokenBudget ? ` / ${goal.tokenBudget}` : "（未设预算）"} tokens\n用时：${goal.timeUsedSeconds ?? 0} 秒`;
}

export class CodexNativeCommands {
  goal: CliGoal | null = null;
  goalExecution = false;
  goalStarted = false;
  constructor(private readonly transport: Transport) {}

  notification(method: string, params: any): void {
    if (method === "thread/goal/updated") {
      this.goal = params.goal;
      this.transport.push({ kind: "system", level: "notice", aside: true, at: new Date().toISOString(), text: `〔目标〕${formatGoal(this.goal)}` });
    } else if (method === "thread/goal/cleared") {
      this.goal = null;
      this.transport.push({ kind: "system", level: "notice", aside: true, at: new Date().toISOString(), text: "〔目标〕已清除；任务和会话历史保留。" });
    }
  }

  async prepare(command?: CliCommand): Promise<void> {
    try {
      this.goal = (await this.transport.request("thread/goal/get", { threadId: this.transport.threadId() })).goal ?? null;
    } catch (error) {
      if (command?.name === "goal") throw error;
    }
    if (this.goal?.status === "active") {
      this.goal = (await this.transport.request("thread/goal/set", { threadId: this.transport.threadId(), status: "paused" })).goal;
    }
  }

  async start(command: CliCommand): Promise<{ turnId?: string; immediate: boolean }> {
    if (command.name === "goal" && isGoalExecution(command)) {
      this.goalExecution = true;
      const change = goalRequest(command, "codex");
      this.goal = (await this.transport.request("thread/goal/set", { threadId: this.transport.threadId(), ...change, status: "paused" })).goal;
      const started = await this.transport.request("turn/start", {
        threadId: this.transport.threadId(), input: [{ type: "text", text: this.transport.prompt }],
        ...this.transport.turnOptions,
        collaborationMode: this.collaborationMode("default"),
      });
      this.goalStarted = true;
      this.goal = (await this.transport.request("thread/goal/set", { threadId: this.transport.threadId(), status: "active" })).goal;
      return { immediate: false, turnId: started.turn?.id };
    }
    if (command.name === "compact") {
      await this.transport.request("thread/compact/start", { threadId: this.transport.threadId() });
      return { immediate: false };
    }
    if (command.name === "review") {
      const target = command.args.startsWith("--base ") ? { type: "baseBranch", branch: command.args.slice(7).trim() }
        : command.args.startsWith("--commit ") ? { type: "commit", sha: command.args.slice(9).trim() }
        : command.args ? { type: "custom", instructions: command.args } : { type: "uncommittedChanges" };
      const result = await this.transport.request("review/start", { threadId: this.transport.threadId(), target, delivery: "inline" });
      return { immediate: false, turnId: result.turn?.id };
    }
    if (command.name === "plan" && command.args && command.args !== "off") {
      const result = await this.transport.request("turn/start", {
        threadId: this.transport.threadId(), input: [{ type: "text", text: command.args }],
        ...this.transport.turnOptions,
        collaborationMode: this.collaborationMode(),
      });
      return { immediate: false, turnId: result.turn?.id };
    }
    const output = await this.control(command);
    this.transport.push({ kind: "text", text: `${output}\n\n` });
    return { immediate: true };
  }

  collaborationMode(mode: "default" | "plan" = "plan") {
    return { mode, settings: { model: this.transport.model(), reasoning_effort: this.transport.reasoningEffort?.() ?? this.transport.turnOptions?.effort ?? null, developer_instructions: null } };
  }

  async afterTurn(): Promise<boolean> {
    if (!this.goalExecution) return true;
    this.goal = (await this.transport.request("thread/goal/get", { threadId: this.transport.threadId() })).goal ?? null;
    return this.goal?.status !== "active";
  }

  async control(command: CliCommand): Promise<string> {
    const request = this.transport.request;
    const threadId = this.transport.threadId();
    const stringify = (value: unknown) => JSON.stringify(redactCommandData(value), null, 2);
    if (command.name === "goal") {
      if (!command.args) this.goal = (await request("thread/goal/get", { threadId })).goal ?? null;
      else if (/^(clear|stop|off|reset|none|cancel)$/.test(command.args)) {
        await request("thread/goal/clear", { threadId }); this.goal = null;
      } else {
        if (isGoalExecution(command)) throw new Error("运行中不能替换目标；先 /goal pause，再设置或恢复目标");
        this.goal = (await request("thread/goal/set", { threadId, ...goalRequest(command, "codex") })).goal;
      }
      if (this.goalExecution && (command.args === "pause" || /^(clear|stop|off|reset|none|cancel)$/.test(command.args)) && this.transport.turnId()) await request("turn/interrupt", { threadId, turnId: this.transport.turnId() });
      return formatGoal(this.goal);
    }
    if (command.name === "plan") return `计划模式${this.transport.state?.plan ? "已开启；下一条消息只做计划。/plan off 退出" : "已关闭"}`;
    if (command.name === "personality") return `当前表达风格：${this.transport.state?.personality ?? "跟随执行器"}`;
    if (command.name === "fast") return `快速档：${this.transport.state?.serviceTier === "priority" ? "已开启" : "已关闭"}`;
    if (command.name === "status") return stringify({ model: this.transport.model(), plan: this.transport.state?.plan ?? false, usage: this.transport.usage?.() ?? null, contextSnapshot: await this.transport.context?.() ?? null, ...await request("thread/read", { threadId, includeTurns: false }) });
    if (command.name === "usage") {
      const results = await Promise.allSettled([request("account/usage/read", {}), request("account/rateLimits/read", {})]);
      const output = results.map((result) => result.status === "fulfilled" ? result.value : { error: String(result.reason) });
      if (results.every((result) => result.status === "rejected")) throw new Error(`当前供应商不支持原生账号用量查询：${output.map((result) => result.error).join("；")}`);
      return stringify({ tokenUsage: output[0], rateLimits: output[1] });
    }
    if (command.name === "mcp") {
      const servers: unknown[] = []; let cursor: string | null = null;
      do { const page = await request("mcpServerStatus/list", { threadId, cursor, limit: 100, detail: "toolsAndAuthOnly" }); servers.push(...page.data); cursor = page.nextCursor; } while (cursor);
      return stringify(servers);
    }
    if (command.name === "ps") return stringify(await request("thread/backgroundTerminals/list", { threadId }));
    if (command.name === "stop") { await request("thread/backgroundTerminals/clean", { threadId }); return "当前会话的后台终端已停止；ash 任务未取消。"; }
    if (command.name === "debug-config") return stringify(await request("config/read", { includeLayers: true, cwd: this.transport.cwd }));
    if (command.name === "hooks") return stringify(await request("hooks/list", { cwds: [this.transport.cwd] }));
    if (command.name === "plugins") return stringify(await request("plugin/list", { cwds: [this.transport.cwd], forceRefetch: false, marketplaceKinds: ["local"] }));
    if (command.name === "apps") {
      const apps: unknown[] = []; let cursor: string | null = null;
      do { const page = await request("app/list", { threadId, cursor }); apps.push(...page.data); cursor = page.nextCursor; } while (cursor);
      return stringify(apps);
    }
    if (command.name === "rename") { await request("thread/name/set", { threadId, name: command.args }); return `会话已重命名为：${command.args}`; }
    if (command.name === "fork") return "已创建独立会话分支；原会话和历史记录保留，目标不会自动启动。使用 /goal resume 显式恢复。";
    if (command.name === "new" || command.name === "clear") return "已新建会话；旧会话记录保留，不删除任务或文件。";
    throw new Error(`未实现的原生命令 /${command.name}`);
  }

  get expectedInterruption(): boolean { return this.goalExecution && (!this.goal || this.goal.status === "paused"); }
}

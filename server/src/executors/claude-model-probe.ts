// 「claude 这个账号现在能选哪些模型、每个模型允许哪些智能水平」—— 问 claude 自己。
//
// claude 没有 `models` 子命令(2.1.283 实测),但它的 **control protocol 有**:host 发
// 一个 `initialize` 请求,响应里就带 `models: ModelInfo[]`,每行形如
//   {value:"sonnet", resolvedModel:"claude-sonnet-5", supportsEffort:true,
//    supportedEffortLevels:["low","medium","high","xhigh","max"], …}
// 而 `haiku` 那行**整个没有** supportsEffort/supportedEffortLevels 两个字段 —— 这正是
// `MODEL_EFFORT_RULES` 里手写的 `claude:haiku-* → []` 那条规则想表达的事,只不过现在是
// CLI 自己说的。
//
// 三条约束与 model-probe 的既有设计一致:
//  ① **只问,不跑**:只发 control_request,一个 user 消息都不发 → 不触发回合、零 token、
//     不落会话文件(实测 `~/.claude/projects/-tmp/` 不会被创建)。
//  ② **不碰用户的环境**:`--setting-sources ""` + `--strict-mcp-config` 让它既不加载
//     user/project/local settings、也不起任何 MCP server。实测这一下把 SessionStart
//     hook 事件从 4 个降到 0、耗时 230ms → 185ms。
//     **代价要说清**:在 settings 里配认证(apiKeyHelper / env 里的 key)的用户会探不到,
//     那时档位退回规则表 —— 这比「每次探测都跑一遍用户的 SessionStart hook」更可接受,
//     因为后者是确定发生的副作用,且 hook 可能很慢、可能有写操作。
//  ③ **拿到就杀**:响应一到立刻 SIGKILL。它是个等 stdin 的常驻进程,不杀会一直挂着。
//
// 为什么不复用派任务时的 init 事件(那更省):`system/init` 要等第一个 user 消息才发,
// 而模型选择器需要在**派任务之前**就有候选 —— 不能依赖「这台机器曾经派过 claude 任务」。

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { modelEffortKey } from "@ash/shared/cli-presets";
import type { ModelEffortMap } from "@ash/shared/cli-presets";
import { resolveLaunch } from "./bin-resolve.js";

/** 握手超时。实测 185ms 拿到结果,给够 10s 足以容忍冷启动与磁盘慢。 */
const TIMEOUT_MS = 10_000;

/** 一个账号报几十个模型就算多了;上限只为防止把脏输出整段吃进来。 */
const MAX_MODELS = 200;

export interface ClaudeModelProbe {
  /** `value` 字段(别名 / `default`),按 CLI 报的顺序。 */
  models: string[];
  /** 别名与 canonical id 都登记,见 `registerEfforts`。 */
  modelEfforts: ModelEffortMap;
}

/** claude control protocol 的 ModelInfo 里我们用到的那几个字段。 */
interface ModelInfoRow {
  value?: unknown;
  resolvedModel?: unknown;
  supportsEffort?: unknown;
  supportedEffortLevels?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * 一行 ModelInfo → 档位集合。
 *
 * **字段缺失 = 不支持**,这是对 claude 这一家的确定读法而不是猜:它的序列化是
 * `...supportsEffort && {supportsEffort: true, supportedEffortLevels: […]}` ——
 * 只在支持时才加这两个字段,所以 haiku 行干净地没有它们。于是:
 *   • `supportsEffort === true` 且 levels 是数组 → 那个数组;
 *   • `supportsEffort === true` 但 levels 缺失/坏了 → null(「不知道」,退回规则表);
 *   • 其余(显式 false / 字段缺失) → 空数组(「这个模型没有档位」)。
 */
function rowEfforts(row: ModelInfoRow): readonly string[] | null {
  if (row.supportsEffort !== true) return [];
  if (!Array.isArray(row.supportedEffortLevels)) return null;
  const efforts = row.supportedEffortLevels
    .map((level) => (typeof level === "string" ? level.trim().toLowerCase() : ""))
    .filter((level, index, all) => level && all.indexOf(level) === index);
  return efforts.length ? efforts : null;
}

/**
 * 把一行的档位登记到 `value`、`resolvedModel`,以及**去掉 `[1m]` 这类上下文后缀**的
 * canonical id 上 —— 三个 key 都指同一个模型,用户在 profile 里填的可能是任意一个
 * (`sonnet` / `claude-sonnet-5` / 从文档抄来的 `claude-opus-5`)。
 *
 * 已登记的 key 不被后面的行覆盖:`default` 那行的 resolvedModel 跟某个具体模型重合,
 * 而具体模型自己那行才是更可信的出处。
 */
function registerEfforts(into: Record<string, readonly string[]>, row: ModelInfoRow, efforts: readonly string[]): void {
  const keys: string[] = [];
  const alias = text(row.value);
  const resolved = text(row.resolvedModel);
  // `default` 不是模型名,是「不指定」的意思 —— 登记它会让 profile 里真填了 "default"
  // 的人拿到当前默认模型的档位,这恰好是对的;但别让它污染 canonical key。
  if (alias) keys.push(alias);
  if (resolved) {
    keys.push(resolved);
    const bare = resolved.replace(/\[[^\]]*\]\s*$/, "").trim();
    if (bare && bare !== resolved) keys.push(bare);
  }
  for (const key of keys) {
    const normalized = modelEffortKey(key);
    if (normalized && !Object.hasOwn(into, normalized)) into[normalized] = efforts;
  }
}

export function parseClaudeModelInfos(rows: unknown): ClaudeModelProbe | null {
  if (!Array.isArray(rows)) return null;
  const models: string[] = [];
  const modelEfforts: Record<string, readonly string[]> = {};
  for (const raw of rows.slice(0, MAX_MODELS)) {
    const row = raw as ModelInfoRow | null;
    if (!row || typeof row !== "object") continue;
    const alias = text(row.value);
    if (alias && !models.includes(alias)) models.push(alias);
    const efforts = rowEfforts(row);
    if (efforts) registerEfforts(modelEfforts, row, efforts);
  }
  return models.length ? { models, modelEfforts } : null;
}

const PROBE_ARGS = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  // 见文件头 ②:不加载 settings、不起 MCP server。
  "--setting-sources", "",
  "--strict-mcp-config",
];

/**
 * 起一次 claude、握一次手、拿到 models 就杀掉。失败/超时返回 null(由调用方诚实降级)。
 *
 * `bin` 必须是 `probeBins` 解析出的**绝对路径**:GUI 启动的 server 常常缺
 * `/opt/homebrew/bin`,裸命令名会「装了却查不到」。
 *
 * **必须走 `resolveLaunch`**,不能裸 spawn:Windows 上 npm 装的 claude 是一个 `.cmd`
 * 垫片,而 Node 自 CVE-2024-27980 起拒绝在没有 shell 的情况下执行批处理 —— 裸 spawn
 * 的结果是这台机器上档位探测**永远**失败,而且因为本函数的失败是静默降级(退回规则
 * 表),没有任何一处会报出来。`resolveLaunch` 在 POSIX 上是恒等变换,Windows 上会把
 * 垫片拆成 `node <script>`(拆不出才退 cmd.exe),与派任务用的是同一套口径。
 * `windowsHide` 同理:不加的话 server 每探一次就在用户桌面上闪一个控制台窗口。
 */
export function probeClaudeModels(bin: string): Promise<ClaudeModelProbe | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const plan = resolveLaunch(bin, PROBE_ARGS);
      if (!plan) {
        resolve(null);
        return;
      }
      child = spawn(plan.file, plan.args, {
        cwd: tmpdir(),
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch {
      // resolveLaunch 在「参数含换行、Windows 无法转义」时会抛 —— 我们的参数是常量,
      // 到不了那条路,但接住它比让一个探测失败冒泡成请求失败强。
      resolve(null);
      return;
    }
    let settled = false;
    let buffer = "";
    const finish = (result: ClaudeModelProbe | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // SIGKILL 而不是 SIGTERM:它正阻塞在读 stdin 上,我们不关心它的善后。
      try { child.kill("SIGKILL"); } catch { /* 已经死了 */ }
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      // 行数上限:万一它改成往 stdout 刷别的东西,别把内存吃光。
      if (buffer.length > 1024 * 1024) buffer = "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: any;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.type !== "control_response") continue;
        const payload = event.response?.response;
        if (!payload || !("models" in payload)) continue;
        finish(parseClaudeModelInfos(payload.models));
        return;
      }
    });
    try {
      child.stdin?.write(`${JSON.stringify({
        type: "control_request",
        request_id: "ash_models_1",
        request: { subtype: "initialize" },
      })}\n`);
    } catch {
      finish(null);
    }
  });
}

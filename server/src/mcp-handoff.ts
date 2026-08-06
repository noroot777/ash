// 交卷丢了就回头补捞：把 agent 那些「确定没送达」的 harness MCP 调用，在回合结算前替它重放。
//
// 起因（2026-08-06）：codex 跑完一轮就地验证，报告写着「通过」，可 `report_stage(verified)`
// 连调两次都撞上 `Transport closed` —— `scripts/restart.sh` 那一刻正好重建并杀掉了所有
// `node mcp/dist/index.js` 子进程。于是 `concludeRound` 读不到 stage，判「无结论，等待人工
// 处理」，12 分钟的验证白跑。同一条路上更常见的受害者是 `complete_task`：它丢了，严格结算
// 就把一个**干完了活**的任务记成 failed。
//
// 为什么补捞必须在 harness 这一侧：`mcp/src/index.ts` 的 `call()` 早就有退避重试，但那是
// **在 MCP 进程自己肚子里**重试，只救得了「server 在重启、MCP 还活着」；MCP 进程本身被杀
// 时，重试的代码跟着一起死了。能在事后说清「它想干什么、干成没有」的只剩 harness 自己写的
// 那份输出流。
//
// 三条口径：
// ① **清单不用谁去写**。agent 的每一次工具调用（含失败原因与完整参数）本来就落在
//    `data/runs/<taskId>/<sess>-<turn>.agent-out.jsonl` 里。让 agent 失败时自己记一笔是
//    提示词约定（会忘、会写歪），读自己的日志才是确定的。
// ② **只补「确定没送达」的**（`isUndeliveredMcpFailure`，与 MCP 端重试共用一份口径）。
//    server 收到了并明确拒绝（HTTP 409 之类）绝不重放 —— 那是把 server 拒绝过的动作偷偷
//    做成。
// ③ **只补白名单里的**（`REPLAYABLE_MCP_TOOLS`）。`accept_task` 重放一次就是多合并一次代码。
//
// 补录必须留痕：不写时间线的话，用户看到的就是「我没点它自己就过了」。
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentType } from "@harness/shared";
import { isTaskStage } from "@harness/shared";
import { isReplayableMcpTool, isUndeliveredMcpFailure } from "@harness/shared/mcp-delivery";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { detachedPathsFor } from "./executors/detached.js";
import { RUNS_DIR } from "./paths.js";
import { confirmDone } from "./runs.js";
import { setTaskStage } from "./task-stage.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

/** 从输出流里认出来的一次 harness MCP 调用。 */
export interface McpCallRecord {
  tool: string;
  args: Record<string, unknown>;
  /** 这次调用成了吗 */
  ok: boolean;
  /** 失败原因原文（ok 时为空） */
  error?: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * codex：`codex exec --json` 的 item 事件。
 *
 * 形状实测：
 * `{"type":"item.completed","item":{"type":"mcp_tool_call","server":"harness","tool":"report_stage",
 *   "arguments":{...},"error":{"message":"…Transport closed"},"status":"failed"}}`
 * 同一次调用会先后出现 started/completed 两条（同 id），只认带最终 status 的那条。
 */
function parseCodexCalls(text: string): McpCallRecord[] {
  const out: McpCallRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("mcp_tool_call")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const item = asRecord(asRecord(parsed).item);
    if (item.type !== "mcp_tool_call" || item.server !== "harness") continue;
    if (item.status !== "failed" && item.status !== "completed") continue; // in_progress 那条跳过
    const tool = typeof item.tool === "string" ? item.tool : "";
    if (!tool) continue;
    const error = typeof asRecord(item.error).message === "string"
      ? String(asRecord(item.error).message)
      : item.status === "failed" ? "调用失败（无错误正文）" : "";
    out.push({
      tool,
      args: asRecord(item.arguments),
      ok: item.status === "completed",
      ...(item.status === "failed" ? { error } : {}),
    });
  }
  return out;
}

// claude 的 MCP 工具名形如 `mcp__harness__report_stage`。
const CLAUDE_TOOL = /^mcp__harness__(.+)$/;

/**
 * claude：stream-json。调用与结果分在两条消息里，靠 `tool_use_id` 对上。
 *
 * · 调用：`{"type":"assistant","message":{"content":[{"type":"tool_use","id":…,"name":"mcp__harness__x","input":{…}}]}}`
 * · 结果：`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":…,"is_error":true,"content":"…"}]}}`
 *
 * 只认 `type==="assistant"` 那条完整的调用；`stream_event` 里的 `content_block_start` 也带
 * tool_use，但那是流式增量，`input` 多半还是空的，照它补捞会补出一个没参数的调用。
 */
function parseClaudeCalls(text: string): McpCallRecord[] {
  const pending = new Map<string, { tool: string; args: Record<string, unknown> }>();
  const out: McpCallRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("mcp__harness__") && !line.includes("tool_result")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const root = asRecord(parsed);
    if (root.type !== "assistant" && root.type !== "user") continue;
    const content = asRecord(root.message).content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const block = asRecord(raw);
      if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "";
        const id = typeof block.id === "string" ? block.id : "";
        const matched = name.match(CLAUDE_TOOL);
        if (matched && id) pending.set(id, { tool: matched[1], args: asRecord(block.input) });
      } else if (block.type === "tool_result") {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const call = id ? pending.get(id) : undefined;
        if (!call) continue;
        pending.delete(id);
        const failed = block.is_error === true;
        const body = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        out.push({ ...call, ok: !failed, ...(failed ? { error: body } : {}) });
      }
    }
  }
  // 有调用、没等到结果 —— 通道就是在这一刻断的，进程被杀时连 tool_result 都写不出来。
  // 按「失败且没送达」记，交给下游的口径去判要不要补。
  for (const call of pending.values()) {
    out.push({ ...call, ok: false, error: "调用没有等到结果（transport closed）" });
  }
  return out;
}

/** 读这一轮的输出流，认出其中所有 harness MCP 调用。文件不在（非 detached 的老路径）就返回空。 */
export function collectHarnessMcpCalls(outPath: string, agentType: AgentType): McpCallRecord[] {
  let text: string;
  try { text = readFileSync(outPath, "utf8"); } catch { return []; }
  return agentType === "claude" ? parseClaudeCalls(text) : parseCodexCalls(text);
}

/**
 * 决定这一轮该补哪几笔。纯函数，规则集中在这里（单测 `npm -w server run test:mcp-handoff`）。
 *
 * 依次砍掉：不该补的、补不得的、以及**已经不需要补的**。最后一类是这个函数存在的主要理由 ——
 * agent 失败之后往往自己重试成功了，照着失败记录无脑重放会把它后来的判断覆盖掉。
 */
export function planReplay(calls: McpCallRecord[], taskId: string): McpCallRecord[] {
  const succeeded = new Set(calls.filter((c) => c.ok).map((c) => c.tool));
  const chosen = new Map<string, McpCallRecord>();
  for (const call of calls) {
    if (call.ok) continue;
    if (!isReplayableMcpTool(call.tool)) continue;
    if (!isUndeliveredMcpFailure({ message: call.error })) continue;
    // 同一个工具后来调成了 → 它自己把话说完了，别拿旧的失败记录去盖。
    if (succeeded.has(call.tool)) continue;
    // 只替**本任务**补。agent 也可能在调别的任务（团队调度、批量建任务），那些跨任务的
    // 后果不该由这条补捞路径替它做主。
    const target = call.args.taskId;
    if (typeof target !== "string" || target !== taskId) continue;
    // 同一个工具留最后一次：先报 verify_failed 又改口 verified 时，算数的是后者。
    chosen.set(call.tool, call);
  }
  // agent 最终交卷了，就别再替它按下「暂停」—— 那是它中途想停的念头，后来自己推翻了。
  if (succeeded.has("complete_task") || chosen.has("complete_task")) chosen.delete("pause_task");
  // 先写结论再确认完成，跟 agent 自己的调用顺序一致。
  const order = ["report_stage", "complete_task", "pause_task"];
  return order.filter((tool) => chosen.has(tool)).map((tool) => chosen.get(tool)!);
}

/** 执行一笔补录。返回写进时间线的那句话；参数不合法就返回 null（跳过，不硬塞）。 */
async function applyReplay(taskId: string, call: McpCallRecord): Promise<string | null> {
  if (call.tool === "report_stage") {
    const stage = call.args.stage;
    if (!isTaskStage(stage)) return null;
    await setTaskStage(taskId, stage);
    return `验证结论（${stage}）当时因 MCP 通道中断没能写回，已从本回合的调用记录中补录。`;
  }
  if (call.tool === "complete_task") {
    const at = now();
    await db.update(tasks).set({ completeConfirmedAt: at, updatedAt: at }).where(eq(tasks.id, taskId));
    confirmDone(taskId);
    return "完成确认当时因 MCP 通道中断没能送达，已从本回合的调用记录中补录（否则这一轮会被记成失败）。";
  }
  if (call.tool === "pause_task") {
    const prompt = call.args.resumePrompt;
    if (typeof prompt !== "string" || !prompt.trim()) return null;
    const at = now();
    await db.update(tasks).set({ resumePrompt: prompt.trim(), updatedAt: at }).where(eq(tasks.id, taskId));
    return "检查点暂停当时因 MCP 通道中断没能送达，已补录续跑指令。";
  }
  return null;
}

/**
 * 回合结算前的补捞。**必须排在 `settleTaskStatus` 之前** —— `complete_task` 的补录要赶在
 * 结算读取确认标记之前落库，晚一步，一个干完活的任务就已经被记成 failed 了。
 *
 * 返回补了几笔（0 = 什么都没丢，绝大多数回合都是这个结果）。
 */
export async function replayUndeliveredMcpCalls(a: {
  taskId: string;
  sessId: string;
  turnStart: string;
  agentType: AgentType;
}): Promise<number> {
  const { out } = detachedPathsFor(join(RUNS_DIR, a.taskId), a.sessId, a.turnStart);
  const calls = collectHarnessMcpCalls(out, a.agentType);
  if (!calls.length) return 0;
  const plan = planReplay(calls, a.taskId);
  let done = 0;
  for (const call of plan) {
    const note = await applyReplay(a.taskId, call).catch(() => null);
    if (!note) continue;
    done += 1;
    await appendTaskTimeline(a.taskId, note);
  }
  if (done) bus.publish({ type: "task.review", taskId: a.taskId });
  return done;
}

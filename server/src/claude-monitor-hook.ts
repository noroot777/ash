// Monitor 改道：agent 调 claude 内置 `Monitor` 时拦下来，拿同一份参数起一条 ash 哨兵。
//
// ── 为什么要拦 ───────────────────────────────────────────────────────────────
//
// 内置 Monitor 的进程挂在 agent 自己的进程树里。ash 用 `claude -p` 跑一次性回合，回合
// 一结束 CLI 就把它们成批收走，而它的通知只注回那条随之结束的会话 —— ash 这边够不着任何
// 唤醒通道。实测行序原样抄在 `claude-monitor-reaped.ts` 的文件头。净效果是：agent 说的
// 那句「监听已挂上，套件结束会叫我」在说出口的那一刻就不成立了。
//
// ── 为什么是改道，不是 `--disallowedTools Monitor` ───────────────────────────
//
// 禁掉只能让它**挑不到**，不教它走对的路：工具从清单里消失时，agent 完全可能改成
// `sleep 1800` 同步干等 —— 那比现在更糟（回合卡死或超时，而不是只是没人叫醒）。
//
// 这里把它要的效果**真的给它**：同一份 command/description/timeout 交给 `startMonitor`
// 起一条真哨兵（进程由 ash 起，在 agent 身外，跨回合/会话/重启都活着），再把 monitorId
// 和「这一轮该用 pause_task 收尾」一并回给它。
//
// 回话只能走 `permissionDecision: "deny"` 的 reason：hook 契约里没有「替工具返回结果」
// 这一档（`updatedInput` 只改得了参数，换不了工具）。所以 agent 看到的是一次被拒绝的
// 调用加一段说明，而它要的那个监听确实已经挂上了。
//
// ── 为什么是 http hook 而不是一个脚本文件 ────────────────────────────────────
//
// 判断逻辑留在这个文件里（有类型、被回归测试直接调），而不是散进一个 `.mjs`：那种写法
// 每次 Monitor 调用都要冷启一个 node，还得自己处理 Windows 上的 shell 引号。http 这条
// 只是一次本机 POST。身份走 CLI 的 header 插值（`allowedEnvVars`），token 因此不进 argv，
// 与「密钥绝不进 argv」同一条线。
//
// 插值不生效的老 CLI 上会退化成「拦住了，但没能替你挂」——仍然比放一个注定落空的监听
// 过去诚实，reason 里会让它自己调 `start_monitor`。
//
// ── 什么时候不挂这个 hook ────────────────────────────────────────────────────
//
// 常驻会话（`--input-format stream-json`，团队调度台）不挂：那种模式下 CLI 进程一直
// 活着，会话循环在，内置 Monitor 真能唤醒它自己——那时它不是坏的，拦它才是错的。
import { MONITOR_MAX_TIMEOUT_MS, MONITOR_MIN_TIMEOUT_MS } from "@ash/shared/monitor";
import { currentListeningPort } from "./listening-port.js";
import { startMonitor } from "./monitors.js";

/** 内置 Monitor 的工具名。matcher 只含字母，按精确串匹配（见 hooks 文档的 matcher 语法）。 */
const MONITOR_TOOL = "Monitor";

const HOW_TO_DIY =
  "你可以自己调 `mcp__harness__start_monitor`（同样的 command/description），再用 `pause_task` 收尾这一轮。";

const WHY_NOT_BUILTIN =
  "claude 内置的 Monitor 在 ash 里活不过这一轮（它的进程在你自己的进程树里，回合一结束就被收走，"
  + "通知也只注回这条随之结束的会话），所以这次调用没有执行。";

/** claude 发过来的 PreToolUse 事件里我们用得上的那几个字段。其余原样忽略。 */
export interface ClaudeMonitorHookInput {
  hook_event_name?: string;
  tool_name?: string;
  cwd?: string;
  tool_input?: {
    command?: unknown;
    description?: unknown;
    timeout_ms?: unknown;
    ws?: unknown;
  };
}

/** PreToolUse 的输出形状（hooks 文档）。不表态时返回 null，调用方回一个空对象。 */
export interface ClaudeMonitorHookDecision {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

const deny = (reason: string): ClaudeMonitorHookDecision => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  },
});

/**
 * 代办这件事**自己炸了**时回的那一句。
 *
 * 为什么不能回「没有决定」：空对象在这个接口上的意思是不表态，而不表态 = 放行 —— 于是
 * 一次临时的库错误（SQLITE_BUSY 之类）就让那个注定活不过这一轮的监听挂了上去，agent
 * 照旧说「挂好了，结束会叫我」，这一轮结束后没有任何东西会叫它（第 1 轮审查 F3 实测：
 * 注入一次查库异常，端点回 200 `{}`）。所以已经认出是 Monitor 的调用，只有两个出口：
 * **代办成功并拒掉原工具**，或者**没能代办、明确拒掉并说清怎么补**。
 */
export const monitorHookInternalError = (detail: string): ClaudeMonitorHookDecision =>
  deny(`${WHY_NOT_BUILTIN}本想替你改挂成 ash 哨兵，但 ash 这边处理这次请求时出错了（${detail}）。${HOW_TO_DIY}`);

/** 这次 PreToolUse 事件是不是内置 `Monitor` 的调用。不是的话 ash 一律不表态。 */
export const isMonitorHookCall = (input: ClaudeMonitorHookInput | null | undefined): boolean =>
  input?.tool_name === MONITOR_TOOL;

/**
 * 这次 Monitor 调用该怎么处置。
 *
 * `taskId` 为空 = CLI 没把回合身份插进 header（老版本，或这根本不是 ash 拉起的 claude）。
 * 那时仍然拦，但只能让它自己去挂：**一个都不放行**，因为放过去的监听照样活不过这一轮，
 * 而「拦住 + 说清怎么补」比「放行 + 到点没人叫醒」诚实。
 */
export async function claudeMonitorHookDecision(
  input: ClaudeMonitorHookInput,
  taskId: string | null,
  ownerUserId: string | null,
): Promise<ClaudeMonitorHookDecision | null> {
  // matcher 已经按工具名筛过一道，这里是第二道：配置被改宽了也不会误伤别的工具。
  if (input?.tool_name !== MONITOR_TOOL) return null;

  const toolInput = input.tool_input ?? {};
  const command = typeof toolInput.command === "string" ? toolInput.command.trim() : "";
  const description = typeof toolInput.description === "string" ? toolInput.description.trim() : "";

  // ws 这一种代办不了：ash 的哨兵只认「起一条命令、按行读它的 stdout」。硬要代办就得替
  // 它挑一个 websocat / node 的写法，那是替 agent 做它自己的技术选择。
  if (!command) {
    const ws = toolInput.ws
      ? "ash 的哨兵盯的是命令的 stdout，接不了 WebSocket：把它包成一条命令（websocat，或一小段每收一帧打印一行的 node 脚本）再挂。"
      : "";
    return deny(`${WHY_NOT_BUILTIN}${ws}${HOW_TO_DIY}`);
  }

  if (!taskId) {
    return deny(`${WHY_NOT_BUILTIN}本想替你改挂成 ash 哨兵，但这次请求里没有回合身份，挂不了。${HOW_TO_DIY}`);
  }

  const timeoutMs = typeof toolInput.timeout_ms === "number" && Number.isFinite(toolInput.timeout_ms)
    ? toolInput.timeout_ms
    : undefined;
  // 钳过要说出来：agent 写了 2 小时而 ash 上限 60 分钟时，不说它就会按自己写的那个数去
  // 安排后面的事。判据与 HTTP 端点那条同源（monitor-routes.ts）。
  const clamped = timeoutMs !== undefined
    && (timeoutMs < MONITOR_MIN_TIMEOUT_MS || timeoutMs > MONITOR_MAX_TIMEOUT_MS);

  const result = await startMonitor({
    taskId,
    command,
    description: description || command,
    cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : undefined,
    timeoutMs,
    ownerUserId,
    // 来源:**这个 taskId 是回连凭据核验出来的**(路由那一侧 `agentActor`,拿不到就上面
    // 已经 deny 了),而内置 Monitor 的 hook 一定发生在那条会话自己的回合里 —— 所以这是
    // 「本任务当前这一回合」,角色由 `turnRole` 给(见 monitor-session.ts 文件头)。
    caller: { kind: "turn" },
  });

  if (!result.ok) {
    return deny(`${WHY_NOT_BUILTIN}替你改挂成 ash 哨兵也没成：${result.error}。${HOW_TO_DIY}`);
  }

  return deny(
    `已经替你改挂成 ash 哨兵了（monitorId=${result.monitor.id}），盯的是同一条命令`
    + `${clamped ? "；你写的 timeout 超出 ash 的区间，已经钳到边界" : ""}。`
    + "换一套的原因：claude 内置的 Monitor 进程在你自己的进程树里，这一轮一结束就被收走，"
    + "它的通知也只注回这条随之结束的会话 —— 没有任何东西会把这个任务叫醒。"
    + "ash 哨兵的进程由 ash 自己起，活得过这一回合，每吐一行就把这个任务唤醒一次。"
    + "**所以这一轮请用 `pause_task` 收尾**（resumePrompt 写清被叫醒后该干什么），别干等、也别就这么结束。",
  );
}

/**
 * 拼进 `--settings` 的那一段。`resident` 为真时返回空对象 —— 常驻会话里内置 Monitor
 * 是好用的（见文件头）。
 *
 * 用 `http` 而不是 `command`：见文件头。`headers` 里的 `$VAR` 由 CLI 从进程环境里取，
 * 而 `ASH_TASK_ID` / `ASH_TURN_TOKEN` 正是 ash 起跑时注进去给 MCP 用的那两个
 * （`auth/run-env.ts` 旁边的调用点），所以这里不必自己传一遍。
 *
 * **不设 `onFailure: "block"`**：那是 v2.1.295+ 才有的字段，而 ash 支持的 CLI 版本跨度
 * 比这宽。连不上 ash 时退化成放行（回到这个功能上线前的状态），比让一份带未知字段的
 * settings 被整个拒掉强 —— 后者会连 fastMode、供应商路由一起带走。
 */
/**
 * 这条回调的路径。**一个常量两处用**:这里拼给 CLI 的 URL,以及 index.ts 上那道失败兜底
 * 中间件装在哪 —— 两边漂了的话兜底就悄悄落在一条没人走的路径上(monitor-hook-failsafe.ts)。
 */
export const MONITOR_HOOK_PATH = "/api/hooks/claude-monitor";

export function monitorRedirectHook(resident: boolean): Record<string, unknown> {
  if (resident) return {};
  const port = currentListeningPort() ?? 4317;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: MONITOR_TOOL,
          hooks: [
            {
              type: "http",
              url: `http://127.0.0.1:${port}${MONITOR_HOOK_PATH}`,
              // 本机一跳，起个进程就回。给 15s 是留余量：真超时了 CLI 会丢弃输出、不表态，
              // 那就等于放行 —— 所以这个数宁可宽一点。
              timeout: 15,
              headers: {
                "x-ash-source-task-id": "$ASH_TASK_ID",
                "x-ash-turn-token": "$ASH_TURN_TOKEN",
              },
              allowedEnvVars: ["ASH_TASK_ID", "ASH_TURN_TOKEN"],
            },
          ],
        },
      ],
    },
  };
}

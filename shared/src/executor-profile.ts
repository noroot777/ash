import type { AgentType } from "./index.ts";

// Execution layer: a concrete executor under a type (CLI + model)。
// 执行位置永远是 ash 所在的这台机器;要换机器请用「接力」把整个任务交出去。
export interface AgentExecutorProfile {
  id: string;
  name: string; // human label, e.g. "claude@local·opus"
  type: AgentType;
  model?: string;
  extraArgs?: string[];
  // 推理强度。缺省 = 跟随 CLI 默认;claude: --effort <v>;codex: -c model_reasoning_effort="<v>"。
  // 取值集按 CLI 而异(claude 无 ultra;模型不支持的档位会被 API 拒绝,如 gpt-5.5 最高 xhigh)。
  reasoningEffort?: string;
  // 速度档。缺省/"standard" = 标准（不额外传参，跟随 CLI 自己的默认）；
  // "fast" = 1.5x 加速档（codex: -c service_tier="priority"）。
  speed?: "standard" | "fast";
  // 挂载的供应商(LlmProvider.id)。缺省/null = 用 CLI 自己的官方登录账号。
  // 非空时启动 CLI 前注入供应商的 base_url + key(见 executors/index.ts)。
  providerId?: string | null;
  // 覆盖 CLI 自己配置文件里的设置(以环境变量注入,只对 ash 起的进程生效)。
  // 可覆盖哪些项、各自盖掉谁,声明在 @ash/shared/cli-overrides。
  configOverrides?: Record<string, number>;
  isDefault: boolean; // the default executor resolved for its type
  // 多人模式下这个执行器为什么派不出任务(自用模式恒 undefined)。宿主机的 CLI 订阅
  // 被隔离后,没接 relay 的 CLI 与没挂供应商的执行器都跑不起来 —— 服务端现算,
  // 前端据此标灰并给出下一步(见 auth/dispatch-gate.ts)。
  dispatchBlocked?: string | null;
  // 这个执行器起跑时读的那份配置里 ash MCP 接没接上。列表和每次写入的返回体都现读一次,
  // 注册那一下没补成时 detail 用补接自己的说法(server/src/auth/executor-ash-mcp.ts)。
  ashMcp?: ExecutorAshMcp;
}

/**
 * 三态,不是「有问题 / 没问题」两态:读不准(配置写坏了、格式 ash 读不了、带了配置文件里
 * 看不见的覆盖参数)既不能说成「缺登记」,也不能当成「接上了」把原因藏起来。
 * connected 时 detail 为 null;另两态 detail 是给用户看的那句话。
 */
export interface ExecutorAshMcp {
  state: "connected" | "missing" | "unknown";
  detail: string | null;
}

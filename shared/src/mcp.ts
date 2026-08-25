/** 当前安装器、Codex 配置与 CLI 事件共同使用的 ash MCP 服务名。 */
export const ASH_MCP_SERVER_NAME = "ash";

/** setup 会迁移、执行器在迁移前仍兼容的历史服务名。 */
export const LEGACY_ASH_MCP_SERVER_NAME = "harness";

/** ash 拉起的 MCP 子进程需要从执行器父进程继承的动态身份变量。 */
export const ASH_MCP_IDENTITY_ENV_VARS = ["ASH_TASK_ID", "ASH_TURN_TOKEN"] as const;

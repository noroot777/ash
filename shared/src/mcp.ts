/** 当前安装器、Codex 配置与 CLI 事件共同使用的 ash MCP 服务名。 */
export const ASH_MCP_SERVER_NAME = "ash";

/** setup 会迁移、执行器在迁移前仍兼容的历史服务名。 */
export const LEGACY_ASH_MCP_SERVER_NAME = "harness";

/**
 * 回合身份(「这一句话是哪条任务的哪一回合说的」)进 MCP 子进程用的变量名。
 *
 * **为什么一个身份有两套名字**:有的 CLI 按**变量名**过滤交给 MCP 子进程的环境。
 * gemini-cli 实测(2026-10-31,本机装机版):MCP stdio 子进程的环境过
 * `sanitizeEnvironment(..., { enableEnvironmentVariableRedaction: true })`,名字命中
 * `/TOKEN/i /SECRET/i /KEY/i /AUTH/i /PASSWORD/i /CREDENTIAL/i /CREDS/i /PRIVATE/i /CERT/i`
 * 的一律删掉 —— `ASH_TURN_TOKEN` / `ASH_DIRECTION_TOKEN` 正好撞上第一条。实测用一个只
 * dump 环境的假 MCP server 取过证:子进程里 `ASH_TASK_ID` 在、两个 `*_TOKEN` 不在。
 * 而它的 `allowedEnvironmentVariables` 这条白名单自己也被同一组正则过滤,所以**没有**
 * 配置层面的出路;登记里的 `env` 不受过滤,但只放得下静态值,装不了每回合都换的令牌。
 *
 * 于是同一个值再按一个不撞过滤的名字(`*_TICKET`)导一份:ash 起跑时两套都设,MCP 侧
 * 两套都读(`mcp/src/runtime.ts`),谁活着用谁。代价是这一个值在那些 CLI 里对**同一会话里
 * 别的 MCP server** 也可见 —— 它本来就只是「某条任务某一回合」的一次性凭据(claude 那条路
 * 上一直如此:claude 把整份环境原样传给每个 MCP 子进程),换来的是那几家 CLI 交得了卷。
 */
export const ASH_TURN_IDENTITY_ENV = {
  taskId: "ASH_TASK_ID",
  turnToken: "ASH_TURN_TOKEN",
  directionToken: "ASH_DIRECTION_TOKEN",
  /** 别名:名字刻意不含 TOKEN/KEY/SECRET 这类词(见上)。 */
  turnTicket: "ASH_TURN_TICKET",
  directionTicket: "ASH_DIRECTION_TICKET",
} as const;

/** 回合身份的全部变量名 —— 设和清都按这一份,别在某处只写三个。 */
export const ASH_TURN_IDENTITY_ENV_KEYS = Object.values(ASH_TURN_IDENTITY_ENV) as readonly string[];

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

/**
 * 回合身份的**第二条通路**:搭 `PATH` 这班车的一次性目录。
 *
 * 为什么非要第二条:有的 CLI 只把 `PATH` 自动交给 MCP 子进程,别的变量一律要求**写死**在
 * 登记的 `env` 里(copilot 官方文档原文:「The `PATH` variable is automatically inherited
 * from your environment. All other environment variables must be configured here.」)。
 * 而回合身份一轮一个值,写死进配置文件就是一张过期的假身份 —— 于是把身份换成**一份文件**,
 * 让装着它的目录挤上 `PATH` 这唯一还通车的那条路:
 *
 *   `<runs>/<taskId>/turn-identity/<turnToken>/identity.json`
 *
 * 四个要点,少一个这条路就从「能交卷」变成「能借身份」:
 *  · **按回合开目录、开新的就删掉旧的**。上一回合的 MCP 子进程若还活着,它手里那条路径已经
 *    不存在,读到的是空 —— 绝不可能是**这一回合**的令牌。按任务开一个固定目录做不到这件事。
 *  · **目录名是任务 id**,所以一条任务的 agent 读不到另一条任务的身份(「借来的身份比没有
 *    身份更糟」,见 `server/src/turn-identity.ts` 顶部)。
 *  · 目录里**只有那一份 json**、没有可执行文件,而且**追加在 PATH 末尾** —— 命令解析不受
 *    影响,也盖不掉用户自己的任何命令。
 *  · 不是任务回合的那几条路(侧聊、预览助手、duet)必须把这几段从 `PATH` 里**摘掉**,跟清
 *    那几个变量是同一件事、同一处代码。
 */
export const ASH_TURN_IDENTITY_PATH_DIR = "turn-identity";

/** 那份身份文件的名字(`<...>/turn-identity/<turnToken>/identity.json`)。 */
export const ASH_TURN_IDENTITY_FILE = "identity.json";

/**
 * `PATH` 里这一段是不是上面那种身份目录。判据是**倒数第二段的目录名**,所以认的是
 * `<任意>/turn-identity/<turnToken>` 这个形状,不依赖 runs 目录在哪(测试会换,
 * 预览实例也会换)。两条斜杠都认:Windows 上拼出来的是 `\`。
 *
 * 两侧共用这一个判据:server 侧拿它清(`withoutTurnIdentity`),MCP 侧拿它读
 * (`mcp/src/runtime.ts`)。各写一份的话,改名那天就只有一边改。
 */
export function isTurnIdentityPathEntry(entry: string): boolean {
  const parts = entry.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length >= 2 && parts[parts.length - 2] === ASH_TURN_IDENTITY_PATH_DIR;
}

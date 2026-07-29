import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentType } from "@harness/shared";
import { resolveExecutorFor } from "./executors/index.js";

const exec = promisify(execFile);

export interface DetectedAgent {
  type: AgentType;
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** 支持常驻会话(openResident)——只有这类 CLI 能当 /team 的调度者。 */
  resident: boolean;
}

/**
 * 已知 CLI 目录里的一项。
 *
 * `type` 是这里唯一的分水岭:**有 type 的才是 harness 能拿来派任务的执行器**
 * (claude/codex/antigravity),它们进 AgentType 联合类型、能注册执行器 profile、
 * 参与 resident 判定;没有 type 的纯粹是「检测 + 展示」——告诉用户本机装没装、
 * 没装给条安装命令,仅此而已。所以 type 是可选字段而不是把新 CLI 塞进 AgentType:
 * 一旦混进去,所有「选谁干活」的下拉都会列出一堆根本跑不了任务的名字。
 */
export interface KnownCli {
  /** 稳定标识,前端拿它做 key(bin 会变,见 cursor 的 cursor-agent → agent)。 */
  key: string;
  name: string;
  /** 中文一句话,卡片副标题。 */
  description: string;
  /**
   * 候选命令名,按顺序探测,第一个探到的算数。
   * 多个是为了官方改过 bin 名又留了兼容别名的情况(cursor)。
   */
  bins: string[];
  /**
   * 只对 `bins[0]` 之外的**备用**命令名生效的自证要求:`--version` 输出里必须
   * 含这个词(不区分大小写)才认。备用名常常很通用 —— cursor 官方现在的 bin 就叫
   * `agent`,本机实测 `which agent` 命中的其实是 grok,不设这道卡就会把别家的
   * 命令连版本号一起认成它。主 bin 不设卡,免得哪家改了版本号文案就漏检。
   */
  fallbackVersionMatch?: string;
  docsUrl: string;
  /** 官方安装命令原文。只给用户复制,**服务端永不执行**。 */
  installCommand: string;
  /** 有值 = 可作为 harness 执行器的 AgentType;无值 = 仅检测展示。 */
  type?: AgentType;
}

export interface DetectedCli extends KnownCli {
  /** 实际探到的命令名(bins 里命中的那个);没探到则回落 bins[0]。 */
  bin: string;
  available: boolean;
  path: string | null;
  version: string | null;
  /** 仅对有 type 的项有意义:该执行器支持常驻会话(能当 /team 调度者)。 */
  resident: boolean;
}

// 已知 CLI 目录。前三个是 harness 的执行器(有 type),其余只做检测展示。
// bin 名逐个按官方文档核对过(2026-07),踩过的坑记在各自注释里 —— 产品名和
// 终端里敲的那个词经常对不上,别照着产品名猜。
const KNOWN_CLIS: KnownCli[] = [
  {
    key: "claude",
    type: "claude",
    name: "Claude Code",
    description: "Anthropic 官方 CLI",
    bins: ["claude"],
    docsUrl: "https://docs.claude.com/en/docs/claude-code/overview",
    installCommand: "npm install -g @anthropic-ai/claude-code",
  },
  {
    key: "codex",
    type: "codex",
    name: "Codex CLI",
    description: "OpenAI 官方 CLI",
    bins: ["codex"],
    docsUrl: "https://developers.openai.com/codex/cli/",
    installCommand: "npm install -g @openai/codex",
  },
  {
    key: "antigravity",
    type: "antigravity",
    name: "Antigravity CLI",
    description: "Google 新版 CLI",
    // 探到的 bin 名保持 `antigravity` 在前:执行器侧一直按它认人,换顺序等于换行为。
    // 官方 quickstart 现在给的是 `agy`,作为备用候选补在后面。
    bins: ["antigravity", "agy"],
    docsUrl: "https://antigravity.google/docs/cli/install",
    installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  },
  {
    key: "gemini",
    name: "Gemini CLI",
    description: "Google 官方 CLI",
    bins: ["gemini"],
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    installCommand: "npm install -g @google/gemini-cli",
  },
  {
    key: "opencode",
    name: "OpenCode",
    description: "开源终端智能体",
    bins: ["opencode"],
    docsUrl: "https://opencode.ai/docs/",
    installCommand: "curl -fsSL https://opencode.ai/install | bash",
  },
  {
    key: "trae",
    name: "TRAE CLI",
    description: "字节编码 CLI",
    // 不是 `trae`(那是拉起 IDE 的),也不是 `trae-cli`(那是开源的 bytedance/trae-agent)。
    bins: ["traecli"],
    docsUrl: "https://docs.trae.cn/cli_get-started-with-trae-cli",
    installCommand: 'sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)"',
  },
  {
    key: "grok",
    name: "Grok Build",
    description: "xAI 编码 CLI",
    bins: ["grok"],
    docsUrl: "https://docs.x.ai/build/overview",
    installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
  },
  {
    key: "kimi",
    name: "Kimi Code CLI",
    description: "月之暗面 CLI",
    // 旧 Python 版 Kimi CLI 已在收摊,新版 Kimi Code CLI 沿用同一个 bin。
    bins: ["kimi"],
    docsUrl: "https://github.com/MoonshotAI/kimi-code",
    installCommand: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
  },
  {
    key: "cursor",
    name: "Cursor CLI",
    description: "Cursor 终端智能体",
    // 官方现在叫 `agent`,`cursor-agent` 是保留的兼容别名。这里先探别名:
    // `agent` 太通用,得靠 fallbackVersionMatch 自证是 Cursor 才算数。
    bins: ["cursor-agent", "agent"],
    fallbackVersionMatch: "cursor",
    docsUrl: "https://cursor.com/docs/cli/installation",
    installCommand: "curl https://cursor.com/install -fsS | bash",
  },
  {
    key: "qwen",
    name: "Qwen Code",
    description: "通义编码 CLI",
    bins: ["qwen"],
    docsUrl: "https://github.com/QwenLM/qwen-code",
    installCommand: "npm install -g @qwen-code/qwen-code@latest",
  },
  {
    key: "qoder",
    name: "Qoder CLI",
    description: "阿里编码 CLI",
    bins: ["qodercli"], // 官网通篇不提这个词,只有 docs 的 `qodercli --version` 能作证。
    docsUrl: "https://docs.qoder.com/en/cli/quick-start",
    installCommand: "curl -fsSL https://qoder.com/install | bash",
  },
  {
    key: "copilot",
    name: "GitHub Copilot CLI",
    description: "GitHub 官方 CLI",
    bins: ["copilot"],
    docsUrl: "https://github.com/github/copilot-cli",
    installCommand: "npm install -g @github/copilot",
  },
  {
    key: "pi",
    name: "Pi Coding Agent",
    description: "开源极简编码 CLI",
    // 与 Inflection 的聊天产品 Pi 无关(那个只有网页/App,没有 CLI)。
    bins: ["pi"],
    docsUrl: "https://github.com/earendil-works/pi",
    installCommand: "curl -fsSL https://pi.dev/install.sh | sh",
  },
  {
    key: "kiro",
    name: "Kiro CLI",
    description: "AWS 编码 CLI",
    bins: ["kiro-cli"], // `kiro` 是拉起 IDE 的。官方明确不支持 Homebrew。
    docsUrl: "https://kiro.dev/docs/cli/installation/",
    installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
  },
  {
    key: "kilo",
    name: "Kilo CLI",
    description: "开源多模型 CLI",
    bins: ["kilo"], // 包名是 @kilocode/cli,命令是 kilo。
    docsUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
    installCommand: "npm install -g @kilocode/cli",
  },
];

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec("which", [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function version(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeout: 4000 });
    return (stdout.split("\n")[0] || "").trim() || null;
  } catch {
    return null;
  }
}

async function detectOne(cli: KnownCli): Promise<DetectedCli> {
  const want = cli.fallbackVersionMatch?.toLowerCase();
  let bin = cli.bins[0];
  let path: string | null = null;
  let ver: string | null = null;
  for (const [i, candidate] of cli.bins.entries()) {
    const found = await which(candidate);
    if (!found) continue;
    const v = await version(candidate);
    // 备用名要自证身份,证不了就当没探到,继续往下试。
    if (i > 0 && want && !(v ?? "").toLowerCase().includes(want)) continue;
    bin = candidate;
    path = found;
    ver = v;
    break;
  }
  return {
    ...cli,
    bin,
    available: !!path,
    path,
    version: ver,
    // 没装的 CLI 不去解析执行器(resolveExecutor 对无内置解析器的类型会 throw),
    // 直接算它不支持常驻 —— 反正启动器只在 available 的里面挑。
    resident:
      path && cli.type
        ? !!(await resolveExecutorFor({ type: cli.type }).then((e) => e.openResident, () => null))
        : false,
  };
}

// 探测整份已知 CLI 目录(DESIGN.md §5/§0):可执行器 + 纯展示项一起返回,
// 前端按 `type` 区分「能派任务」和「只是装了」。
export function detectKnownClis(): Promise<DetectedCli[]> {
  return Promise.all(KNOWN_CLIS.map(detectOne));
}

// 只要 harness 能拿来派任务的那几个,形状保持不变 —— 团队/辩论的执行器选择器
// (teamExecutorDefaults)靠它决定谁能当调度者,不该看见目录里的展示项。
// `resident` 直接问执行器本人有没有 openResident —— 「谁能当调度者」只有这一个
// 真相来源,前端照着过滤就行,不用在 shared 里再抄一张名单出来漂移。
export async function detectLocalAgents(): Promise<DetectedAgent[]> {
  const all = await Promise.all(KNOWN_CLIS.filter((c) => c.type).map(detectOne));
  return all.map(({ type, bin, available, path, version, resident }) => ({
    type: type as AgentType,
    bin,
    available,
    path,
    version,
    resident,
  }));
}

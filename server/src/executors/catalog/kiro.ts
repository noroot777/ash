import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const kiroSpec: CliSpec = {
  key: "kiro",
  name: "Kiro CLI",
  description: "Kiro 智能编码 CLI（Amazon Q Developer CLI 后继）",
  bins: ["kiro-cli"], // `kiro` 是拉起 IDE 的。官方明确不支持 Homebrew。
  docsUrl: "https://kiro.dev/docs/cli/installation/",
  installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
  // install.ps1 的文件头自己写着 `# Usage: irm https://cli.kiro.dev/install.ps1 | iex`
  // (2026-08-14 拉取确认)。
  installCommandWindows: "irm https://cli.kiro.dev/install.ps1 | iex",
  // 官方安装页的 Windows 段只列 Windows 11;脚本里的包名写死
  // `kiro-cli-x86_64-pc-windows-msvc.msi`,所以 ARM 机器上跑的是模拟的 x64。
  windowsNote: "官方只列 Windows 11;安装包仅 x64(ARM 机器走模拟)。",
  untested: true,
  notes:
    "2026-07-30 核对 Kiro 官方 headless/CLI commands/models/effort/session/auth 文档（当前 changelog 2.15.0）及 Amazon Q Developer CLI 前身公开源码与迁移说明:" +
    "`chat --no-interactive` 接位置参数 prompt,无人值守必须配 `--trust-all-tools`;官方未提供 chat 结构化输出格式或事件 schema,故保留 textParser。" +
    "`--effort` 支持 low/medium/high/xhigh/max;前身源码有 `--model`,且 Kiro 官方承诺 Q CLI 功能向后兼容,因此暂按 `--model <id>` 接线。" +
    "CLI 有 `--resume-id <UUID>` 无头恢复通道,但首轮 UUID 由 CLI 产生,官方纯文本输出未说明会回报该 id,harness 无法可信捕获,故不声明 session。" +
    "`KIRO_API_KEY` 仅是 Kiro 自有订阅的无头认证,未发现第三方 base URL/key 通道,故不写 relay。" +
    "仍未确认:本机未安装,未实测 2.15.0 的 `--model`（最新 Kiro command reference 未列此 flag）、stdout/stderr 噪声与账号/区域下 `--list-models --format json` 的实际 id 全集。",
  exec: {
    subcommand: ["chat"],
    baseArgs: ["--no-interactive", "--trust-all-tools"],
    prompt: { via: "arg" },
    model: { flag: "--model" },
    reasoningEffort: { flag: "--effort" },
  },
};

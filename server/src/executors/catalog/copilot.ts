import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const copilotSpec: CliSpec = {
  key: "copilot",
  name: "GitHub Copilot CLI",
  description: "GitHub 官方 CLI",
  bins: ["copilot"],
  docsUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference",
  installCommand: "npm install -g @github/copilot",
  untested: true,
  notes:
    "2026-07-30 核对官方 docs.github.com command/programmatic reference 与 github/copilot-cli README/changelog:" +
    "-p/--prompt 是非交互一次性执行,-s + --stream=off 输出纯文本响应;--output-format=json 只是官方 JSONL,未找到事件 schema,不套 claudeStreamJsonParser;" +
    "--allow-all 等价于 tools/paths/urls 全放行,配 --no-ask-user 避免无人值守任务卡在许可或澄清;组织/MDM 可禁用 allow-all;" +
    "--session-id 可用 ash 生成的 UUID 新建会话,--resume=<id> 可无头续跑;--continue 只续最近会话,不适合精确绑定;" +
    "--model 支持 auto 与官方列出的混合模型;--effort/--reasoning-effort 支持 low/medium/high/xhigh/max。" +
    "仍未确认:本机未安装,未实测 JSONL schema、stdout/stderr 噪声、账号/计划/策略下的实际模型全集与 allow-all 可用性;未写 relay,官方只确认 COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN 登录,不是第三方 OpenAI/Anthropic base URL 通道。",
  exec: {
    baseArgs: ["-s", "--stream=off", "--output-format=text", "--no-color", "--no-ask-user", "--allow-all"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model", style: "equals" },
    reasoningEffort: { flag: "--effort", style: "equals" },
    session: {
      newIdFlag: "--session-id",
      resumeArgs: (id) => [`--resume=${id}`],
      interactive: (id) => `copilot --resume=${id}`,
    },
  },
};

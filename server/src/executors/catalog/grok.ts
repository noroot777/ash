import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。
export const grokSpec: CliSpec = {
  key: "grok",
  name: "Grok Build",
  description: "xAI 编码 CLI",
  bins: ["grok"],
  docsUrl: "https://docs.x.ai/build/overview",
  installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
  untested: true,
  notes:
    "实测于 2026-07-30,版本 grok 0.2.111 (94172f2aa4e5)。" +
    "本机未登录且无 XAI_API_KEY;-p、--always-approve、--permission-mode bypassPermissions " +
    "与输出格式参数会进入无头路径并快速报 Not signed in,因此未能完成 hello.txt 写入、" +
    "成功态 stdout schema 或 session resume 记忆验证,继续保留 untested。" +
    "grok models 未登录仅列出 grok-4.5;成功态结构化输出未确认,暂用 plain/textParser。" +
    "未接 relay:根命令 grok -p 不接受 --xai-api-base-url,仅支持 XAI_API_KEY 认证提示;" +
    "agent 子命令虽有 base-url/stdio/headless,但不是单回合 prompt 通道。",
  exec: {
    baseArgs: [
      "--always-approve",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "plain",
    ],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    reasoningEffort: { flag: "--reasoning-effort" },
  },
};

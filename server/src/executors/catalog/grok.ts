import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const grokSpec: CliSpec = {
  key: "grok",
  name: "Grok Build",
  description: "xAI 编码 CLI",
  bins: ["grok"],
  docsUrl: "https://docs.x.ai/build/overview",
  installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
  untested: true,
  notes:
    "按 docs.x.ai 的非交互用法起草:`grok -p \"<prompt>\"`,模型走 --model。" +
    "B 阶段要核实的:①-p 是否就是一次性执行(有些版本 -p 只是 print);" +
    "②自动批准文件写入/命令执行的开关名;③有无 json 输出;④会话延续 flag。" +
    "注意本机 `which agent` 曾命中 grok(见 cursor spec 的 fallbackVersionMatch 注释)。",
  exec: {
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
  },
};

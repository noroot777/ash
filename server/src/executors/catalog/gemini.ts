import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const geminiSpec: CliSpec = {
  key: "gemini",
  name: "Gemini CLI",
  description: "Google 官方 CLI",
  bins: ["gemini"],
  docsUrl: "https://github.com/google-gemini/gemini-cli",
  installCommand: "npm install -g @google/gemini-cli",
  untested: true,
  notes:
    "按官方 README 的非交互用法起草:`gemini -p \"<prompt>\" -m <model> --yolo`" +
    "(-p/--prompt 一次性执行,--yolo 自动批准所有工具调用)。" +
    "B 阶段要核实的:①--yolo 在当前版本是否仍是自动批准的正确开关;" +
    "②有无结构化输出(README 提过 --output-format json,能用就换掉 textParser 以拿到工具调用);" +
    "③会话延续机制(gemini 有 /chat save|resume 的会话概念,但未必有无头 flag)。",
  exec: {
    baseArgs: ["--yolo"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "-m" },
  },
};

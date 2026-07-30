import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const copilotSpec: CliSpec = {
  key: "copilot",
  name: "GitHub Copilot CLI",
  description: "GitHub 官方 CLI",
  bins: ["copilot"],
  docsUrl: "https://github.com/github/copilot-cli",
  installCommand: "npm install -g @github/copilot",
  untested: true,
  notes:
    "按官方 README 的非交互用法起草:`copilot -p \"<prompt>\" --allow-all-tools`" +
    "(-p/--prompt 一次性执行,--allow-all-tools 免逐条确认)。" +
    "B 阶段要核实的:①--allow-all-tools 是否仍存在(它是 README 明确标注「谨慎使用」的开关);" +
    "②--model 的取值(claude-sonnet-4.5 / gpt-5 之类,别照抄别家别名);" +
    "③--log-level / --log-dir 会不会把噪声打到 stdout 污染正文;④会话 --resume。",
  exec: {
    baseArgs: ["--allow-all-tools"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
  },
};

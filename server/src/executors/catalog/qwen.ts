import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const qwenSpec: CliSpec = {
  key: "qwen",
  name: "Qwen Code",
  description: "通义编码 CLI",
  bins: ["qwen"],
  docsUrl: "https://github.com/QwenLM/qwen-code",
  installCommand: "npm install -g @qwen-code/qwen-code@latest",
  untested: true,
  notes:
    "Qwen Code 是 gemini-cli 的 fork,所以按 gemini 同款起草:`qwen -p \"<prompt>\" -m <model> --yolo`。" +
    "B 阶段要核实的:①fork 有没有改掉 --yolo / -p;②有无 --output-format json;" +
    "③model 取值(它默认走 DashScope 的 qwen3-coder-plus 等,别照抄 gemini 的模型名)。",
  exec: {
    baseArgs: ["--yolo"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "-m" },
  },
};

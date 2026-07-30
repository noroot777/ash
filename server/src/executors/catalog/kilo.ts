import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const kiloSpec: CliSpec = {
  key: "kilo",
  name: "Kilo CLI",
  description: "开源多模型 CLI",
  bins: ["kilo"], // 包名是 @kilocode/cli,命令是 kilo。
  docsUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
  installCommand: "npm install -g @kilocode/cli",
  untested: true,
  notes:
    "非交互调用方式未见明文,按「位置参数传任务 + 免确认」起草(`kilo \"<prompt>\" --yes`)。" +
    "B 阶段先跑 `kilo --help`:①一次性执行到底是位置参数还是 -p;②免确认开关名" +
    "(--yes / --auto-approve / --yolo 都有可能);③模型参数(它是多模型 CLI," +
    "很可能要 provider/model 形式);④有无 json 输出。",
  exec: {
    baseArgs: ["--yes"],
    prompt: { via: "arg" },
    model: { flag: "--model" },
  },
};

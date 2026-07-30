import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const kimiSpec: CliSpec = {
  key: "kimi",
  name: "Kimi Code CLI",
  description: "月之暗面 CLI",
  // 旧 Python 版 Kimi CLI 已在收摊,新版 Kimi Code CLI 沿用同一个 bin。
  bins: ["kimi"],
  docsUrl: "https://github.com/MoonshotAI/kimi-code",
  installCommand: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
  untested: true,
  notes:
    "Kimi Code 的形态贴近 claude Code,按同款写法起草(`-p` 一次性执行 + 免确认开关)。" +
    "B 阶段要核实的:①非交互 flag;②自动批准工具的 flag 名(这里暂按 --yolo 起草,很可能不对);" +
    "③若它确实照搬了 claude 的 `--output-format stream-json`,把 parser 换成 " +
    "claudeStreamJsonParser 就能直接白嫖工具调用与流式文本;④会话 resume flag。",
  exec: {
    baseArgs: ["--yolo"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
  },
};

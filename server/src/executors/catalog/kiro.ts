import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const kiroSpec: CliSpec = {
  key: "kiro",
  name: "Kiro CLI",
  description: "AWS 编码 CLI",
  bins: ["kiro-cli"], // `kiro` 是拉起 IDE 的。官方明确不支持 Homebrew。
  docsUrl: "https://kiro.dev/docs/cli/installation/",
  installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
  untested: true,
  notes:
    "kiro-cli 出自 Amazon Q Developer CLI 一脉,按它那套起草:" +
    "`kiro-cli chat --no-interactive --trust-all-tools \"<prompt>\"`。" +
    "B 阶段要核实的:①chat 子命令与 --no-interactive 是否还在;②--trust-all-tools 的名字;" +
    "③有无 --output-format;④`kiro-cli chat --resume` 一类的会话延续。",
  exec: {
    subcommand: ["chat"],
    baseArgs: ["--no-interactive", "--trust-all-tools"],
    prompt: { via: "arg" },
    model: { flag: "--model" },
  },
};

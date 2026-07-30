import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const qoderSpec: CliSpec = {
  key: "qoder",
  name: "Qoder CLI",
  description: "阿里编码 CLI",
  bins: ["qodercli"], // 官网通篇不提这个词,只有 docs 的 `qodercli --version` 能作证。
  docsUrl: "https://docs.qoder.com/en/cli/quick-start",
  installCommand: "curl -fsSL https://qoder.com/install | bash",
  untested: true,
  notes:
    "连 bin 名都只有 docs 的 `qodercli --version` 一处作证,非交互调用方式更无明文," +
    "这里按 claude Code 系通行写法起草(`-p` + 免确认)。B 阶段先跑 `qodercli --help`," +
    "把真实开关抄下来;确认不支持非交互就如实写进 notes 并告知调度者。",
  exec: {
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
  },
};

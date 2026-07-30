import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const traeSpec: CliSpec = {
  key: "trae",
  name: "TRAE CLI",
  description: "字节编码 CLI",
  // 不是 `trae`(那是拉起 IDE 的),也不是 `trae-cli`(那是开源的 bytedance/trae-agent)。
  bins: ["traecli"],
  docsUrl: "https://docs.trae.cn/cli_get-started-with-trae-cli",
  // 照录官方快速开始的整条命令:安装脚本跑在 `sh -c` 子进程里,它写进 shell
  // profile 的 PATH 传不回用户当前 shell,少了后半段就得重开终端才敲得动 traecli。
  installCommand: 'sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)" && export PATH=~/.local/bin:$PATH',
  untested: true,
  notes:
    "官方快速开始通篇只演示交互模式,非交互调用方式未见明文,这里按 claude Code 系" +
    "通行写法起草(`-p` 传 prompt)。B 阶段必须先跑 `traecli --help` 把真实开关抄下来:" +
    "①一次性执行的 flag;②自动批准工具的 flag;③模型参数名;④有无结构化输出。" +
    "如果 --help 显示它压根不支持非交互,如实把 notes 改成「不可作为执行器」并告知调度者。",
  exec: {
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
  },
};

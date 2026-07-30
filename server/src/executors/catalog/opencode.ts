import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const opencodeSpec: CliSpec = {
  key: "opencode",
  name: "OpenCode",
  description: "开源终端智能体",
  bins: ["opencode"],
  docsUrl: "https://opencode.ai/docs/",
  installCommand: "curl -fsSL https://opencode.ai/install | bash",
  untested: true,
  notes:
    "按官方 docs 的非交互用法起草:`opencode run \"<prompt>\" -m <provider/model>`" +
    "(run 子命令一次性执行并把结果打到 stdout;模型是 `provider/model` 形式," +
    "所以 profile 里的 model 要写全,如 anthropic/claude-sonnet-4-5)。" +
    "B 阶段要核实的:①run 是否需要额外开关才不弹权限确认;②有无 --print-logs / json 输出;" +
    "③会话延续(docs 提到 `--session` / `--continue`,能用就补 session.resumeArgs)。",
  exec: {
    subcommand: ["run"],
    prompt: { via: "arg" },
    model: { flag: "-m" },
  },
};

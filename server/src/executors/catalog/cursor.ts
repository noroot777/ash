import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const cursorSpec: CliSpec = {
  key: "cursor",
  name: "Cursor CLI",
  description: "Cursor 终端智能体",
  // 官方现在叫 `agent`,`cursor-agent` 是保留的兼容别名。这里先探别名:
  // `agent` 太通用,得靠 fallbackVersionMatch 自证是 Cursor 才算数。
  bins: ["cursor-agent", "agent"],
  fallbackVersionMatch: "cursor",
  docsUrl: "https://cursor.com/docs/cli/installation",
  installCommand: "curl https://cursor.com/install -fsS | bash",
  untested: true,
  notes:
    "按官方 CLI 文档起草:`cursor-agent -p --output-format text --force \"<prompt>\"`" +
    "(-p/--print 非交互打印,--force 免确认,prompt 是位置参数)。" +
    "B 阶段要核实的:①--force 是否仍是跳过确认的开关;②--output-format 支持的取值" +
    "(文档提过 text/json/stream-json;若 stream-json 与 claude 同 schema 就换 claudeStreamJsonParser);" +
    "③`--resume <chatId>` 的实际 flag 名与 chatId 从哪拿(拿得到就补 session)。",
  exec: {
    baseArgs: ["-p", "--output-format", "text", "--force"],
    prompt: { via: "arg" },
    model: { flag: "--model" },
  },
};

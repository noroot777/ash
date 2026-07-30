import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方文档写、**本机未实测**。
export const antigravitySpec: CliSpec = {
  key: "antigravity",
  name: "Antigravity CLI",
  description: "Google 新版 CLI",
  // 探到的 bin 名保持 `antigravity` 在前:执行器侧一直按它认人,换顺序等于换行为。
  // 官方 quickstart 现在给的是 `agy`,作为备用候选补在后面。
  bins: ["antigravity", "agy"],
  docsUrl: "https://antigravity.google/docs/cli/install",
  installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  untested: true,
  notes:
    "非交互 flag 未实测:这里按「-p 传 prompt + --yolo 免确认」的通行写法起草。" +
    "B 阶段要核实的:①非交互开关到底是 -p 还是别的;②自动批准工具的 flag 名;" +
    "③有没有 --output-format json 之类的结构化输出(有就换掉 textParser);" +
    "④`agy` 与 `antigravity` 是同一个二进制还是行为有别;" +
    "⑤**会话恢复**:`antigravity --resume <id>` 这条交互式写法是有的,但 harness 拿不到" +
    "它认得的 id(既没有 --session-id 那样的「我来发 id」通道,也还没有能回报 id 的 parser)," +
    "所以整个 session 字段先不声明 —— 只写 interactive 会拼出一条引用不存在会话的命令。" +
    "核实出 id 通道后按 README 的 (b)/(c) 档补齐即可。",
  exec: {
    baseArgs: ["--yolo"],
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
  },
};

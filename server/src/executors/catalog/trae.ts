import type { CliSpec } from "./types.js";

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分依据官方中文文档
// docs.trae.cn 的 TRAE CLI 章节(2026-07-30 核对),**本机未安装、一次都没实跑**。
export const traeSpec: CliSpec = {
  key: "trae",
  name: "TRAE CLI",
  description: "字节编码 CLI(仅企业版旗舰套餐)",
  // 不是 `trae`(那是拉起 IDE 的),也不是 `trae-cli`(那是开源的 bytedance/trae-agent)。
  bins: ["traecli"],
  docsUrl: "https://docs.trae.cn/cli_get-started-with-trae-cli",
  // 照录官方快速开始的整条命令:安装脚本跑在 `sh -c` 子进程里,它写进 shell
  // profile 的 PATH 传不回用户当前 shell,少了后半段就得重开终端才敲得动 traecli。
  installCommand: 'sh -c "$(curl -L https://trae.cn/trae-cli/install.sh)" && export PATH=~/.local/bin:$PATH',
  untested: true,
  notes:
    "2026-07-30 依据官方中文文档 docs.trae.cn 的 TRAE CLI 章节核对(/cli_use-cases 的参数表是唯一一处" +
    "完整命令行参考,/cli_permission-mode、/cli_model、/cli_global-settings、/cli_login-token 各补一块);" +
    "**本机未安装 traecli,一次都没实跑**,装上后第一件事是 `traecli --help` 对一遍下面每条。" +
    "已核实:①`-p/--print`「打印响应内容并立即退出,适用于管道场景」,就是非交互一次性执行," +
    "官方 CI 示例原文即 `traecli --allowed-tool Bash,Edit,MultiEdit,Write -p \"update the README with the latest changes\"`。" +
    "②`-y/--yolo`「YOLO 模式,跳过工具权限检查」= 自动批准,不给就会卡在交互确认(harness 里表现为任务永不结束)。" +
    "③**没有 `--model` 参数**——参数表 15 项里一个模型开关都没有;换模型只有交互式 `/model`、" +
    "改 trae_cli.yaml、或 `-c` 运行时覆盖配置,官方示例原文 `traecli -c model.name=kimi-k2`,故 model 走 `-c model.name=<v>`。" +
    "④`--json`「以 JSON 格式输出完整信息,包括 System Prompt、工具调用、执行过程与最终结果。仅与 `--print` 配合使用」," +
    "但文档**没给任何字段名,也没说是不是逐行 JSONL**,措辞更像一次性吐一整份 JSON,与 claude stream-json 不是一套;" +
    "拿它喂 claudeStreamJsonParser 会一行都解析不出,喂 textParser 又会把一坨 JSON 当正文糊进时间线," +
    "所以这里**不带 `--json`**,用纯文本 + 缺省 textParser(看不到工具调用,但不会错报)。" +
    "⑤`--session-id`「使用指定的会话 ID 进行会话跟踪」+ `--resume`「通过 ID 恢复一个会话」,按 harness 自发 id 那一档接。" +
    "⑥**没有 reasoning effort 概念**:参数表没有,trae_cli.yaml 的模型配置字段(base_url/api_key/model/by_azure)里也没有。" +
    "⑦**不写 relay**:第三方模型只能写进 trae_cli.yaml 的 `models[].open_ai|claude.api_key`,官方没有对应环境变量;" +
    "唯一的环境变量 `TRAECLI_PERSONAL_ACCESS_TOKEN`/`TRAECLI_HOST` 是 TRAE 自家企业账号的登录令牌(CI 场景用),不是通用中转。" +
    "用 `-c` 塞 key 会把密钥写进 argv 和 sessions.command_line,按目录约定禁止。" +
    "⑧`-w/--worktree` 是 TRAE 自己开 git worktree,**绝不能带**——harness 已经自己管 worktree,两套会打架。" +
    "仍未确认(装上后按这个顺序测):①`--session-id` 收不收 harness 发的随机 UUID,以及它和 `--resume` 是不是同一个 id 空间——" +
    "文档只说它「用于会话跟踪」,万一只是日志标签,那每个续聊回合都会 `--resume` 一个不存在的会话(这是本 spec 风险最大的一条," +
    "证伪了就把整个 session 字段删掉,退回「没有 resume 通道」的诚实降级);②`--yolo` 是否真的连 trae_cli.yaml 里的 " +
    "`ask_tools`/`disallowed_tools` 一起跳过(/cli_tool-permission 明说这两张表优先级高于会话内的「全部允许」)——" +
    "若不跳,得改用 /cli_permission-mode 的配置项 `permission_mode: bypass_permissions`,否则照样卡确认;" +
    "③`-p` 到底是「带值的 flag」还是「布尔开关 + 位置参数」(两种解读下 `-p <prompt>` 都成立,但影响能不能改走 stdin);" +
    "④非 TTY 下 `-p` 的输出是不是干净纯文本(有 ANSI 也无妨,textParser 会剥);" +
    "⑤`--query-timeout`/`--bash-tool-timeout` 的默认值——文档没写,若默认偏短会把长任务腰斩,那时在执行器 profile 的" +
    "固定参数里补 `--query-timeout 24h` 之类(格式形如 30s/5m/1h),这里不预先猜;" +
    "⑥`-c model.name=` 的取值是内置模型 id 还是 trae_cli.yaml 里 `models[].name` 的展示名(文档两处 key 不同,未枚举内置 id);" +
    "⑦`--json` 的真实结构——值得测,能解析就换成内联 parser,能白嫖工具调用。" +
    "另注:`traecli acp serve`(Agent Client Protocol,Zed 那套)是另一条程序化通道,比 `-p` 富得多,但属于常驻 server 形态," +
    "跟 GenericCliExecutor 的一次性回合模型对不上,要接得写自定义 factory。" +
    "使用门槛:官方明说「仅 TRAE CN 企业版的旗舰版套餐客户可使用」,且「默认使用 Max 模式,请关注你的用量」。",
  exec: {
    // --yolo = 跳过工具权限检查。不给它,非 TTY 下会停在授权确认上永远不返回。
    baseArgs: ["--yolo"],
    // 官方 CI 示例就是 `-p "<prompt>"`(prompt 由 plan() 排在最后)。
    prompt: { via: "flag", flag: "-p" },
    // 没有 --model:换模型只能靠运行时覆盖配置项,官方示例 `traecli -c model.name=kimi-k2`。
    model: (v) => ["-c", `model.name=${v}`],
    // 输出格式刻意留空:`--json` 的 schema 文档一个字段都没给,见 notes ④。
    session: {
      newIdFlag: "--session-id",
      resumeArgs: (id) => ["--resume", id],
      interactive: (id) => `traecli --resume ${id}`,
    },
  },
};

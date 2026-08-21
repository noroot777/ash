import { createInterface } from "node:readline";
import type { AgentEvent } from "@ash/shared";
import { RunTraceRecorder } from "../diagnostics.js";
import { forceFinishOnExit, spawnErrorMessage } from "../spawn.js";
import type { CliParser, CliSpec } from "./types.js";

// ── agy 的 stream-json 事件 ────────────────────────────────────────────────
// schema 来自官方 docs/cli/headless(核对于 2026-07-30),CLI 1.1.8(2026-07-28)
// 引入。每行 NDJSON 都是 `{"event":"<名字>", "<同名 key>":{…}}` 的**外层信封 +
// 同名内嵌载荷**,跟 claude 的 stream-json(message.content[] 数组)和 gemini 的
// 平铺 snake_case **都不是一套**,所以三份 parser 谁也复用不了谁。
// 顺序保证:恰好一个 init → 任意多个 step_update → 恰好一个 result。
interface AgyToolInfo {
  name?: string;
  parameters?: unknown;
  output?: string;
  error?: { type?: string; message?: string };
}

interface AgyStep {
  conversation_id?: string;
  step_index?: number;
  /** ACTIVE | DONE */
  state?: string;
  /** user_input | agent_response | tool | checkpoint */
  step_type?: string;
  tool_name?: string;
  text_delta?: string;
  tool_info?: AgyToolInfo;
  subagent_info?: { subagents?: { type_name?: string; role?: string; conversation_id?: string }[] };
}

/** result 事件的载荷 = `--output-format json` 那个信封,同一套字段。 */
interface AgyResult {
  conversation_id?: string;
  /** SUCCESS | ERROR | CANCELED | INTERRUPTED | INVALID | WAITING | RUNNING */
  status?: string;
  response?: string;
  error?: string;
}

interface AgyStreamLine {
  event?: string;
  /** init 行把 conversation_id 挂在顶层(载荷里反而没有)。 */
  conversation_id?: string;
  init?: { cwd?: string; tools?: string[]; permission_mode?: string; model?: string; agent?: string };
  step_update?: AgyStep;
  result?: AgyResult;
}

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\-_]/g;
const stripAnsi = (s: string) => s.replace(ANSI, "");

const MAX_DETAIL = 300;
const detailOf = (params: unknown): string | undefined => {
  if (params === undefined || params === null) return undefined;
  let s: string;
  try {
    s = JSON.stringify(params) ?? "";
  } catch {
    return undefined;
  }
  if (!s || s === "{}") return undefined;
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;
};

// 惰性 async generator:所有 child.on(...) 都在函数体里注册,第一次迭代才跑。
// 预检失败时 spawnAgent 给的是「有人监听才报错」的假 child,抢跑的 'error' 会变成
// 没有监听者的 uncaughtException,任务永远卡 running(见 server/CLAUDE.md)。
const agyStreamJsonParser: CliParser = async function* (ctx) {
  const { child, bin, label, lifecycle } = ctx;
  const queue: AgentEvent[] = [];
  let resolve: (() => void) | null = null;
  let finished = false;
  const push = (e: AgentEvent) => {
    queue.push(e);
    resolve?.();
    resolve = null;
  };

  const trace = new RunTraceRecorder(ctx.trace);
  let sessionSent = false;
  let jsonLines = 0; // 一行都没解析出来 = --output-format 多半没生效
  let textChunks = 0;
  const toolSeen = new Set<number>(); // step_index → 这次工具调用已经记过了
  const toolFailed = new Set<number>();
  let strayTail = ""; // 解析不了的行(升级提示之类),只在兜底报错时用得上
  let stderrTail = "";

  const sendSession = (id?: string) => {
    if (sessionSent || !id) return;
    sessionSent = true;
    push({ kind: "session", cliSessionId: id });
  };

  const onStep = (su: AgyStep) => {
    // conversation_id 每个 step_update 都带一份,init 漏了也还能从这里补上。
    sendSession(su.conversation_id);
    // step_type:"user_input" 是 CLI 把我们刚发过去的 prompt 回显一遍,写进时间线
    // 等于把任务正文抄一份进会话记录。其余类型一律照收(未知类型宁可多记)。
    if (su.text_delta && su.step_type !== "user_input") {
      textChunks += 1;
      push({ kind: "text", text: su.text_delta });
    }
    const info = su.tool_info;
    if (su.step_type !== "tool" && !info) return;
    const name = info?.name || su.tool_name || "tool";
    // 同一次调用会先 ACTIVE 后 DONE 各来一条,按 step_index 去重;拿不到序号
    // (老版本 / 字段缺失)就宁可重复记,也别整段丢掉。
    const idx = typeof su.step_index === "number" ? su.step_index : null;
    const firstSight = idx === null || !toolSeen.has(idx);
    if (idx !== null) toolSeen.add(idx);
    // 第一眼就带 error(只收到 DONE、没收到 ACTIVE)时不再单独打一行「调用了它」,
    // 下面那条失败行已经带了同一个工具名 —— 两行说同一件事只是噪声。
    if (firstSight && !info?.error) push({ kind: "tool", name, detail: detailOf(info?.parameters) });
    if (info?.error && (idx === null || !toolFailed.has(idx))) {
      if (idx !== null) toolFailed.add(idx);
      const why = info.error.message ?? info.error.type ?? "(CLI 未给出原因)";
      push({ kind: "tool", name, detail: `失败：${why}`.slice(0, MAX_DETAIL) });
    }
  };

  const onResult = (r: AgyResult) => {
    sendSession(r.conversation_id);
    // text_delta 没来过(版本差异 / 只在 result 里给全文)时把整段正文补上,
    // 否则用户会看到一个「跑完了但什么都没说」的空回合。
    if (textChunks === 0 && r.response) {
      textChunks += 1;
      push({ kind: "text", text: r.response });
    }
    if (lifecycle.stopRequested) return; // 手停(CANCELED/INTERRUPTED)不算故障
    if (r.status && r.status !== "SUCCESS")
      push({ kind: "error", message: `${label} 回合以 ${r.status} 结束：${r.error ?? "(CLI 未给出原因)"}` });
  };

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    trace.event(line);
    let ev: AgyStreamLine;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
      ev = parsed as AgyStreamLine;
    } catch {
      // 一行脏数据不许炸掉整个回合;留个尾巴给收尾时的诊断文案。
      strayTail = (strayTail + stripAnsi(raw) + "\n").slice(-2000);
      return;
    }
    jsonLines += 1;
    switch (ev.event) {
      case "init":
        sendSession(ev.conversation_id);
        break;
      case "step_update":
        if (ev.step_update) onStep(ev.step_update);
        break;
      case "result":
        if (ev.result) onResult(ev.result);
        break;
      default:
        // 顶层 conversation_id 只要出现就认(未知事件类型将来可能也带)。
        sendSession(ev.conversation_id);
        break;
    }
  });
  child.stderr?.on("data", (d) => {
    const chunk = String(d);
    stderrTail = (stderrTail + chunk).slice(-8000);
    trace.stderr(chunk);
  });

  // 收尾单点:三条路(spawn 失败 / close / exit 后流不收尾)都汇到这里,
  // 保证事件流一定以 done 结束 —— 少一个 done 就是任务永远卡 running。
  const finish = (o: { exitStatus: number; spawnError?: string; flushTimeout?: boolean }) => {
    if (finished) return;
    finished = true;
    trace.close();
    const tail = stripAnsi(stderrTail).trim() || stripAnsi(strayTail).trim();
    // 参数没被接受(比如 CLI < 1.1.8 还没有 --output-format)时,一行 JSON 都不会有。
    const flagHint =
      jsonLines === 0
        ? ";stdout 里没有任何 stream-json 事件 —— --output-format stream-json 需要 Antigravity CLI ≥ 1.1.8," +
          "老版本会直接拒掉这个 flag(执行参数在 server/src/executors/catalog/antigravity.ts)"
        : "";
    if (o.spawnError) push({ kind: "error", message: o.spawnError });
    else if (o.flushTimeout)
      push({ kind: "error", message: "进程已退出但输出流未正常收尾(疑有残留子进程占用管道),已强制结束本回合" });
    else if (!lifecycle.stopRequested && o.exitStatus !== 0)
      push({
        kind: "error",
        message:
          `${label} 以 exit ${o.exitStatus} 结束${tail ? `：${tail.slice(0, 2000)}` : ",且 stderr 为空"}${flagHint}`,
      });
    else if (!lifecycle.stopRequested && o.exitStatus === 0 && textChunks === 0)
      push({
        kind: "error",
        message:
          `${label} 以 exit 0 结束但没有任何 assistant 输出${flagHint}` +
          `;另一个已知成因是 agy 在非 TTY 下丢弃 stdout(antigravity-cli issue #76/#318,官方已修 Windows 侧,` +
          `其余平台请先升级 CLI 再试)${tail ? `;输出尾巴:${tail.slice(0, 500)}` : ""}`,
      });
    push({ kind: "done", exitStatus: o.exitStatus });
    resolve?.();
    resolve = null;
  };

  child.on("error", (err: NodeJS.ErrnoException) => finish({ exitStatus: 1, spawnError: spawnErrorMessage(bin, err) }));
  child.on("close", (code, signal) => finish({ exitStatus: code ?? (signal ? 1 : 0) }));
  forceFinishOnExit(child, () => finished, (exit) => finish({ exitStatus: exit, flushTimeout: true }));

  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (finished) return;
    await new Promise<void>((r) => (resolve = r));
  }
};

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分按官方 docs/cli/headless
// 与 changelog(CLI 1.1.8)核准,**本机没装 antigravity、未实测**,故保留 untested。
export const antigravitySpec: CliSpec = {
  key: "antigravity",
  name: "Antigravity CLI",
  description: "Google 新版 CLI",
  // 探到的 bin 名保持 `antigravity` 在前:执行器侧一直按它认人,换顺序等于换行为。
  // 官方 quickstart 现在给的是 `agy`,作为备用候选补在后面(社区报告部分 Linux
  // 发行版装出来的就叫 `antigravity`,两个名字都真实存在)。
  bins: ["antigravity", "agy"],
  docsUrl: "https://antigravity.google/docs/cli/headless",
  installCommand: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  // 官方 docs/cli/install 原话是「runs natively on macOS, Linux, and Windows」,Windows
  // 段给 PowerShell 与 CMD 两条,这里取 PowerShell 那条(2026-08-14 核对文档,并下到
  // install.ps1 确认是真的安装脚本;装完落在 %LOCALAPPDATA%\agy\bin)。
  installCommandWindows: "irm https://antigravity.google/cli/install.ps1 | iex",
  untested: true,
  notes:
    "按官方 docs/cli/headless + antigravity.google/changelog 核准于 2026-07-30(最新 CLI 1.1.8,2026-07-28 发版);" +
    "本机没装 antigravity,**没有实跑过**。已核准:" +
    "①非交互开关是 `-p`(别名 --print/--prompt),跑完一个 prompt 就退出;" +
    "②自动批准是 `--dangerously-skip-permissions` —— 不给的话 1.1.3 起会「软拒绝」需要确认的工具" +
    "(不再是卡死,但 agent 会静默失去改文件的能力,比卡死更难发现);" +
    "③`--output-format stream-json` 是 NDJSON,每行 `{event, <同名载荷>}`,init/step_update/result 三种," +
    "与 claude、gemini 都不同源,故内联了自己的 parser;该 flag **1.1.8 才有**,老版本会拒;" +
    "④`--add-dir` 的默认值是空列表,agy **不会**把 cwd 自动纳入工作区(这点和 gemini-cli 相反)," +
    "不带就表现为「agent 看不见仓库里任何文件」,所以 baseArgs 固定带 `--add-dir .`;" +
    "⑤`--print-timeout` 默认只有 5m,对编码任务太短,这里放宽到 24h(理由见 exec 注释);" +
    "⑥会话 id 叫 conversation_id,由 CLI 生成,init 行顶层与每条 step_update 里都有,上面的 parser 把它作为" +
    "`{kind:\"session\"}` 回报,续跑走 README 的 (c) 档 `--conversation <id>`" +
    "(changelog 1.0.9 专门修过 `-p` + `--conversation` 的续跑);" +
    "⑦`--effort` 取 low/medium/high(1.1.5 加入)。" +
    "⑦`--effort` 取 low/medium/high(1.1.5 加入)。" +
    "仍未确认(要装了 CLI 才能定):" +
    "㈠**非 TTY 下 stdout 被丢弃/挂死**是这个 CLI 的历史顽疾(issue #76 已关但无修复说明、#318 仍开)," +
    "changelog 只写了修 Windows 侧;ash 一律用管道 spawn,这是最可能翻车的一条,parser 已针对" +
    "「exit 0 但零输出」给出指名道姓的提示;" +
    "㈡首次启动的 Workspace Trust 确认是交互式的,`--dangerously-skip-permissions` 是否连它一起跳过未知;" +
    "㈢model slug 的确切拼写(见 shared 的 CLI_MODEL_PRESETS 注释),且 slug 自带 effort 后缀时再叠 `--effort` 的行为未知;" +
    "㈣headless 依赖交互式登录过的缓存凭据,没登录会直接报 authentication required;" +
    "㈤未接 relay:CLI 侧没有任何 API key / base_url 通道(能设 base URL 的是 Python SDK,不是 agy)," +
    "硬塞环境变量只会打到一个必然失败的端点,所以刻意不写 relay。",
  exec: {
    // --output-format stream-json:换来工具调用、conversation_id 与流式正文。
    // --dangerously-skip-permissions:不给会被软拒绝工具,agent 静默改不了文件。
    // --add-dir .:agy 不隐式纳入 cwd(默认空列表),不给等于让 agent 空手干活。
    // --print-timeout 24h:默认 5m 会把长任务从中间截断(且截断后拿不到产物);
    //   ash 自己有停止/超时机制,这里等于把 CLI 侧的闸让开。想收紧的在执行器
    //   profile 的固定参数里补一个 `--print-timeout 10m` 即可 —— 用户参数排在最后。
    baseArgs: [
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--add-dir",
      ".",
      "--print-timeout",
      "24h",
    ],
    // 走 -p 而不是 stdin:文档里它就是「非交互跑一次」的开关,stdin 那条路没有
    // 书面保证,赌错的代价是任务永远卡住。代价:超大 prompt 受 argv 长度上限约束。
    prompt: { via: "flag", flag: "-p" },
    model: { flag: "--model" },
    reasoningEffort: { flag: "--effort" },
    // 没有 1.5x 加速档:`/fast` 与 settings.json 的 runningLightSpeed 都是会话内开关,
    // 没有对应的命令行 flag,故不设 fastArgs。
    session: {
      // (c) 档:conversation_id 由 agy 自己产生,靠上面 parser 从 init/step_update
      // 带回来。展示用的交互式命令按主 bin 名写;装的是 `agy` 的把命令名换掉即可。
      resumeArgs: (id) => ["--conversation", id],
      interactive: (id) => `antigravity --conversation ${id}`,
    },
    parser: agyStreamJsonParser,
  },
};

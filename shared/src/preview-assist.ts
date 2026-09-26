// 「AI 协助」填预览启动脚本这件事的协议。
//
// 它跟隔壁的「检测服务」（preview-command.ts）是两种东西，分工要说清楚：
//   · 检测服务 —— 纯静态读文件，零成本、零副作用，但只认得出常见框架的惯例写法，
//     认出来的命令**没人跑过**，对不对要用户自己赌。
//   · AI 协助  —— 一个真的 CLI 智能体去这个项目里看一圈给出脚本，然后**由 ash 自己
//     照着预览的那套真跑一遍**：借端口、起进程、探活、杀干净。起不来就把失败原因和
//     日志尾巴甩回给它再来一轮。所以填进输入框的脚本，是这台机器上真起来过的那一条。
//
// 「谁来判定成功」这件事不交给模型：模型说「我验证过了」和这个端口上真的有东西在听，
// 是两回事，而用户点「保存」之后再发现起不来，代价是他对着一个 404 重配一遍。
export const PREVIEW_ASSIST_MAX_ROUNDS = 3;

/** 一轮试跑等多久。跟预览自己的就绪超时同一个数量级，冷编译的项目才来得及。 */
export const PREVIEW_ASSIST_TRIAL_MS = 120_000;

/** 一轮里给智能体的墙钟上限。看一遍中等仓库 + 自己试几条命令够用了。 */
export const PREVIEW_ASSIST_THINK_MS = 420_000;

export type PreviewAssistStatus = "running" | "succeeded" | "failed" | "canceled";

/** 当前卡在哪一步。界面按它决定那句话怎么写，别让用户对着一个转圈猜。 */
export type PreviewAssistPhase = "starting" | "thinking" | "trying" | "done";

export interface PreviewAssistAttempt {
  round: number;
  /** 这一轮智能体给出的脚本（已按 parseAssistScript 抠干净）。 */
  script: string;
  ok: boolean;
  /** 起来了的话，探到的那个地址。 */
  url: string | null;
  /** 没起来的原因（一句话，日志在 log 里）。 */
  reason: string | null;
  /** 试跑日志的尾巴，原样给人看。 */
  log: string;
}

export interface PreviewAssistState {
  jobId: string;
  projectId: string;
  status: PreviewAssistStatus;
  phase: PreviewAssistPhase;
  /** 第几轮（1 起）。 */
  round: number;
  maxRounds: number;
  /** 谁在干这活，`claude@local·opus` 那种标签。 */
  executorLabel: string;
  /** 当前这一步的一句话说明。 */
  step: string;
  /** 智能体最近说的话的尾巴（只给人看进度，不参与判定）。 */
  say: string;
  attempts: PreviewAssistAttempt[];
  /** 成功时：真起来过的那条脚本。 */
  script: string | null;
  /** 成功时：探到的地址。 */
  url: string | null;
  /** 失败/取消时的原因。 */
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

/** 智能体要照着写的结论格式。提示词和解析器共用这一份，免得两头各说各的。 */
export const PREVIEW_ASSIST_MARKER = "启动脚本";

/**
 * 结论行。**必须整行**，装饰（markdown 加粗、引用号、井号）可以有，前面挂别的字不行。
 *
 * 行锚定这件事是现场教的：2026-09-26 那个起不来的仓库里，智能体在正文里引用了这四个字
 * （「…**不要写「启动脚本」那一段**，本回复中也不会再出现围栏块…」），当时的实现按
 * `lastIndexOf` 找标记、再取后面那一行裸文本，于是把这半句话当命令真跑了一遍。
 */
const MARKER_LINE = new RegExp(`^[\\s>*_#\`]*${PREVIEW_ASSIST_MARKER}[\\s*_\`]*[:：]?[\\s*_\`]*(.*)$`);

/**
 * 这一段装的其实是**终端回显**，不是脚本。
 *
 * 同一天的另一个现场：那次通篇没有结论块，解析退回「取最后一个围栏块」，把
 * `$ PORT=53177 npm run dev` / `> dev` / `exit code = 1` 整段当脚本跑了 —— 日志里
 * 只剩一句莫名其妙的「`$` 这个命令没找到」，没人能从那儿反推出是解析这一步歪的。
 * 「取最后一个围栏块」那条退路已经删掉（它还抓过一次 package.json 全文），这条判据
 * 留着挡标记后面就贴回显的写法。
 *
 * 判据取两种**一眼可辨**的回显标记：shell 提示符（`$ ` / `% ` / `PS …>`）和 npm 那种
 * 脚本回显（`> `）。真脚本里这两个开头都不会出现在行首。
 */
const TRANSCRIPT_LINE = /^(?:[$%>]\s|PS [^\n]*>)/;

function looksLikeTranscript(script: string): boolean {
  return script.split("\n").some((line) => TRANSCRIPT_LINE.test(line));
}

/** 跟标记写在同一行的那点东西是**命令**还是**一句话**。 */
function inlineIsProse(text: string): boolean {
  return text.length > 300 || /[。，；！？]/.test(text);
}

function clean(body: string): string | null {
  const script = body.split("\n").map((line) => line.replace(/\s+$/, "")).join("\n").trim()
    // 单行且带着提示符：这是「把命令连提示符一起粘过来」，意思没有歧义，剥掉就是脚本本身。
    // 多行带提示符的那种是回显，下面一并否掉。
    .replace(/^[$%]\s+(?=[^\n]*$)/, "");
  if (!script || script.length > 16_000 || looksLikeTranscript(script)) return null;
  return script;
}

/**
 * 从智能体的整段输出里抠出那份脚本。**只认约定的那一种写法**：一整行
 * 「启动脚本：」，紧跟一个围栏块（中间可以空行），或者命令就写在同一行上。
 *
 * 曾经还有两条退路——「取最后一个围栏块」和「取标记后面那一行文字」——都删了。它们是
 * 为「它忘了写标记」准备的，实际抓到的却是它贴的终端回显、package.json 全文和半句正文，
 * 而每一次抓错都要拿用户的项目目录真跑一遍才发现。**找不到就返回 null**：这一轮判成
 * 「没按格式给结论」，重试提示词会把格式再说一遍；连着两轮给不出，多半是它在说「这个
 * 项目起不来」，那句原话比任何猜出来的命令都有用（见 server 的 preview-assist.ts）。
 */
export function parseAssistScript(text: string): string | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const matched = lines[i]!.match(MARKER_LINE);
    if (!matched) continue;
    const inline = (matched[1] ?? "").replace(/[*_`]+$/, "").trim();
    if (inline && !inline.startsWith("```")) return inlineIsProse(inline) ? null : clean(inline);
    let at = i + 1;
    while (at < lines.length && !lines[at]!.trim()) at += 1;
    if (at >= lines.length || !lines[at]!.trim().startsWith("```")) return null;
    const body: string[] = [];
    for (let k = at + 1; k < lines.length && !lines[k]!.trim().startsWith("```"); k += 1) body.push(lines[k]!);
    return clean(body.join("\n"));
  }
  return null;
}

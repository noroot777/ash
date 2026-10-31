// 任务接力——上传附件迁移。
//
// attachmentsPrompt 会把上传文件(data/uploads)的**绝对路径**写进任务正文和回复
// 回合的消息,这些路径随后进入 CLI 会话 JSONL 和 run 产物。接力后那是**源机**的
// 路径,对端 agent 照着 Read 只会得到「文件不存在」。这里负责:
//   导出侧 collectUploads —— 从任务文本与文本载荷里扫出被引用的附件并打包;
//   导入侧 writeUploads + buildUploadRewrites/applyUploadRewrites —— 附件落到本机
//   uploads 目录,把所有文本(任务字段 + 文本类文件载荷)里的旧路径改写成新路径。
//
// 转义形态:路径出现在 JSON 文本(.jsonl)里时反斜杠是转义过的(D:\\a\\b),只扫/只改
// 原始形态会漏掉 Windows 源机的所有会话文件引用。所以原始、转义两种形态都扫,改写
// 对按「原始→原始、转义→转义」配对。坑在 POSIX 源机 → Windows 目标机:源路径没有
// 需转义字符,两种形态的 from **完全相同**,而 to 不同——无上下文的全局替换只能二选
// 一,把原始 Windows 路径写进 JSONL 就是非法 JSON(第 2 轮审查实测)。所以改写对按
// 形态分组返回,替换时由调用方声明文本的上下文(纯文本还是 JSON),歧义时按上下文
// 选组;.md 这类 markdown 正文和 JSON 哨兵行混排的文件,逐行判断是不是 JSON。
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { MAX_FILE_BYTES, MB } from "./handoff-types.js";
import type { HandoffUploadPayload } from "./handoff-types.js";
import { UPLOADS_DIR } from "./paths.js";
import { UPLOAD_NAME_RUN, isSafeUploadName, newUploadName, uploadNameIndex, uploadRunCandidates } from "./upload-names.js";
import type { UploadRef } from "./upload-names.js";

export const MAX_UPLOADS = 100;

/** 写盘结果:`name` 是**本机最终文件名**(撞名时改过),`fresh` = 这批字节是这次新写下的。 */
export type WrittenUpload = HandoffUploadPayload & { fresh: boolean };

/** 本机对这批名字的既有登记情况(`uploads.ts` 的 localUploadNames 算好后传进来)。 */
export interface LocalUploadNames {
  /** 有登记行的名字 —— 文件被删、行还在的也算撞名。 */
  registered: ReadonlySet<string>;
  /** 登记行已经就挂在这条接力任务上的名字 —— 唯一可以复用本机那份字节的一档。 */
  boundToTask: ReadonlySet<string>;
}

/** 一段文本在 JSON 字符串里的形态(去掉包裹引号)。POSIX 路径没有需转义字符,原样返回。 */
export const jsonEscaped = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * 这处引用**是不是把它那个字段整个占满了**。
 *
 * 这是「路径到哪里为止」唯一能从文本确定的一半,三种字段形态:
 *   · 引号/括号刚打开、紧跟着就合上 —— 这一对之间除了路径什么都没有(JSON 里的路径
 *     字段,键排第几都认得出;markdown 的 `![](…)`);
 *   · 独占一行 —— 行首到路径之间只有缩进、引用号或列表标记,路径之后就是行尾/文末。
 *     附件块(`attachmentsPrompt` 写的 `- <绝对路径>` 行)就是这一档;
 *   · 其余一律算「夹在正文里」。
 *
 * 占满字段的那些名字是我们自己写下去的,后面不可能粘着正文;而「请按 …/uploads/<名字>的
 * 要求办」这种夹在句子里的,前面有正文、后面也可能有 —— 只有后者才需要按本机已知的
 * 名字去消歧(判据与代价见 upload-names.ts 的 `uploadRunCandidates`)。
 *
 * 回看只看有界的一截:行首离得比这还远,说明前面必然还有别的正文。一行 11MB 的 JSONL
 * 上逐处 `lastIndexOf("\n")` 会退化成平方级(审查第 2 轮发现 2 是同一个坑)。
 */
const FIELD_LOOKBACK = 200;
/** 行首到路径之间只许有缩进、引用号和列表标记。 */
const LINE_LEAD = /[\n\r][\s>]*(?:[-*+]\s+|\d+[.)]\s+)?$/u;
const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "<": ">", '"': '"', "'": "'", "`": "`" };

function fillsField(text: string, at: number, end: number): boolean {
  const before = at > 0 ? text[at - 1]! : "";
  const after = end < text.length ? text[end]! : "";
  if (before && CLOSERS[before] === after) return true;
  if (after && after !== "\n" && after !== "\r") return false;
  const from = Math.max(0, at - FIELD_LOOKBACK);
  const window = text.slice(from, at);
  // 判据一律以一个**真的换行**起头:文本开头自己补一个;窗口被截断(from > 0 且里面
  // 一个换行都没有)就匹配不上 —— 前面还有 200 个字符的正文,当然不是独占一行。拿 `^`
  // 兜这一档会把「截断的窗口」误当行首。
  return LINE_LEAD.test(from === 0 ? `\n${window}` : window);
}

/**
 * 文本里**每一处** uploads 引用:按字符集切到的最长一段 + 它是不是占满了自己那个字段
 * (一处一条,保留重复)。
 *
 * 这一刀只负责「从哪里开始、最多到哪里」。切不准的那一档(中文说明直接粘在路径后面)
 * 由 `uploadRunCandidates` 按出处给候选、再由调用方的授权闸定答案 —— 文本启发式一概
 * 不做,推演见 upload-names.ts。保留逐处结果而不是直接归并成名字集合,是因为**出处
 * 关系是判据的一部分**:调用方要按「一处引用一条交代」记 notes,归并掉就只能靠事后比
 * 前缀去猜哪两个名字来自同一处(审查第 2 轮发现 2:那个猜法是全局两两比较,80k 条
 * 引用把主服务同步卡住 16.8 秒)。
 */
export function scanUploadRuns(text: string, uploadsDir: string = UPLOADS_DIR): UploadRef[] {
  const refs: UploadRef[] = [];
  // POSIX 下两种形态相同,Set 去重后只扫一遍。
  for (const prefix of new Set([uploadsDir + sep, jsonEscaped(uploadsDir + sep)])) {
    let idx = 0;
    while ((idx = text.indexOf(prefix, idx)) !== -1) {
      const at = idx;
      idx += prefix.length;
      const match = UPLOAD_NAME_RUN.exec(text.slice(idx, idx + 512));
      if (match) refs.push({ run: match[0], explicit: fillsField(text, at, idx + match[0].length) });
    }
  }
  return refs;
}

/**
 * 同上,只要名字集合 —— 给「输入本来就是一条独立路径」的调用方用(`uploadNameOf`),
 * 那种输入没有后接散文,最长段就是精确名字。
 */
export const scanUploadNames = (text: string, uploadsDir: string = UPLOADS_DIR): Set<string> =>
  new Set(scanUploadRuns(text, uploadsDir).map((ref) => ref.run));

/**
 * 导出侧:收集被引用且本机真实存在的附件。dryRun(preflight)只盘点,不读内容。
 *
 * `canPack` 是**授权闸**,不给默认值:名字是从任务正文/会话文本里扫出来的,而路径
 * 会顺着日志、粘贴的 prompt、截图流到任何人手上。把别人的附件路径写进一条自己看得见
 * 的任务再接力出去,不问一声就等于把私有附件的内容送到另一台机器上(8CEbm0rJQIwK
 * 第 1 轮审查 P1)。判据由调用方从 `uploads.ts` 取(`readableUploads`),这里只负责
 * 逐个问、被拒的如实记进 notes —— 少一个附件对端最多按旧路径读不到,而多带一个是
 * 越权。新加导出入口时这个参数编译期就逼你想一遍「这是谁在导」。
 *
 * 问的顺序也是判据的一部分:**授权在前、存在性在后**,读不到的一律回同一句话
 * (第 2 轮审查 P2,推演见循环里)。
 */
export async function collectUploads(
  texts: string[],
  notes: string[],
  dryRun: boolean,
  canPack: (name: string) => Promise<boolean>,
): Promise<HandoffUploadPayload[]> {
  // 同一段文本(同样的出处)重复出现只记一次;出处不同的两处各算一处。
  const refs = new Map<string, UploadRef>();
  for (const t of texts) {
    for (const ref of scanUploadRuns(t)) {
      const key = `${ref.explicit ? "!" : "?"}${ref.run}`;
      if (!refs.has(key)) refs.set(key, ref);
    }
  }
  const index = uploadNameIndex(await readdir(UPLOADS_DIR).catch(() => [] as string[]));
  const out: HandoffUploadPayload[] = [];
  const packed = new Set<string>();
  for (const ref of refs.values()) {
    if (out.length >= MAX_UPLOADS) {
      notes.push(`上传附件超过 ${MAX_UPLOADS} 个,余下的不迁移(对端按旧路径读不到)`);
      break;
    }
    // 候选判据见 upload-names.ts 的 uploadRunCandidates:明确路径只有它自己一个候选,
    // 夹在正文里的才按本机已知的名字收敛。
    //
    // **先问授权,再看在不在** —— 两件事都成立才算答案,一个候选落选就试下一个。反过来
    // 的话「本机没有这个文件」和「有,但你读不到」就是两句不同的话,谁都能拿一个猜来的
    // 文件名建条任务、点一次预检,问出「这台机器上有没有这个附件」,`/api/uploads/:file`
    // 对这两种情况回同一句 404 就白费了(8CEbm0rJQIwK 第 2 轮审查 P2)。候选落选也不许
    // 中止整处引用:否则往目录里放一个「`<短名字>` + 一段中文」的私有文件,就能让同一条
    // 可读引用从「带走」变成「带不走」,照样问出它在不在(UNFxdc3ADpeS 第 1 轮 R1)。
    let resolved: string | null = null;
    let denied = false;
    for (const candidate of uploadRunCandidates(ref, index)) {
      if (!(await canPack(candidate))) {
        denied = true;
        continue;
      }
      if (!existsSync(join(UPLOADS_DIR, candidate))) continue;
      resolved = candidate;
      break;
    }
    // **一处引用恒一条交代**,而且报的是原文那一段:于是「有这个文件但你读不到」与
    // 「本机压根没有」在外部看来是同一句话、同样的条数。
    if (!resolved) {
      notes.push(denied
        ? `上传附件 ${ref.run} 不随任务迁移(本机没有,或不在你的可读范围内)`
        : `上传附件 ${ref.run} 在本机已不存在,跳过`);
      continue;
    }
    // 收敛过的要如实说一句:带走的字节和正文里写的那一段不是同一个名字,用户得能看出
    // 我们把后面那截当成了说明文字(不说这一句就是「无缺失提示地带走不相关内容」)。
    if (resolved !== ref.run) {
      notes.push(`上传附件 ${ref.run} 按 ${resolved} 迁移(路径后面粘着正文,不算名字)`);
    }
    // 同一个附件被引用多次:带一份就够。能走到这里说明已经**过了授权闸**,静默跳过。
    if (packed.has(resolved)) continue;
    const abs = join(UPLOADS_DIR, resolved);
    const size = statSync(abs).size;
    if (size > MAX_FILE_BYTES) {
      notes.push(`上传附件 ${ref.run} ${Math.round(size / MB)}MB 超限,跳过`);
      continue;
    }
    packed.add(resolved);
    out.push({ name: resolved, sourcePath: abs, dataBase64: dryRun ? "" : (await readFile(abs)).toString("base64") });
  }
  return out;
}

/**
 * 导入侧:附件落到本机 uploads 目录,返回**真正写盘成功**的载荷——路径改写只认这批,
 * 写失败的旧路径原样留着(好歹能看出引用的是什么)。
 *
 * **本机同名的文件绝不覆盖。** 目录是扁平的、名字就是全部信息(`uploads.ts`),源机
 * 送来的名字撞上本机既有文件时,直接按名字写下去有两重后果:本机那份用户数据被远端
 * 内容顶掉;既有登记行还会被顺手补上接力任务的 id —— 别人的私有附件就此敞开给这条
 * 任务看得见的所有人(第 5 轮审查 P1)。
 *
 * 撞名一律**改名落地**,只有一种情况复用本机那一份:登记行已经就挂在这条接力任务上
 * (`local.boundToTask`)且字节一模一样 —— 接力移回的常态,授权面与「新写一份再登记
 * 给这条任务」完全等价,不必每来回一趟就多一份拷贝。「字节一样」本身**不是**复用的
 * 理由:本机那份可能是某人的私有附件、或挂在一条导入方看不见的任务上,复用就落成
 * 「导入报告说附件迁好了,正文指向本机路径,任务里的人却打不开」(第 6 轮审查 P2)。
 *
 * 返回的 `name` 一律是**本机最终名字**,`fresh` 标记这批字节是不是这次新写下的 ——
 * 调用方只该给 fresh 的那些建登记行(复用的那份归本机原主,一动不动)。
 */
export async function writeUploads(
  uploads: HandoffUploadPayload[],
  notes: string[],
  local: LocalUploadNames = { registered: new Set<string>(), boundToTask: new Set<string>() },
): Promise<WrittenUpload[]> {
  const written: WrittenUpload[] = [];
  for (const u of uploads) {
    // 远端送来的名字直接变成本机路径段,判据见 upload-names.ts 的 isSafeUploadName
    // (纯点号的目录引用、超长名一并挡在门外)。
    if (!isSafeUploadName(u.name)) {
      notes.push(`上传附件名非法,跳过:${u.name}`);
      continue;
    }
    const data = Buffer.from(u.dataBase64, "base64");
    if (data.byteLength > MAX_FILE_BYTES) {
      notes.push(`上传附件 ${u.name} 解码后超限,跳过`);
      continue;
    }
    mkdirSync(UPLOADS_DIR, { recursive: true });
    const abs = join(UPLOADS_DIR, u.name);
    const onDisk = existsSync(abs);
    if (!onDisk && !local.registered.has(u.name)) {
      await writeFile(abs, data);
      written.push({ ...u, fresh: true });
      continue;
    }
    const same = onDisk
      && local.boundToTask.has(u.name)
      && await readFile(abs).then((cur) => cur.equals(data)).catch(() => false);
    if (same) {
      written.push({ ...u, fresh: false });
      continue;
    }
    // 改名是**重新生成一个有界的名字**,不是往上叠前缀:叠加会把名字撑过校验上限,
    // 下一跳就把我们自己生成的附件名判成非法跳过(判据见 upload-names.ts)。
    const name = newUploadName(u.name);
    await writeFile(join(UPLOADS_DIR, name), data);
    notes.push(`上传附件 ${u.name} 与本机同名文件冲突,改名为 ${name} 落地(本机原文件没动)`);
    written.push({ ...u, name, fresh: true });
  }
  return written;
}

type Pair = { from: string; to: string };
const longestFirst = (a: Pair, b: Pair) => b.from.length - a.from.length;

/** 目标路径一律按 uploadsDir 自己的分隔风格拼,与运行平台无关。生产环境 uploadsDir
 * 就是本机 UPLOADS_DIR,结果与平台 join 相同;测试才会跨风格传(POSIX 机器模拟
 * Windows 目标机,或反过来),用平台 join 会把对侧风格拼坏,断言变成「看谁的机器」。 */
const joinUploads = (dir: string, name: string): string =>
  dir.includes("\\")
    ? `${dir.replace(/[\\/]+$/, "")}\\${name}`
    : `${dir.replace(/\/+$/, "")}/${name}`;

export interface UploadRewrites {
  // 原始形态的改写对(纯文本上下文)与 JSON 转义形态的改写对(JSON 字符串上下文)。
  raw: Pair[];
  json: Pair[];
  // true = 存在「两种形态的 from 相同、to 不同」的改写对(POSIX 源机 → Windows
  // 目标机),全局替换会写坏其中一种上下文,必须按上下文分组替换。
  ambiguous: boolean;
}

/** 改写对:源机旧路径 → 本机新路径,按形态分组;组内长的先换,防前缀互吞。 */
export function buildUploadRewrites(
  written: HandoffUploadPayload[],
  uploadsDir: string = UPLOADS_DIR,
): UploadRewrites {
  const raw: Pair[] = [];
  const json: Pair[] = [];
  let ambiguous = false;
  for (const u of written) {
    if (!u.sourcePath) continue;
    const to = joinUploads(uploadsDir, u.name);
    const fromJson = jsonEscaped(u.sourcePath);
    const toJson = jsonEscaped(to);
    if (u.sourcePath !== to) raw.push({ from: u.sourcePath, to });
    if (fromJson !== toJson) json.push({ from: fromJson, to: toJson });
    if (u.sourcePath === fromJson && to !== toJson) ambiguous = true;
  }
  return { raw: raw.sort(longestFirst), json: json.sort(longestFirst), ambiguous };
}

export const hasUploadRewrites = (rw: UploadRewrites): boolean =>
  rw.raw.length > 0 || rw.json.length > 0;

const applyPairs = (text: string, pairs: Pair[]): string => {
  let out = text;
  for (const p of pairs) out = out.replaceAll(p.from, p.to);
  return out;
};

/**
 * kind 声明文本的上下文:"json" = 整体是 JSON 文档/JSONL(路径以转义形态出现);
 * "plain" = 纯文本或混排文本(任务正文、transcript .md——markdown 正文 + JSON 哨兵行)。
 * 非歧义时两组的 from 互不冲突,合并去重后全局替换(即旧行为,所有非歧义方向不变);
 * 歧义时 "json" 只用转义组,"plain" 逐行判断:能按 JSON 解析的行(哨兵行/纯 JSON 行)
 * 用转义组,其余行用原始组。
 */
export function applyUploadRewrites(text: string, rw: UploadRewrites, kind: "json" | "plain"): string {
  if (!rw.ambiguous) {
    const merged: Pair[] = [];
    const seen = new Set<string>();
    for (const p of [...rw.raw, ...rw.json]) {
      if (seen.has(p.from)) continue;
      seen.add(p.from);
      merged.push(p);
    }
    return applyPairs(text, merged.sort(longestFirst));
  }
  if (kind === "json") return applyPairs(text, rw.json);
  return text
    .split("\n")
    .map((line) => {
      const brace = line.indexOf("{");
      if (brace !== -1) {
        try {
          JSON.parse(line.slice(brace));
          return applyPairs(line, rw.json);
        } catch { /* 不是 JSON 行,按纯文本处理 */ }
      }
      return applyPairs(line, rw.raw);
    })
    .join("\n");
}

// 只有文本类文件才做路径扫描/改写——二进制(截图等)碰一下就废。
const TEXT_EXT = new Set([".md", ".txt", ".json", ".jsonl", ".trace"]);

export function isTextRel(rel: string): boolean {
  const dot = rel.lastIndexOf(".");
  return dot !== -1 && TEXT_EXT.has(rel.slice(dot).toLowerCase());
}

/** 文本类文件载荷的改写上下文:.md/.txt 是(混排)纯文本,其余整体是 JSON。 */
export function rewriteKindFor(rel: string): "json" | "plain" {
  const dot = rel.lastIndexOf(".");
  const ext = dot === -1 ? "" : rel.slice(dot).toLowerCase();
  return ext === ".md" || ext === ".txt" ? "plain" : "json";
}

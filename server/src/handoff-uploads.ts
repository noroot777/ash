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
import { readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { MAX_FILE_BYTES, MB } from "./handoff-types.js";
import type { HandoffUploadPayload } from "./handoff-types.js";
import { UPLOADS_DIR } from "./paths.js";
import { UPLOAD_NAME_RUN, isSafeUploadName, newUploadName } from "./upload-names.js";

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
 * 文本里**每一处** uploads 引用按字符集切到的最长一段(一处一条,保留重复)。
 *
 * 这一刀只回答「从哪里开始、最多到哪里」。它**不回答这段文本指向哪个附件** —— 那个
 * 问题在文本层无解,判据见 `collectUploads`。
 */
export function scanUploadRuns(text: string, uploadsDir: string = UPLOADS_DIR): string[] {
  const runs: string[] = [];
  // POSIX 下两种形态相同,Set 去重后只扫一遍。
  for (const prefix of new Set([uploadsDir + sep, jsonEscaped(uploadsDir + sep)])) {
    let idx = 0;
    while ((idx = text.indexOf(prefix, idx)) !== -1) {
      idx += prefix.length;
      const match = UPLOAD_NAME_RUN.exec(text.slice(idx, idx + 512));
      if (match) runs.push(match[0]);
    }
  }
  return runs;
}

/** 同上,只要名字集合。 */
export const scanUploadNames = (text: string, uploadsDir: string = UPLOADS_DIR): Set<string> =>
  new Set(scanUploadRuns(text, uploadsDir));

type Taken =
  | { kind: "ok" | "dup" | "full" | "denied" | "missing" }
  | { kind: "oversize"; size: number };

/** 一个名字过三道闸(授权 → 存在 → 大小)并入列。措辞由调用方按自己那一档定。 */
async function takeUpload(
  name: string,
  out: HandoffUploadPayload[],
  packed: Set<string>,
  dryRun: boolean,
  canPack: (name: string) => Promise<boolean>,
): Promise<Taken> {
  if (packed.has(name)) return { kind: "dup" };
  if (out.length >= MAX_UPLOADS) return { kind: "full" };
  // **授权在前,再碰盘。** 不变量本体在调用方的措辞上(文本那一档「没有这个文件」与
  // 「有,但你读不到」必须是同一句话、同样的条数,否则拿一个猜来的文件名建条任务、点一次
  // 预检就能问出它在不在 —— `/api/uploads/:file` 对两种情况回同一句 404 就白费了,
  // 8CEbm0rJQIwK 第 2 轮审查 P2)。这里的顺序是另一半:没过闸的名字连 stat 都不做,
  // 免得耗时差本身变成那个答案。
  if (!(await canPack(name))) return { kind: "denied" };
  const abs = join(UPLOADS_DIR, name);
  if (!existsSync(abs)) return { kind: "missing" };
  const size = statSync(abs).size;
  if (size > MAX_FILE_BYTES) return { kind: "oversize", size };
  packed.add(name);
  out.push({ name, sourcePath: abs, dataBase64: dryRun ? "" : (await readFile(abs)).toString("base64") });
  return { kind: "ok" };
}

/**
 * 导出侧:收集随这条任务迁移的附件。dryRun(preflight)只盘点,不读内容。
 *
 * **身份来自归属表,不是从文本里解析出来的。** 这一条是本模块最贵的一课:
 * `attachmentsPrompt` 把附件的**绝对路径**写进任务正文,于是「这条任务有哪些附件」看着
 * 像个文本问题 —— 扫出路径、切出名字就完了。但文件名的字符集和正文的字符集重叠(汉字
 * 既是合法文件名字符、也是正文字符),中文说明可以直接粘在路径后面、中间一个标点都没有,
 * **「这段文本到哪里为止」在文本层根本不可判定**。沿这条路修过三轮,每一轮都是补丁:
 *   · 只按字符集切 → 把后文吞进名字(审查第 1 轮发现 2);
 *   · 再按「最后一处像扩展名的位置」猜一刀 → 后文里一个 `v1.2` 就猜偏,还会切坏
 *     `<id>-v1.2终稿` 这种合法名字(第 2 轮发现 1);
 *   · 改按「目录里存在的最长前缀」 → 正文里写明的一条缺失路径被**改指**成另一份真实
 *     存在的附件:缺失一声不响,反而多带走不相关的字节;而且读不到的目录条目能借此
 *     改变公开结果,成了存在性探针(UNFxdc3ADpeS 第 1 轮 R1)。
 *
 * 所以不再问这个问题。两档候选,**都不需要知道边界在哪**:
 *   · `owned` —— 登记表说这些附件挂在这条任务上(`uploads.ts` 的 `taskUploadNames`)。
 *     权威、精确,而且覆盖得比扫文本更全:agent 落的图、讨论回合的图压根不在任务正文里,
 *     以前得靠扫 run 产物文本才碰得到。
 *   · 文本里**恰好就是一个真文件**的那些引用 —— 别的任务/随手记的附件被粘了一条路径
 *     进来,过了授权闸照旧带走(老行为)。「这一段本身是不是一个真文件」是确定的事实,
 *     不是对边界的猜测;**不是真文件就不带**,于是缺失保持缺失,不会改指成另一份文件。
 *
 * 路径改写也不需要边界:`buildUploadRewrites` 构造的是 `<目录>/<名字>` → `<目录>/<新名字>`,
 * `replaceAll` 天然按前缀走 —— 正文里「<路径>的要求」这种粘连写法,前缀被换掉、后面那截
 * 原样留着,对端照样读得到。
 *
 * `canPack` 是**授权闸**,不给默认值:路径会顺着日志、粘贴的 prompt、截图流到任何人手上,
 * 把别人的附件路径写进一条自己看得见的任务再接力出去,不问一声就等于把私有附件的内容送到
 * 另一台机器上(8CEbm0rJQIwK 第 1 轮审查 P1)。判据由调用方从 `uploads.ts` 取
 * (`readableUploads`)。新加导出入口时这两个参数编译期就逼你想一遍「这是谁在导、导的是
 * 哪条任务」。
 */
export async function collectUploads(
  owned: Iterable<string>,
  texts: string[],
  notes: string[],
  dryRun: boolean,
  canPack: (name: string) => Promise<boolean>,
): Promise<HandoffUploadPayload[]> {
  const out: HandoffUploadPayload[] = [];
  const packed = new Set<string>();
  let full = false;
  const overflow = (): void => {
    if (!full) notes.push(`上传附件超过 ${MAX_UPLOADS} 个,余下的不迁移(对端按旧路径读不到)`);
    full = true;
  };

  // ① 挂在这条任务上的。导出者对这条任务本来就有权限,所以这一档的交代可以说实话。
  for (const name of new Set(owned)) {
    if (full) break;
    const taken = await takeUpload(name, out, packed, dryRun, canPack);
    if (taken.kind === "full") { overflow(); break; }
    if (taken.kind === "missing") notes.push(`附件 ${name} 挂在这条任务上,但本机已不存在,跳过`);
    else if (taken.kind === "denied") notes.push(`附件 ${name} 不在你的可读范围内,不随任务迁移`);
    else if (taken.kind === "oversize") notes.push(`附件 ${name} ${Math.round(taken.size / MB)}MB 超限,跳过`);
  }

  // ② 文本里提到的其它附件。**每一处引用独立判定**,不拿别处的结论抵扣。
  //
  // 这里曾经有一句捷径:「run 以某个已带走的名字开头就跳过」,理由是改写按前缀走、
  // 粘连写法(`<路径>的要求`)对端照样读得到。那句推理漏了一种情况 —— run 也可能是
  // **另一个真文件**的名字,恰好以已带走的那个开头(`A` 与 `A.附录.pdf`)。于是 A 带走了、
  // `A.附录.pdf` 既不收集也不交代,而前缀改写又把正文里那条长路径改到目标机:指过去却
  // 没有字节,少带的那份一声不响(IrEB2TWvYf0_ 第 1 轮 R1)。同一句捷径还会把「正文里
  // 写明一条缺失路径」的交代也遮掉。**它又把「这段文本到哪里为止」这个不可判定的问题
  // 偷偷放了回来,只是换了个位置。**
  //
  // 代价是粘连写法会多一句交代:`<路径>的要求` 整段本身不是文件名,而路径那一段其实会被
  // 改写、对端读得到。**失败方向必须是多说一句话** —— 反过来是真少带一个附件、再配一条
  // 指向空处的路径,而且不出声。
  for (const run of new Set(texts.flatMap((text) => scanUploadRuns(text)))) {
    if (full) break;
    const taken = await takeUpload(run, out, packed, dryRun, canPack);
    if (taken.kind === "full") { overflow(); break; }
    // **一处引用恒一条交代,而且读不到与不存在同一句话**:否则拿一个猜来的名字建条任务、
    // 点一次预检就能问出它在不在(同上 P2)。
    if (taken.kind === "missing" || taken.kind === "denied") {
      notes.push(
        `上传附件 ${run} 不随任务迁移(本机没有这个名字,或不在你的可读范围内;`
        + `若它是「附件路径 + 紧跟的说明文字」,路径那一段仍会照常改写)`,
      );
    } else if (taken.kind === "oversize") {
      notes.push(`上传附件 ${run} ${Math.round(taken.size / MB)}MB 超限,跳过`);
    }
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

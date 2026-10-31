// uploads 目录里**文件名的字符集契约**,单点。
//
// `data/uploads` 是扁平目录,文件名(`<nanoid>-<原名>`)就是全部信息(见 uploads.ts):
// 界面上那张卡片写什么、agent 在 prompt 里读到的路径长什么样、接力时从正文里扫不扫得
// 出来 —— 全由这一段字符集说了算。所以生成端(上传接口、agent 落图)、校验端(接力落地)、
// 扫描端(scanUploadNames)必须共用这一份;分成两份就会出现 2026-10-31 这一幕:
// 上传接口把中文一律换成 `_`(「第九期实战作业.pdf」落成 `<id>-pdf`,前导 `_` 还被整段
// 剥掉),而 agent 落图那一份早就放行了汉字,于是扫描端按上传接口的 ASCII 字符集切,
// 把 agent 图的中文名拦腰截断、归属回填认不出来。
//
// 字符集 = **Unicode 字母 / 数字 / 组合记号 + `.` `_` `-`**,即老 ASCII 规则的 Unicode
// 推广。这样选的三条理由:
//   · 汉字、假名、西里尔字母都是 `\p{L}`,原名照常保留 —— 这才是用户要的;
//   · 路径分隔符、控制字符、Windows 禁用的 `< > : " | ? *`、以及 U+202E 这类双向
//     改写格式字符(`\p{Cf}`)全都落在集合外,一个单路径段的安全性与原来逐字相同;
//   · 标点(含中文标点 `,。、;:?!()【】`)和空白都在集合外,于是正文、JSON 字符串、
//     markdown `![]()` 里路径的末尾都有天然边界。唯一够不着的是「中文说明直接粘在
//     路径后面、一个标点都没有」,那一档由 `trimToUploadName` 另给一个候选,见那里。
import { extname } from "node:path";
import { id } from "./util.js";

/** 名字里混进了目录成分(某些客户端报的是整条路径)就只取末段。两种分隔符都认。 */
const lastSegment = (raw: string): string => raw.split(/[\\/]/).pop() ?? "";

const NAME_CLASS = "\\p{L}\\p{N}\\p{M}._-";
/** 文本里从某处开始的「一段合法文件名」。scanUploadNames 用它切出候选。 */
export const UPLOAD_NAME_RUN = new RegExp(`^[${NAME_CLASS}]+`, "u");
const NOT_NAME_CHAR = new RegExp(`[^${NAME_CLASS}]+`, "gu");
const ALL_NAME_CHARS = new RegExp(`^[${NAME_CLASS}]+$`, "u");

// 名字长度两头都要卡:码点数是老规矩(`.slice(-80)`),字节数是文件系统的硬限
// (APFS / ext4 都是 255 **字节**)。只卡码点的话 80 个汉字 = 240 字节,加上 13 字节的
// id 前缀就顶到墙上了。
const MAX_NAME_CHARS = 80;
/** `<id>-` 之后那一段的字节预算。 */
const MAX_NAME_BYTES = 180;
const ID_PREFIX_BYTES = 13; // nanoid(12) + "-"
/** 落盘名的上限 —— `newUploadName` 的输出恒在此之内(撞名改名叠多少次都一样)。 */
export const MAX_STORED_NAME_BYTES = ID_PREFIX_BYTES + MAX_NAME_BYTES;
/**
 * 校验端的上限 = **文件系统给单个路径段的硬限**(APFS / ext4 都是 255 字节)。
 *
 * 生成端与校验端的上限脱钩过一次,代价是漏附件:撞名改名那条路当时写的是
 * `${id()}-${原名}`,一个 191 字节的长中文名接力过去撞上同名文件,改名后 204 字节 ——
 * 下一跳的校验把**我们自己生成的名字**判成非法,整个附件在那台机器上直接消失
 * (审查第 1 轮发现 1)。所以不变量立在命名层而不是靠两个数字对得上:
 *   · 生成端(`newUploadName`)自己收敛到 `MAX_STORED_NAME_BYTES`,叠多少次都不长大;
 *   · 校验端只问「这个名字本机写不写得下」—— 比生成端宽的那一截恰好收下存量名字
 *     (旧版本净化口径不同、早先撞名叠过前缀,最长能到 249 字节;审查第 2 轮 N2),
 *     它们撞名时照样会被重新生成成有界名字。
 */
const MAX_ACCEPTED_BYTES = 255;

const utf8Length = (text: string): number => Buffer.byteLength(text, "utf8");

/** 末尾优先保留(保住扩展名),按**码点**切、同时卡住 UTF-8 字节数。 */
function tailWithin(text: string, maxChars: number, maxBytes: number): string {
  const chars = [...text];
  const kept: string[] = [];
  let bytes = 0;
  for (let index = chars.length - 1; index >= 0 && kept.length < maxChars; index -= 1) {
    const size = utf8Length(chars[index]!);
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.push(chars[index]!);
  }
  return kept.reverse().join("");
}

/** 开头优先保留(调用方自己拼扩展名),同上按码点切、卡字节数。 */
function headWithin(text: string, maxChars: number, maxBytes: number): string {
  const kept: string[] = [];
  let bytes = 0;
  for (const char of text) {
    if (kept.length >= maxChars) break;
    const size = utf8Length(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    kept.push(char);
  }
  return kept.join("");
}

/**
 * 客户端报上来的原始文件名 → 可以直接拼进 `<id>-<这里>` 的**单个路径段**。
 *
 * 集合外的字符(空格、括号、各类标点、emoji)换成 `_` 并把连续的压成一个 —— 空格之所以
 * 不保留,是因为它既是 shell/日志里最常见的分隔符,也是扫描端判断「路径到此为止」的
 * 依据之一;「附件1 案例模版.docx」落成「附件1_案例模版.docx」仍然一眼认得出。
 * 前导的 `.` / `_` / `-` 剥掉(隐藏文件、`.`、`..` 一并挡在门外)。
 * NFC 归一化:同一个名字在 macOS 粘贴与 Windows 粘贴下可能是 NFD/NFC 两种字节序列,
 * 不归一的话库里的登记行和盘上的名字会对不上。
 */
export function sanitizeUploadName(raw: string): string {
  const base = lastSegment((raw || "").normalize("NFC"));
  const cleaned = base.replace(NOT_NAME_CHAR, "_").replace(/_{2,}/g, "_");
  return tailWithin(cleaned, MAX_NAME_CHARS, MAX_NAME_BYTES).replace(/^[._-]+/, "");
}

/**
 * agent 落图时用的「主干名」:扩展名由 mime 另行强制(uploads 按扩展名定 Content-Type,
 * 名字里写的不算数),所以这里只清洗主干、**从头**截断。
 */
export function sanitizeUploadStem(raw: string | undefined): string {
  const base = lastSegment((raw ?? "").normalize("NFC"));
  const stem = base.slice(0, base.length - extname(base).length) || base;
  const cleaned = stem.replace(NOT_NAME_CHAR, "-").replace(/-{2,}/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return headWithin(cleaned, 60, 120);
}

/**
 * **落盘名的唯一出处**:`<nanoid>-<净化名>`。上传接口、agent 落图、接力撞名改名三处
 * 共用它,所以「生成出来的名字一定过得了 `isSafeUploadName`」是构造上成立的,而不是
 * 靠两个常量碰巧对得上。
 *
 * 撞名改名传进来的是**一个完整的落盘名**:截断保末尾,于是叠加的效果是「换一个新前缀、
 * 把最老的那个前缀挤掉」,长度恒定收敛,叠多少次都不会把自己撑成非法名。
 */
export function newUploadName(display: string): string {
  return `${id()}-${tailWithin(display, MAX_NAME_CHARS, MAX_NAME_BYTES)}`;
}

/**
 * 别人送来的名字(接力载荷)能不能原样落盘。**失败方向是拒绝**:这是一条远端可控的
 * 字符串直接变成本机路径段的路,集合外的 `/` `\` 与控制字符一个都不能放过。
 * 纯点号的(`.` / `..`)单独拒 —— 它满足字符集却是目录引用。
 */
export const isSafeUploadName = (name: string): boolean =>
  ALL_NAME_CHARS.test(name) && !/^\.+$/.test(name) && utf8Length(name) <= MAX_ACCEPTED_BYTES;

/**
 * 一处引用的**最长合法段**(扫描端切出来的那一截)→ 它真正指的那个文件名。
 *
 * 为什么不能只靠文本:字符集不是正文里的可靠边界。中文可以把路径和后文粘在一起、
 * 中间一个标点都没有(「请按 …/uploads/<id>-report.pdf的要求按v1.2版本完成作业」),
 * 而汉字、数字、点号在名字里和在后文里都合法。按「最后一处像扩展名的位置」再猜一刀
 * 也不行:后文里出现一个 `v1.2` 就又猜偏了(审查第 2 轮发现 1 实测),而且那一刀还会
 * 切坏 `<id>-v1.2终稿` 这种结尾没扩展名的合法名字。**任何纯文本启发式都不成立。**
 *
 * 所以判据换成「**落在本机真有的那批名字里的最长前缀**」:名字由谁指定不重要,本机
 * 有没有这个文件是确定的事实。一个都对不上就原样返回整段 —— 调用方照常按「本机没有」
 * 处置,措辞不区分存在与否。
 *
 * **这不是把存在性提到授权前面。** 调用方(`collectUploads`)的 notes 一律报**原文那一段**
 * 而不是收敛后的名字,而且一处引用恒一条 notes:于是「本机有这个文件但你读不到」和
 * 「本机压根没有」在外部观察上仍是同一句话、同样的条数,收敛只决定我们去问哪个名字
 * 的授权(8CEbm0rJQIwK 第 2 轮审查 P2 的不变量)。
 *
 * 开销是**每处引用一个有界常数**:先直接查一次表(绝大多数引用本来就是精确路径,一次
 * 命中),否则只试那些「本机真有某个名字恰好是这个长度」的前缀 —— 长度至多 255 种,
 * 与引用条数无关。早先那版按「两两比前缀」找派生候选,80k 条引用能把主服务同步卡住
 * 16.8 秒(审查第 2 轮发现 2)。
 */
export interface UploadNameIndex {
  has: (name: string) => boolean;
  /** 本机名字出现过的长度,降序去重 —— 要试的前缀只有这些。 */
  lengths: number[];
}

export function uploadNameIndex(names: Iterable<string>): UploadNameIndex {
  const set = new Set(names);
  const lengths = [...new Set([...set].map((name) => name.length))].sort((a, b) => b - a);
  return { has: (name) => set.has(name), lengths };
}

export function resolveUploadRun(run: string, index: UploadNameIndex): string {
  if (index.has(run)) return run;
  for (const length of index.lengths) {
    if (length >= run.length) continue;
    const candidate = run.slice(0, length);
    if (index.has(candidate)) return candidate;
  }
  return run;
}

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
 * 校验端的上限,**从生成端的上限推出来**,不是另拍一个数。
 *
 * 这两个数脱钩过一次,代价是漏附件:撞名改名那条路当时写的是 `${id()}-${原名}`,
 * 一个 191 字节的长中文名接力过去撞上同名文件,改名后 204 字节 —— 下一跳的校验把
 * **我们自己生成的名字**判成非法,整个附件在那台机器上直接消失(审查第 1 轮发现 1)。
 * 所以不变量得立在命名层:生成的一定收得下,改名是重新生成而不是无限叠前缀。
 * 余量留给存量名字(旧版本净化口径不同、早先撞名叠过前缀),仍在 255 字节硬限之内。
 */
const LEGACY_SLACK_BYTES = 47;
const MAX_ACCEPTED_BYTES = MAX_STORED_NAME_BYTES + LEGACY_SLACK_BYTES;

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
 * 一段合法字符构成的串里,**另一个可能的收尾位置**:最后一处 `.` + 1~8 个 ASCII 字母
 * 数字、且其后不再是 ASCII 字母数字。`report.tar.gz` 取 `.gz`、`v1.2备份.docx` 取
 * `.docx`,整段本来就以扩展名收尾时原样返回。
 *
 * 为什么需要它:字符集本身不是正文里的可靠边界。中文正文可以把路径和后文粘在一起、
 * 中间一个标点都没有(「请按 …/uploads/<id>-report.pdf的要求完成作业」),而汉字是合法
 * 文件名字符,只按字符集切会把「的要求完成作业」吞进名字 —— 连旧的纯英文名附件也一起
 * 漏掉(审查第 1 轮发现 2 实测)。
 *
 * 为什么**不是**二选一、而是两个候选都报出去(见 `scanUploadNames`):这一刀同样会切错
 * ——`<id>-v1.2终稿` 这种内部有点号、结尾没扩展名的合法名字会被截成 `<id>-v1.2`。
 * 两个候选都交给调用方,谁对得上盘上/库里的东西谁生效,两种写法就都认得出来。
 *
 * 判据只看文本,不碰磁盘也不查库:「这个文件在不在本机」是另一条判据,混进来就等于
 * 给出一个存在性探针 —— 接力预检的 notes 会把名字原样印出来,而「没这个文件」和
 * 「有、但你读不到」在这条链上必须是同一句话(8CEbm0rJQIwK 第 2 轮审查 P2)。
 */
const EXT_BOUNDARY = /\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

export function trimToUploadName(run: string): string {
  let end = -1;
  for (const match of run.matchAll(EXT_BOUNDARY)) end = match.index + match[0].length;
  return end > 0 ? run.slice(0, end) : run;
}

/** b 是不是由 a 加长而来的**派生候选**(同一处引用的另一种收尾)。 */
export const isDerivedUploadName = (a: string, b: string): boolean => b.length > a.length && b.startsWith(a);

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
//   · 标点(含中文标点 `,。、;:?!()【】`)和空白都在集合外,于是**正文里路径的末尾有
//     天然边界**:扫描端只按字符集切就能停在正确的位置。
import { extname } from "node:path";

/** 名字里混进了目录成分(某些客户端报的是整条路径)就只取末段。两种分隔符都认。 */
const lastSegment = (raw: string): string => raw.split(/[\\/]/).pop() ?? "";

const NAME_CLASS = "\\p{L}\\p{N}\\p{M}._-";
/** 文本里从某处开始的「一段合法文件名」。scanUploadNames 用它切出候选。 */
export const UPLOAD_NAME_RUN = new RegExp(`^[${NAME_CLASS}]+`, "u");
const NOT_NAME_CHAR = new RegExp(`[^${NAME_CLASS}]+`, "gu");
const ALL_NAME_CHARS = new RegExp(`^[${NAME_CLASS}]+$`, "u");

// 名字长度两头都要卡:码点数是老规矩(`.slice(-80)`),字节数是文件系统的硬限
// (APFS / ext4 都是 255 **字节**)。只卡码点的话 80 个汉字 = 240 字节,加上 13 字节的
// id 前缀就顶到墙上了;接力落地撞名时还会再套一层前缀,所以生成端留足余量。
const MAX_NAME_CHARS = 80;
const MAX_NAME_BYTES = 180;
/** 校验端(别人送来的名字)的上限:比生成端宽,但要给撞名改名的 `<id>-` 留出余量。 */
const MAX_ACCEPTED_BYTES = 200;

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
 * 别人送来的名字(接力载荷)能不能原样落盘。**失败方向是拒绝**:这是一条远端可控的
 * 字符串直接变成本机路径段的路,集合外的 `/` `\` 与控制字符一个都不能放过。
 * 纯点号的(`.` / `..`)单独拒 —— 它满足字符集却是目录引用。
 */
export const isSafeUploadName = (name: string): boolean =>
  ALL_NAME_CHARS.test(name) && !/^\.+$/.test(name) && utf8Length(name) <= MAX_ACCEPTED_BYTES;

/**
 * 扫描端(`scanUploadNames`)的边界就是这一段字符集,**不做二次猜测**。
 *
 * 唯一够不着的一档:中文正文里把路径和后文粘在一起、中间一个标点都没有
 * (「我看了 …/uploads/<id>-作业.pdf的要求」) —— 汉字本身合法,这一刀切不开。曾经想按
 * 「最后一处扩展名」再收一刀,但那会**切坏合法名字**:`<id>-v1.2终稿` 这种内部有点号、
 * 结尾没扩展名的,连单独一条路径都会被截成 `<id>-v1.2`,归属回填跟着失效。
 *
 * 不收这一刀的代价很小:一个附件的**权威出处**(正文里 `attachmentsPrompt` 那一行、
 * JSON 字符串、markdown `![]()`)末尾都有集合外的字符收口,照样切得准;粘连只发生在
 * agent 的散文复述里,多扫出来的那个名字对不上盘,最多在接力 notes 里多一句
 * 「本机已不存在」,文件本身照常迁移。
 */

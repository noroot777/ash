// 证据目录里的「文件名」允许长什么样 —— 两个审查接口（团队审查 `review/file`、自由工作
// 流 `free-workflow/review-file`）共用这一份定义。
//
// 为什么要有这个文件：两边原先各自写死 `basename(name) === name`，于是审查者把截图放进
// `shots/` 就等于没放 —— 报告里那一处引用永远画不出来，而且失败得很安静（接口 404、渲染
// 点把裂图标收掉，报告正文看着就像少了一张图）。审查第 1 轮把它记成非阻塞项 2。
//
// 这里只管**路径形状**，越界判定仍归各自调用点：两个接口的根目录不同，附加检查（符号
// 链接、硬链接、目录祖先）也不同，`containedPath` 是它们共用的最后一道。
import { realpathSync } from "node:fs";
import { extname, sep } from "node:path";

/**
 * 证据目录往下最多认这么深 —— 真实证据都是一两层，再深的只可能是构造出来的。
 *
 * **截图条的枚举跟它共用这一个数**：两边不一样的话就会出现「接口服务得了、证据面板里却
 * 列不出来」的截图（审查第 2 轮 N1：形状判据放到 8 层，两处清单还只走 3 层）。
 */
export const EVIDENCE_MAX_DEPTH = 8;

/**
 * 证据接口**服务得了**的类型 —— 两个接口(团队 `review/file`、自由工作流
 * `free-workflow/review-file`)认不认一个名字,判据只有这张表,见 `evidenceHeaders`。
 *
 * 两边必须是同一张表:曾经团队那条按表判、不认的一律 400,自由工作流那条认任何后缀、不
 * 认识就当 `application/octet-stream` 端出去,于是同一个 `notes.txt` 在一条线上 200、另
 * 一条上 400(审查第 3 轮 R3 第 3 条实测)。能力一边松一边紧时,报告正文里一处相对路径
 * 在两条线上的结局就不一样,而写报告的人无从预料自己落在哪条线上。
 *
 * 收哪些:图片 + 审查者真会往报告里链的那些纯文本证据(`.log`、`.json`、`.diff`…)。
 * **不收 `.html`/`.svg`**——证据由被审任务的审查者写,同源端出去等于给自己站内塞一段可
 * 执行的标记。源码文件也不收:要给人看就贴进报告或存成 `.txt`/`.diff`。
 */
export const EVIDENCE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".patch": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/**
 * 这个名字该怎么端出去 —— `null` = 这类文件两条接口都不服务(一律 400)。
 *
 * `nosniff` 是必须的:表里几种纯文本都按 `text/plain` 端,浏览器嗅探出 HTML 就等于同源
 * 执行审查者写的内容。
 */
export function evidenceHeaders(name: string): Record<string, string> | null {
  const mime = EVIDENCE_MIME[extname(name).toLowerCase()];
  return mime ? { "content-type": mime, "x-content-type-options": "nosniff" } : null;
}

/** 自动铺进**截图条**的那几种 —— 上面那张表里的图片类型,不另立一份。 */
export const EVIDENCE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.entries(EVIDENCE_MIME).filter(([, mime]) => mime.startsWith("image/")).map(([ext]) => ext),
);

/**
 * `name` 作为证据目录内的相对路径拆成段，拆不动就是 `null`（调用点一律拒）。
 *
 * 拒的四类：绝对路径（`/`、`\`、盘符开头）、`.` 与 `..` 段、空段（`a//b`）、过深。
 * `..` 在这里就拒掉而不是靠下游兜：越界是**调用点**的词法前缀 + realpath 两道在管，但
 * 让这种名字走到 `resolve` 之后再判，等于把判据藏在另一个文件里。
 */
export function evidenceSegments(name: string): string[] | null {
  if (!name || /^[a-zA-Z]:/.test(name) || /^[\\/]/.test(name)) return null;
  const segments = name.split(/[\\/]/);
  if (segments.length > EVIDENCE_MAX_DEPTH) return null;
  for (const part of segments) if (!part || part === "." || part === "..") return null;
  return segments;
}

/**
 * 词法上含在 `base` 里、且**解完符号链接之后**仍含在 `base` 里的那条真实路径。
 *
 * 分隔符必须用 `sep` 而不是写死 `/`：`resolve` 在 Windows 上还的是反斜杠，拼 `/` 去比前缀
 * **恒为假**，于是这类函数在 Windows 上永远返回 null —— 审查报告一律读成空串，「按意见
 * 修复」被 manualRepairBlocker 一句「最近一轮审查报告不存在或为空」挡死。不是安全收紧，
 * 是整条功能失效，而且失败得很安静（2026-08-18 真机 test:free-workflow 实测）。
 *
 * realpath 这一道是放开子目录之后的要害：中间那一段也可能是审查者建的符号链接，词法前缀
 * 看不出来。只能用在**已经存在**的文件上（realpath 对不存在的路径抛错）。
 */
export function containedPath(base: string, file: string): string | null {
  if (!file.startsWith(base + sep)) return null;
  try {
    const realBase = realpathSync(base);
    const realFile = realpathSync(file);
    return realFile.startsWith(realBase + sep) ? realFile : null;
  } catch {
    return null;
  }
}

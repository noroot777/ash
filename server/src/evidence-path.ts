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
import { sep } from "node:path";

/**
 * 证据目录往下最多认这么深 —— 真实证据都是一两层，再深的只可能是构造出来的。
 *
 * **枚举清单跟它共用这一个数**：两边不一样的话就会出现「接口服务得了、证据面板里却列不
 * 出来」的文件（审查第 2 轮 N1：形状判据放到 8 层，两处清单还只走 3 层）。
 */
export const EVIDENCE_MAX_DEPTH = 8;

/**
 * 自动列进证据清单的图片类型。**跟 `REVIEW_MIME` 对齐**：列出来就得服务得了，否则面板上
 * 那张卡片必然 404。两处清单曾经一个收 WebP、一个不收（同上 N1）。
 */
export const EVIDENCE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".webp"]);

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

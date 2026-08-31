import type { HostInfo } from "../lib/apiTypes.ts";
import { joinHostPath } from "../lib/useHostInfo.ts";
import { DirectoryPickerButton } from "./DirectoryPickerButton.tsx";

// 多人模式下「这条路径只能落在我自己的目录里」这件事，界面上就长成**前缀锁死**的样子：
// 家目录那一段画成输入框里改不动的一截，用户只填后面的相对路径。
//
// 为什么不是「填一条完整路径 + 填错了再报 403」：服务端那道钳制（auth/path-scope.ts）是
// 硬的，普通用户填任何 `rootDir/<他的目录名>` 之外的路径都会被拒。让人先打一条长路径、
// 提交后才知道整条都白打，与其说是校验不如说是陷阱 —— 边界既然是死的，就该在输入框上
// 直接看得见、也打不出去。
//
// 前缀不是 input 的一部分（那样用户能删掉它），但它在 `<label>` 之内，所以读屏念标签时
// 会连它一起念，点它也照样聚焦到输入框。

export function ScopedPathField({
  home,
  host,
  value,
  onChange,
  placeholder,
  disabled,
  notify,
  autoFocus,
}: {
  /** 锁死的前缀（当前用户的目录绝对路径）。 */
  home: string;
  /** 服务端主机信息，只用来取分隔符 —— 路径长在**它**那台机器上。 */
  host: HostInfo | null;
  /** 前缀之后那一截相对路径。 */
  value: string;
  onChange: (tail: string) => void;
  placeholder?: string;
  disabled?: boolean;
  notify: (message: string) => void;
  autoFocus?: boolean;
}) {
  const sep = host?.sep ?? "/";
  const prefix = `${home.replace(/[\\/]+$/, "")}${sep}`;
  return (
    <span className="path-field">
      <span className="path-scoped">
        <code>{prefix}</code>
        <input
          className="mono"
          autoFocus={autoFocus}
          value={value}
          disabled={disabled}
          // 开头的分隔符吃掉：`/x` 拼在前缀后面会变成 `home//x`，而用户想说的就是 `x`。
          onChange={(event) => onChange(event.target.value.replace(/^[\\/]+/, ""))}
          placeholder={placeholder}
        />
      </span>
      <DirectoryPickerButton
        startIn={joinHostPath(host, home, value)}
        disabled={disabled}
        notify={notify}
        onPick={(picked) => {
          const tail = pathTailUnder(home, picked, host?.platform === "win32");
          // 服务端的目录树本来就只在这个人的目录里走，落到这里说明路径形状对不上 ——
          // 那就如实说一句，别把一条越界路径悄悄塞进前缀后面。
          if (tail === null) {
            notify("只能选你自己目录里的位置");
            return;
          }
          onChange(tail);
        }}
      />
    </span>
  );
}

/**
 * `path` 落在 `home` 之内时返回相对的那一截（`home` 本身 → 空串），否则 `null`。
 * Windows 的路径不区分大小写，比较得跟着放宽。
 */
export function pathTailUnder(home: string, path: string, caseInsensitive: boolean): string | null {
  const root = home.trim().replace(/[\\/]+$/, "");
  const clean = path.trim();
  if (!root) return null;
  const head = clean.slice(0, root.length);
  const hit = caseInsensitive ? head.toLowerCase() === root.toLowerCase() : head === root;
  if (!hit) return null;
  const rest = clean.slice(root.length);
  if (!rest) return "";
  if (rest[0] !== "/" && rest[0] !== "\\") return null;
  return rest.slice(1).replace(/[\\/]+$/, "");
}

/**
 * 把项目名当成目录名用。只做**必要**的清洗：路径分隔符和 Windows 不接受的那几个字符
 * 换成连字符，首尾的点和空格去掉（Windows 上以它们结尾的目录名建不出来）。
 *
 * 刻意不做 slug 化 —— 中文项目名在 macOS/Linux/Windows 上都是合法目录名，把「我的项目」
 * 转成一串拼音或者干脆清空，只会让人对着一个空输入框猜自己该填什么。
 */
export function pathSegmentFromName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return cleaned.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
}

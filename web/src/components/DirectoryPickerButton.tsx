import { useState } from "react";
import { api } from "../lib/api.ts";
import { useHostInfo } from "../lib/useHostInfo.ts";
import { DirectoryTreePicker } from "./DirectoryTreePicker.tsx";
import { Button } from "./ui.tsx";

// 「浏览…」按钮：把一个绝对路径填回输入框。它有**两条实现**，取哪条由服务端说了算：
//
// ① 系统文件选择窗口（`host.canPickDirectory`）。窗口弹在**服务端那台机器**上，所以：
//    · 远程浏览器、没有图形界面的服务器、以及多人模式下的普通用户都拿不到它
//      （后者是刻意的：那个窗口选得到整台机器的任意路径，是实例管理员的工具）。
//    · 窗口是模态的，请求会挂到用户点完，所以按钮期间显示「选择中…」并禁用；
//      服务端另有单飞闸，连点也只会开出一个窗口。
//    · 用户点「取消」不是错误，什么都不做，别弹提示。
// ② 拿不到 ① 时退到**应用内目录树**（`/fs/browse`，只在调用者自己的目录里走）。
//    以前这种情况是整个按钮不渲染、只能手打路径 —— 多人模式下那等于普通用户没有
//    任何可视化选路径的办法。

export function DirectoryPickerButton({ startIn, onPick, disabled, notify, className = "" }: {
  /** 打开时停在哪个目录。一般直接传输入框现在的值，服务端会自己退到父目录/家目录。 */
  startIn: string;
  onPick: (path: string) => void;
  disabled?: boolean;
  notify: (message: string) => void;
  className?: string;
}) {
  const host = useHostInfo();
  const [busy, setBusy] = useState(false);
  const [tree, setTree] = useState(false);

  // host 还没读回来时先什么都不画：这一瞬间画错按钮，用户点下去只会得到一次报错。
  if (!host) return null;

  if (!host.canPickDirectory) {
    return (
      <>
        <Button
          className={`dir-pick-button ${className}`.trim()}
          disabled={disabled}
          aria-label="在目录树里选择目录"
          onClick={() => setTree((open) => !open)}
        >
          {tree ? "收起" : "浏览…"}
        </Button>
        {tree ? (
          <div className="dir-pick-tree">
            <DirectoryTreePicker
              value={startIn}
              notify={notify}
              onClose={() => setTree(false)}
              onPick={(path) => {
                onPick(path);
                setTree(false);
              }}
            />
          </div>
        ) : null}
      </>
    );
  }

  const pick = async () => {
    setBusy(true);
    try {
      const result = await api.pickDirectory(startIn);
      if (result.path) onPick(result.path);
    } catch (error) {
      notify(error instanceof Error ? error.message : "打不开文件选择窗口");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      className={`dir-pick-button ${className}`.trim()}
      disabled={busy || disabled}
      aria-label={busy ? "正在等你在系统窗口里选目录" : "从系统窗口选择目录"}
      onClick={() => void pick()}
    >
      {busy ? "选择中…" : "浏览…"}
    </Button>
  );
}

/** 目录名（拿来给项目起个默认名）。服务端可能是 Windows，两种分隔符都得认。 */
export function directoryName(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments.length ? segments[segments.length - 1]! : "";
}

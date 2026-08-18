import { useState } from "react";
import { api } from "../lib/api.ts";
import { useHostInfo } from "../lib/useHostInfo.ts";
import { Button } from "./ui.tsx";

// 「浏览…」按钮：在**服务端那台机器**上弹系统文件选择窗口，把用户点中的绝对路径填回输入框。
//
// 三条约束都来自「窗口不在浏览器这一侧」这个事实：
//  · 服务端说这次请求用不了（远程浏览器、没有图形界面的服务器）时**整个按钮不渲染** ——
//    留一个按了没反应的按钮比没有按钮更糟，输入框本来就能手打路径。
//  · 窗口是模态的，请求会挂到用户点完，所以按钮期间要显示「选择中…」并禁用；
//    服务端另有单飞闸，连点也只会开出一个窗口。
//  · 用户点「取消」不是错误，什么都不做，别弹提示。

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
  if (!host?.canPickDirectory) return null;
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

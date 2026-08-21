import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { HostInfo } from "./apiTypes.ts";

// 「server 跑在哪台机器上」。路径提示一律按**它**的形状给：浏览器所在的系统不算数，
// 用 Windows 上的浏览器连 mac 上的 ash 是正常用法，而项目目录在服务端那台机器上。
//
// 一个 server 进程的平台/分隔符/家目录不会中途变，所以整个前端只拉一次、模块内共享。

let cached: HostInfo | null = null;
let inflight: Promise<HostInfo | null> | null = null;

function load(): Promise<HostInfo | null> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api.host()
      .then((host) => {
        cached = host;
        return host;
      })
      // 老服务端没有这个端点。拿不到就退回「不知道」，各调用点自己有兜底形状 ——
      // 为了一句路径提示弹一条错误不值得。
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** 服务端主机信息；还没拉到（或老服务端没这个端点）时是 `null`。 */
export function useHostInfo(): HostInfo | null {
  const [host, setHost] = useState<HostInfo | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    void load().then((value) => {
      if (alive && value) setHost(value);
    });
    return () => {
      alive = false;
    };
  }, []);
  return host;
}

/**
 * 家目录前缀缩成 `~`：`/Users/fjh/code/x` → `~/code/x`，`C:\Users\fjh\code\x` → `~\code\x`。
 *
 * host 还没到就按常见形状猜（mac `/Users/名`、Linux `/home/名`、Windows `C:\Users\名`）——
 * 猜错的代价只是这一帧显示全路径，比等一个网络往返再渲染划算。
 */
export function shortenHomePath(path: string, host: HostInfo | null): string {
  const clean = path.trim();
  if (!clean) return clean;
  if (host?.home) {
    const home = host.home.replace(/[\\/]+$/, "");
    const head = clean.slice(0, home.length);
    // Windows 的盘符和路径都不区分大小写，比较得跟着放宽。
    const hit = host.platform === "win32" ? head.toLowerCase() === home.toLowerCase() : head === home;
    if (!hit) return clean;
    const rest = clean.slice(home.length);
    if (!rest) return "~";
    return rest[0] === "/" || rest[0] === "\\" ? `~${rest}` : clean;
  }
  const guess = /^(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/]+/.exec(clean);
  return guess ? `~${clean.slice(guess[0].length)}` : clean;
}

/** 按服务端那台机器的形状拼一条示例路径（输入框占位符用）。 */
export function hostSamplePath(host: HostInfo | null, segments: string[]): string {
  const sep = host?.sep ?? "/";
  // 兜底值只在「host 还没到」的那一瞬间出现，用最常见的形状即可。
  const home = (host?.home ?? "/Users/you").replace(/[\\/]+$/, "");
  return [home, ...segments].join(sep);
}

/**
 * 按服务端那台机器的分隔符把「父目录 + 子目录名」拼成一条路径（克隆目标路径的预览用）。
 *
 * 两处根路径要单独照顾：POSIX 的 `/` 和 Windows 的 `C:\` 剥掉尾分隔符之后分别变成空串和
 * `C:` —— 直接接分隔符会拼出 `//x` 和正确的 `C:\x`，所以只有前者需要特判。
 */
export function joinHostPath(host: HostInfo | null, parent: string, child: string): string {
  const sep = host?.sep ?? "/";
  const p = parent.trim();
  const c = child.trim().replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  if (!p) return c;
  if (!c) return p;
  const left = p.replace(/[\\/]+$/, "");
  return left ? `${left}${sep}${c}` : `${sep}${c}`;
}

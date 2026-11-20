// 这台实例真实的资源目录（上传附件、验证证据），身份状态一到就由 AuthGate 填进来。
//
// 消息里存的是磁盘路径，要换成取图接口得先知道它是不是**本实例**的附件/证据。路径长什么样
// 证明不了这一点：数据根可以在任何地方（mac 版在 `~/Library/Application Support/…`），项目里
// 也完全可以有一个 `uploads/<12 位 id>-x.png`（比如把上传图复制进来改过）。所以只认真实根。
import type { ResourceRoots } from "@navi/shared";

type Roots = { uploads: string[]; runs: string[] };

const normalize = (path: string): string => path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
// 盘符与 UNC 是 Windows 路径，大小写不敏感。
const caseless = (root: string): boolean => /^[A-Za-z]:\//.test(root) || root.startsWith("//");

let current: Roots = { uploads: [], runs: [] };

export function setResourceRoots(roots: ResourceRoots | null | undefined): void {
  current = {
    uploads: roots?.uploads ? [normalize(roots.uploads)] : [],
    runs: (roots?.runs ?? []).map(normalize).filter(Boolean),
  };
}

function below(path: string, roots: string[]): string | null {
  const target = normalize(path);
  for (const root of roots) {
    const prefix = `${root}/`;
    const hit = caseless(root) ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix);
    if (hit) return target.slice(prefix.length);
  }
  return null;
}

/** 磁盘路径是本实例 uploads 目录**直下**的文件吗；是就给出文件名。 */
export function instanceUploadName(path: string): string | null {
  const rest = below(path, current.uploads);
  return rest && !rest.includes("/") && rest !== "." && rest !== ".." ? rest : null;
}

/** 磁盘路径在本实例 runs 目录（含预览的只读回退）下的那一段，`<任务>/review/round-N/…` 这种。 */
export function instanceRunsPath(path: string): string | null {
  return below(path, current.runs);
}

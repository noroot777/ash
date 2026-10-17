import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { expandHome } from "./platform.js";

// 路径怎么算「同一个目录」——归属证据（`task-artifact-scope.ts`）和区间核对
// （`task-artifact-windows.ts`）都靠它。为什么非得过 `realpath`，见下面 `pathLens` 的注释。

/**
 * 路径归一：`resolve` 之外还要过一遍 `realpath`。
 *
 * macOS 上 `/var`、`/tmp` 都是软链（`/private/var`、`/private/tmp`），会话记下来的 cwd 和
 * git 报出来的仓库根很容易一个带 `/private` 一个不带——纯 `resolve` 比较会把**同一个目录**
 * 判成两个，于是独占目录被降级成共享、重新吃上时间上限，第 1 轮 F3 修好的延迟产物又漏回去
 * （第 2 轮审查 F2）。
 *
 * **目录已经不在了也要能归一**：worktree 删掉之后，它的路径仍然要跟仓库根比得上。所以问不到
 * 真身就沿祖先往上找最近那个还在的，把余下那几段接回去（`realpath -m` 的语义）——否则一个
 * 带 `/private` 一个不带，父子关系直接判没。
 *
 * **缓存只活一次查询**（这个对象的生命期就是一次 `resolveArtifactScope`）。进程级缓存会把
 * 路径身份当成不变量：软链被重新指向、原先不存在的路径后来建成了软链，缓存里那个答案就
 * 错了，而独占凭据正是靠它判的——面板会拿着上一次解析的结论把别的任务的产物认成自己的，
 * 直到重启服务（第 3 轮审查 N1）。目录在不在更是随时变（worktree 会被验收清理掉）。
 * 一次查询内重复问几十次同一个路径，这点缓存就够用了。
 */
export function pathLens() {
  const canonicals = new Map<string, Promise<string>>();
  const exists = new Map<string, Promise<boolean>>();

  const canonical = (input: string): Promise<string> => {
    const key = resolve(expandHome(input));
    let hit = canonicals.get(key);
    if (!hit) {
      hit = realpath(key).catch(async () => {
        const parent = dirname(key);
        return parent === key ? key : join(await canonical(parent), basename(key));
      });
      canonicals.set(key, hit);
    }
    return hit;
  };

  return {
    async sameDir(a: string | null | undefined, b: string): Promise<boolean> {
      const left = (a ?? "").trim();
      if (!left) return false;
      const [one, two] = await Promise.all([canonical(left), canonical(b)]);
      return one === two;
    },
    /** `child` 是不是 `parent` 自己或它底下的某一层（两边都先归一）。 */
    async underDir(child: string, parent: string): Promise<boolean> {
      const [c, p] = await Promise.all([canonical(child), canonical(parent)]);
      return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
    },
    /** 这个目录现在还在不在。记录下来的工作目录已经没了，是「无从查证」而不是「不是它」。 */
    dirExists(input: string): Promise<boolean> {
      const key = resolve(expandHome(input));
      let hit = exists.get(key);
      if (!hit) {
        hit = stat(key).then((info) => info.isDirectory()).catch(() => false);
        exists.set(key, hit);
      }
      return hit;
    },
  };
}

export type PathLens = ReturnType<typeof pathLens>;

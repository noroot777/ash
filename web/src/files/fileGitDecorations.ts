import type { FileGitStatus, ScmChangeKind, ScmDiffSource } from "../lib/api.ts";
import type { ScmDiffTarget } from "../scm/scmModel.ts";

export type FileGitDecoration = {
  kind: ScmChangeKind;
  descendant: boolean;
  /**
   * 这个条目自己点开时要摊的那份 diff（祖先目录没有，只有改动落在自己身上的文件才有）。
   * 文件树里「有颜色」的文件一律用对比打开，靠的就是它。
   */
  diff: ScmDiffTarget | null;
};

const PRIORITY: Record<ScmChangeKind, number> = {
  unmerged: 5, deleted: 4, modified: 3, typechange: 3, renamed: 2, copied: 2, added: 1, untracked: 1,
};

/**
 * 同一个文件在暂存侧和工作树侧都有改动时，点开先给工作树那份 —— 用户在文件树里点一个
 * 文件，想看的是「它现在跟仓库里差在哪」，而不是上一次 `git add` 冻住的那份。
 */
const SOURCE_PRIORITY: Record<ScmDiffSource, number> = { unstaged: 3, untracked: 2, staged: 1 };

export function fileGitDecorations(git: FileGitStatus | null): ReadonlyMap<string, FileGitDecoration> {
  const decorations = new Map<string, FileGitDecoration>();
  const add = (path: string, kind: ScmChangeKind, descendant: boolean, diff: ScmDiffTarget | null) => {
    const previous = decorations.get(path);
    // 角标看 kind 的优先级，diff 看 source 的优先级：两者各挑各的，互不牵连
    // （工作树侧是 `modified`、暂存侧是 `renamed` 时，角标仍该显示重命名）。
    const nextDiff = pickDiff(previous?.diff ?? null, diff);
    if (!previous || PRIORITY[kind] >= PRIORITY[previous.kind]) {
      decorations.set(path, { kind, descendant, diff: nextDiff });
    } else if (nextDiff !== previous.diff) {
      decorations.set(path, { ...previous, diff: nextDiff });
    }
  };
  const mark = (path: string, kind: ScmChangeKind, diff: ScmDiffTarget | null) => {
    path = path.replace(/\/$/, "");
    add("", kind, true, null);
    add(path, kind, false, diff);
    let slash = path.lastIndexOf("/");
    while (slash >= 0) {
      path = path.slice(0, slash);
      add(path, kind, true, null);
      slash = path.lastIndexOf("/");
    }
  };
  for (const change of git?.changes ?? []) {
    mark(change.path, change.kind, diffTargetOf(change));
    // 重命名的来源路径在树里已经不存在了，标成删除只是给父目录上色，没有 diff 可摊。
    if (change.kind === "renamed" && change.origPath) mark(change.origPath, "deleted", null);
  }
  return decorations;
}

function pickDiff(previous: ScmDiffTarget | null, next: ScmDiffTarget | null): ScmDiffTarget | null {
  if (!next) return previous;
  if (!previous) return next;
  return rankOf(next) > rankOf(previous) ? next : previous;
}

/** `branch` 那一档不会出现在文件树里（它比的是提交历史），排最低位当兜底。 */
function rankOf(target: ScmDiffTarget): number {
  return target.source === "branch" ? 0 : SOURCE_PRIORITY[target.source];
}

function diffTargetOf(change: FileGitStatus["changes"][number]): ScmDiffTarget | null {
  // 服务端比前端旧时没有 `source`（这个字段是跟「点开有颜色的文件就摊 diff」一起加的）：
  // web/dist 换上就生效，服务端却要等用户重启，中间那段窗口是真实存在的。拿不到就退回
  // 全文打开，别拿一个空 source 去换后端一个 400。
  if (!change.source) return null;
  // `origPath` 只对暂存侧的重命名有意义：工作树那一侧比的是重命名之后的路径本身
  // （与 ScmInspector 给 unstaged/untracked 传 null 是同一口径）。
  return {
    path: change.path,
    source: change.source,
    origPath: change.source === "staged" ? change.origPath : null,
    kind: change.kind,
  };
}

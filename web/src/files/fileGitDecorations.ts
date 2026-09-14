import type { FileGitStatus, ScmChangeKind } from "../lib/api.ts";

export type FileGitDecoration = { kind: ScmChangeKind; descendant: boolean };

const PRIORITY: Record<ScmChangeKind, number> = {
  unmerged: 5, deleted: 4, modified: 3, typechange: 3, renamed: 2, copied: 2, added: 1, untracked: 1,
};

export function fileGitDecorations(git: FileGitStatus | null): ReadonlyMap<string, FileGitDecoration> {
  const decorations = new Map<string, FileGitDecoration>();
  const add = (path: string, kind: ScmChangeKind, descendant: boolean) => {
    const previous = decorations.get(path);
    if (!previous || PRIORITY[kind] >= PRIORITY[previous.kind]) {
      decorations.set(path, { kind, descendant });
    }
  };
  const mark = (path: string, kind: ScmChangeKind) => {
    path = path.replace(/\/$/, "");
    add("", kind, true);
    add(path, kind, false);
    let slash = path.lastIndexOf("/");
    while (slash >= 0) {
      path = path.slice(0, slash);
      add(path, kind, true);
      slash = path.lastIndexOf("/");
    }
  };
  for (const change of git?.changes ?? []) {
    mark(change.path, change.kind);
    if (change.kind === "renamed" && change.origPath) mark(change.origPath, "deleted");
  }
  return decorations;
}

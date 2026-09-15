import type { GitAction } from "@ash/shared/git-workbench";

const quote = (value: string) =>
  /^[a-zA-Z0-9_./:@{}~-]+$/.test(value) ? value : JSON.stringify(value);
export function displayCommand(action: GitAction): string {
  const target = "target" in action ? quote(action.target) : "";
  const name = "name" in action ? quote(action.name) : "";
  const path = "path" in action ? quote(action.path) : "";
  const paths =
    "paths" in action
      ? action.paths.slice(0, 20).map(quote).join(" ") +
        (action.paths.length > 20 ? " …" : "")
      : "";
  switch (action.kind) {
    case "remote-add":
      return `git remote add ${name} <url>`;
    case "remote-url":
      return `git remote set-url ${name} <url>`;
    case "remote-remove":
      return `git remote remove ${name}`;
    case "remote-delete-ref":
      return `git push --force-with-lease ${quote(action.remote)} :refs/${action.refKind === "tag" ? "tags" : "heads"}/${name}`;
    case "stage":
      return `git add -A -- ${paths}`;
    case "unstage":
      return `git restore --staged -- ${paths}`;
    case "discard":
      return `git restore --worktree -- ${paths}${action.deleteUntracked.length ? `; git clean -f -- ${action.deleteUntracked.slice(0, 20).map(quote).join(" ")}` : ""}`;
    case "patch":
      return `git apply --cached (${action.lines.length} selected lines)`;
    case "commit":
      return `git commit ${action.amend ? "--amend " : ""}-F -`;
    case "checkout":
      return `git switch ${name}`;
    case "branch-create":
      return `git ${action.checkout ? "switch -c" : "branch"} ${name} ${target}`;
    case "branch-rename":
      return `git branch -m ${name} ${quote(action.next)}`;
    case "branch-delete":
      return `git branch ${action.force ? "-D" : "-d"} ${name}`;
    case "upstream":
      return `git branch ${target ? `--set-upstream-to=${target}` : "--unset-upstream"} ${name}`;
    case "merge":
      return `git merge ${action.strategy === "ff" ? "" : `--${action.strategy} `}${target}`;
    case "rebase":
      return `git rebase ${target}`;
    case "rebase-plan":
      return `git rebase -i ${target}`;
    case "cherry-pick":
    case "revert":
      return `git ${action.kind} ${action.mainline ? `-m ${action.mainline} ` : ""}${target}`;
    case "reset":
      return `git reset --${action.mode} ${target}`;
    case "continue":
    case "abort":
    case "skip":
      return `git <current-operation> --${action.kind}`;
    case "resolve":
      return `resolve ${path}; git add -- ${path}`;
    case "stash-save":
      return `git stash push${action.untracked ? " --include-untracked" : ""}`;
    case "stash-apply":
    case "stash-pop":
    case "stash-drop":
      return `git stash ${action.kind.slice(6)} ${action.sha}`;
    case "tag-create":
      return `git tag ${action.message ? "-a " : ""}${name} ${target}`;
    case "tag-delete":
      return `git tag -d ${name}`;
    case "tag-push":
      return `git push ${quote(action.remote)} refs/tags/${name}`;
    case "fetch":
      return `git fetch --prune ${action.remote ? quote(action.remote) : "--all"}`;
    case "pull":
      return `git fetch; git ${action.strategy === "rebase" ? "rebase" : `merge ${action.strategy === "ff-only" ? "--ff-only" : "--no-edit"}`} @{upstream}`;
    case "push":
      return `git push ${action.lease ? `--force-with-lease=<upstream>:${action.lease}` : quote(action.remote)} HEAD:<upstream>`;
    case "worktree-add":
      return `git worktree add -b ${name} <new-directory> ${target}`;
    case "worktree-remove":
      return `git worktree remove ${path}`;
    case "worktree-lock":
    case "worktree-unlock":
      return `git worktree ${action.kind.slice(9)} ${path}`;
    case "undo":
      return `git reset --hard <backup:${quote(action.id)}>`;
  }
}
export function safeGitMessage(message: string): string {
  return message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")
    .slice(0, 24000);
}

import type { GitActionRequest } from "@ash/shared/git-workbench";
import { fail } from "./core.js";

const fields: Record<string, Record<string, string>> = {
  "backup-delete": { ref: "string", sha: "sha" },
  "rebase-cleanup": {},
  "remote-add": { name: "string", url: "string" },
  "remote-url": { name: "string", url: "string", version: "sha" },
  "remote-remove": { name: "string", version: "sha" },
  "remote-delete-ref": {
    remote: "string",
    name: "string",
    refKind: "branch|tag",
    sha: "sha",
  },
  stage: { paths: "paths" },
  unstage: { paths: "paths" },
  discard: { paths: "paths", deleteUntracked: "paths" },
  "discard-patch": { path: "string", diff: "text", lines: "numbers" },
  patch: {
    path: "string",
    source: "staged|unstaged",
    diff: "text",
    lines: "numbers",
  },
  commit: { message: "text", amend: "boolean" },
  checkout: { name: "string" },
  "branch-create": { name: "string", target: "string", checkout: "boolean" },
  "branch-delete": { name: "string", sha: "sha", force: "boolean" },
  "branch-rename": { name: "string", next: "string", sha: "sha" },
  upstream: { name: "string", target: "string" },
  merge: { target: "string", strategy: "ff|no-ff|squash" },
  "cherry-pick": { target: "string" },
  revert: { target: "string" },
  reset: { target: "string", mode: "soft|mixed|hard" },
  rebase: { target: "string" },
  "rebase-plan": { target: "string", steps: "steps" },
  continue: {},
  abort: {},
  skip: {},
  "discard-conflicts": {},
  resolve: {
    path: "string",
    version: "string",
    choice: "ours|theirs|content|delete",
  },
  "stash-save": { message: "string", untracked: "boolean" },
  "stash-apply": { sha: "sha" },
  "stash-pop": { sha: "sha" },
  "stash-drop": { sha: "sha" },
  "tag-create": { name: "string", target: "string", message: "text" },
  "tag-delete": { name: "string", sha: "sha" },
  "tag-push": { name: "string", sha: "sha", remote: "string" },
  fetch: { remote: "string" },
  pull: { strategy: "ff-only|merge|rebase" },
  push: { remote: "string" },
  "worktree-add": { name: "string", target: "string" },
  "worktree-remove": { path: "string", sha: "sha" },
  "worktree-lock": { path: "string" },
  "worktree-unlock": { path: "string" },
  undo: { id: "string" },
};
function valid(value: unknown, type: string): boolean {
  if (type === "string" || type === "text")
    return (
      typeof value === "string" &&
      !value.includes("\0") &&
      value.length <= (type === "text" ? 1024 * 1024 : 4096)
    );
  if (type === "sha")
    return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "paths")
    return (
      Array.isArray(value) &&
      value.length <= 4000 &&
      value.every((v) => valid(v, "string"))
    );
  if (type === "numbers")
    return (
      Array.isArray(value) &&
      value.length <= 100000 &&
      value.every((v) => Number.isInteger(v) && v >= 0)
    );
  if (type === "steps")
    return (
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (v) =>
          v &&
          valid(v.sha, "sha") &&
          valid(v.action, "pick|reword|squash|fixup|drop") &&
          valid(v.message, "text"),
      )
    );
  return typeof value === "string" && type.split("|").includes(value);
}
export function parseAction(body: unknown): GitActionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail("操作请求不合法", 400);
  const value = body as Record<string, unknown>;
  if (!valid(value.root, "string") || !valid(value.version, "sha"))
    fail("缺少工作树和状态版本，请刷新", 400);
  const action = value.action as Record<string, unknown> | undefined;
  if (
    !action ||
    typeof action.kind !== "string" ||
    !Object.hasOwn(fields, action.kind)
  )
    fail("未知 Git 操作", 400);
  for (const [key, type] of Object.entries(fields[action!.kind as string]))
    if (!valid(action![key], type)) fail(`参数 ${key} 不合法`, 400);
  if (
    action!.mainline !== undefined &&
    (!Number.isInteger(action!.mainline) ||
      Number(action!.mainline) < 1 ||
      Number(action!.mainline) > 16)
  )
    fail("父提交编号不合法", 400);
  if (action!.lease !== undefined && !valid(action!.lease, "sha"))
    fail("保护强推的期望提交不合法", 400);
  if (action!.content !== undefined && !valid(action!.content, "text"))
    fail("冲突内容不合法", 400);
  if (value.confirmation !== undefined && !valid(value.confirmation, "string"))
    fail("确认内容不合法", 400);
  return value as unknown as GitActionRequest;
}

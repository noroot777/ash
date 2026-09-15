import type {
  GitActionRequest,
  GitActionResult,
  GitConflict,
  GitDiff,
  GitHistoryCommit,
  GitWorkbenchState,
} from "@ash/shared/git-workbench";
import { id, json, request } from "../lib/apiClient.ts";

const base = (project: string) => `/projects/${id(project)}/git/workbench`;
const query = (values: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(values).filter(
      (pair): pair is [string, string] => pair[1] !== undefined,
    ),
  ).toString();
export const workbenchApi = {
  state: (project: string, root?: string, task?: string) =>
    request<GitWorkbenchState>(`${base(project)}?${query({ root, task })}`),
  action: (project: string, body: GitActionRequest) =>
    request<GitActionResult>(`${base(project)}/actions`, json("POST", body)),
  history: (
    project: string,
    root: string,
    options: { ref?: string; path?: string; skip?: number } = {},
  ) =>
    request<{ commits: GitHistoryCommit[]; more: boolean }>(
      `${base(project)}/history?${query({ root, ref: options.ref, path: options.path, skip: String(options.skip || 0) })}`,
    ),
  diff: (project: string, root: string, options: Record<string, string>) =>
    request<GitDiff>(`${base(project)}/diff?${query({ root, ...options })}`),
  conflict: (project: string, root: string, path: string) =>
    request<GitConflict>(`${base(project)}/conflict?${query({ root, path })}`),
};

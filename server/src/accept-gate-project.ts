import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { available, readResult, requiredRead } from "./accept-gate-fs.js";
import { insideTree } from "./accept-gate-tree.js";

export type UnknownSource = { kind: "unknown"; directory: string; metadata: string; reason: string };
type Repository = { root: string; common: string } | { root: string; issue: UnknownSource };
type SourceLocation = { kind: "owned"; inside: string } | { kind: "external" } | UnknownSource;
export type ProjectSources = { locate: (path: string) => Promise<SourceLocation> };
const identity = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

export const identityProblem = (issue: UnknownSource) => `目录 ${issue.directory} 的版本库身份无法读取：`
  + `元数据 ${issue.metadata} ${issue.reason}。无法证明它与被冻结项目的关系；`
  + `请修复该元数据及其指向的 Git 目录，使其可读取后重试（重新安装依赖不会修复这份元数据）`;

export async function projectSources(root: string): Promise<ProjectSources> {
  const projectRoot = await requiredRead(root, () => realpath(root));
  const repositories = new Map<string, Promise<Repository | null>>();
  const repositoryAt = (directory: string): Promise<Repository | null> => {
    const cached = repositories.get(directory);
    if (cached) return cached;
    const result = (async (): Promise<Repository | null> => {
      const marker = join(directory, ".git");
      const failed = (metadata: string, reason: string): Repository => ({ root: directory,
        issue: { kind: "unknown", directory, metadata, reason } });
      const markerRead = await readResult(() => stat(marker));
      if (markerRead.kind !== "value") {
        if (markerRead.kind === "unreadable") return failed(marker, `读取失败（${markerRead.error.code}）`);
        const parent = dirname(directory);
        return parent === directory ? null : await repositoryAt(parent);
      }
      let gitDirectory = marker;
      if (!markerRead.value.isDirectory()) {
        const pointer = await available(() => readFile(marker, "utf8"));
        const match = pointer?.match(/^gitdir:\s*(.+)\s*$/m);
        if (!match) return failed(marker, "无法读取有效的 gitdir 指针");
        gitDirectory = resolve(directory, match[1].trim());
      }
      let common = gitDirectory;
      const commonRead = await readResult(() => readFile(join(gitDirectory, "commondir"), "utf8"));
      if (commonRead.kind === "value") common = resolve(gitDirectory, commonRead.value.trim());
      else if (commonRead.error.code !== "ENOENT")
        return failed(join(gitDirectory, "commondir"), `读取失败（${commonRead.error.code}）`);
      const canonical = await available(() => realpath(common));
      return canonical === null ? failed(marker, `指向不可读取的 Git 目录 ${common}`) : { root: directory, common: canonical };
    })();
    repositories.set(directory, result);
    return result;
  };
  const project = await repositoryAt(projectRoot);
  return { locate: async path => {
    if (insideTree(projectRoot, path)) return { kind: "owned", inside: relative(projectRoot, path) };
    if (project !== null && "issue" in project) return project.issue;
    let directory = path;
    let issue: UnknownSource | null = null;
    for (;;) {
      const repository = await repositoryAt(directory);
      if (repository === null) break;
      if ("issue" in repository) issue ??= repository.issue;
      else if (project !== null && identity(repository.common) === identity(project.common)) {
        const checkoutRoot = join(repository.root, relative(project.root, projectRoot));
        if (insideTree(checkoutRoot, path)) return { kind: "owned", inside: relative(checkoutRoot, path) };
      }
      const parent = dirname(repository.root);
      if (parent === repository.root) break;
      directory = parent;
    }
    return issue ?? { kind: "external" };
  } };
}

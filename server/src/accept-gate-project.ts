import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { available, filesystemFailure } from "./accept-gate-fs.js";
import { insideTree } from "./accept-gate-tree.js";

type Repository = { root: string; common: string | null };
type SourceLocation = { kind: "owned"; inside: string } | { kind: "external" | "unknown" };
export type ProjectSources = { locate: (path: string) => Promise<SourceLocation> };
const identity = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;

export async function projectSources(root: string): Promise<ProjectSources> {
  const projectRoot = await realpath(root);
  const repositories = new Map<string, Promise<Repository | null>>();
  const repositoryAt = (directory: string): Promise<Repository | null> => {
    const cached = repositories.get(directory);
    if (cached) return cached;
    const result = (async (): Promise<Repository | null> => {
      const marker = join(directory, ".git");
      let markerInfo;
      try { markerInfo = await stat(marker); }
      catch (error) {
        if (!filesystemFailure(error)) throw error;
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return { root: directory, common: null };
        const parent = dirname(directory);
        return parent === directory ? null : await repositoryAt(parent);
      }
      let gitDirectory = marker;
      if (!markerInfo.isDirectory()) {
        const pointer = await available(() => readFile(marker, "utf8"));
        const match = pointer?.match(/^gitdir:\s*(.+)\s*$/m);
        if (!match) return { root: directory, common: null };
        gitDirectory = resolve(directory, match[1].trim());
      }
      let common = gitDirectory;
      try { common = resolve(gitDirectory, (await readFile(join(gitDirectory, "commondir"), "utf8")).trim()); }
      catch (error) {
        if (!filesystemFailure(error)) throw error;
        if (error.code !== "ENOENT") return { root: directory, common: null };
      }
      return { root: directory, common: await available(() => realpath(common)) };
    })();
    repositories.set(directory, result);
    return result;
  };
  const project = await repositoryAt(projectRoot);
  return { locate: async path => {
    const repository = await repositoryAt(path);
    if (project?.common === null || repository?.common === null) return { kind: "unknown" };
    if (project === null) {
      return repository === null && insideTree(projectRoot, path)
        ? { kind: "owned", inside: relative(projectRoot, path) }
        : { kind: "external" };
    }
    if (repository === null || identity(repository.common!) !== identity(project.common!)) return { kind: "external" };
    const checkoutRoot = join(repository.root, relative(project.root, projectRoot));
    return insideTree(checkoutRoot, path)
      ? { kind: "owned", inside: relative(checkoutRoot, path) }
      : { kind: "external" };
  } };
}

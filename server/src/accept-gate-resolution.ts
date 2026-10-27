import { readdir, realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import { physicalPath } from "./git-worktree-state.js";
import { available } from "./accept-gate-fs.js";

export type ResolutionEntry = { entry: string; landing: string; tree: string; nested: boolean; kind: "package" | "command" };
export type ResolutionTree = { path: string; entries: ResolutionEntry[]; selected: ResolutionEntry[]; inherited: boolean };
export type ResolutionIO = {
  stat: (path: string) => Promise<Stats>;
  realpath: (path: string) => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
};

export async function resolutionInputs(roots: string[], io: ResolutionIO = { stat, realpath, readdir }): Promise<ResolutionTree[]> {
  const stats = new Map<string, Promise<Stats | null>>();
  const paths = new Map<string, Promise<string | null>>();
  const contents = new Map<string, Promise<string[] | null>>();
  const memo = <Value>(cache: Map<string, Promise<Value | null>>, path: string, read: () => Promise<Value>) => {
    if (!cache.has(path)) cache.set(path, available(read));
    return cache.get(path)!;
  };
  const infoAt = (path: string) => memo(stats, path, () => io.stat(path));
  const reachable = async (path: string, directory = false): Promise<string | null> => {
    const info = await infoAt(path);
    if (info === null || (directory && !info.isDirectory())) return null;
    return await memo(paths, path, () => io.realpath(path));
  };
  const children = async (path: string) => (await memo(contents, path, () => io.readdir(path)))?.sort() ?? [];
  const trees = new Map<string, ResolutionTree>();
  const searched = new Set<string>();
  const selected = new Set<ResolutionEntry>();
  const pending = roots.map(root => ({ directory: physicalPath(root), inherited: true }));
  for (let index = 0; index < pending.length; index++) {
    let { directory, inherited } = pending[index];
    if (searched.has(directory)) continue;
    searched.add(directory);
    const visible = new Set<string>();
    for (;;) {
      const tree = await reachable(join(directory, "node_modules"), true);
      if (tree !== null && !trees.has(tree)) {
        const input: ResolutionTree = { path: tree, entries: [], selected: [], inherited };
        trees.set(tree, input);
        const add = async (entry: string, kind: ResolutionEntry["kind"]): Promise<void> => {
          const landing = await reachable(join(tree, entry));
          if (landing === null) return;
          if (kind === "command" && (await infoAt(landing))?.isFile() !== true) return;
          input.entries.push({ entry, landing, tree, nested: !inherited, kind });
        };
        for (const item of await children(tree)) {
          if (item === ".bin" || item.startsWith("@")) {
            if (await reachable(join(tree, item), true) === null) continue;
            for (const child of await children(join(tree, item))) {
              await add(join(item, child), item === ".bin" ? "command" : "package");
            }
          } else if (!item.startsWith(".")) {
            await add(item, "package");
          }
        }
      }
      const input = tree === null ? undefined : trees.get(tree);
      for (const item of input?.entries ?? []) {
        if (visible.has(item.entry)) continue;
        const info = await infoAt(item.landing);
        if (info === null) continue;
        visible.add(item.entry);
        if (!selected.has(item)) {
          selected.add(item);
          input!.selected.push(item);
          pending.push({ directory: info.isDirectory() ? item.landing : dirname(item.landing), inherited: false });
        }
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...trees.values()];
}

import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { physicalPath } from "./git-worktree-state.js";

export type ResolutionEntry = { entry: string; landing: string; tree: string; nested: boolean };
export type ResolutionTree = { path: string; entries: ResolutionEntry[]; selected: ResolutionEntry[]; inherited: boolean };

async function available<Value>(read: () => Promise<Value>): Promise<Value | null> {
  try {
    return await read();
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

async function reachable(path: string, directory = false): Promise<string | null> {
  const info = await available(() => stat(path));
  if (info === null || (directory && !info.isDirectory())) return null;
  return await available(() => realpath(path));
}

const children = async (path: string) => (await available(() => readdir(path)))?.sort() ?? [];

export async function resolutionInputs(roots: string[]): Promise<ResolutionTree[]> {
  const trees = new Map<string, ResolutionTree>();
  const searched = new Set<string>();
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
        const add = async (entry: string): Promise<void> => {
          const landing = await reachable(join(tree, entry));
          if (landing === null) return;
          input.entries.push({ entry, landing, tree, nested: !inherited });
        };
        for (const item of await children(tree)) {
          if (item === ".bin" || item.startsWith("@")) {
            if (await reachable(join(tree, item), true) === null) continue;
            for (const child of await children(join(tree, item))) {
              await add(join(item, child));
            }
          } else if (!item.startsWith(".")) {
            await add(item);
          }
        }
      }
      const input = tree === null ? undefined : trees.get(tree);
      for (const item of input?.entries ?? []) {
        if (visible.has(item.entry)) continue;
        const info = await available(() => stat(item.landing));
        if (info === null) continue;
        visible.add(item.entry);
        if (!input!.selected.includes(item)) {
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

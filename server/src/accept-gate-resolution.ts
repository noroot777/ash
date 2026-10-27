import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { physicalPath } from "./git-worktree-state.js";

export type ResolutionEntry = { entry: string; landing: string; tree: string; nested: boolean };
export type ResolutionTree = { path: string; entries: ResolutionEntry[]; selected: ResolutionEntry[]; inherited: boolean };

async function reachable(path: string): Promise<string | null> {
  try {
    await stat(path);
    return await realpath(path);
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

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
      const tree = await reachable(join(directory, "node_modules"));
      if (tree !== null && !trees.has(tree)) {
        const input: ResolutionTree = { path: tree, entries: [], selected: [], inherited };
        trees.set(tree, input);
        const add = async (entry: string): Promise<void> => {
          const landing = await reachable(join(tree, entry));
          if (landing === null) return;
          input.entries.push({ entry, landing, tree, nested: !inherited });
        };
        for (const item of (await readdir(tree, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
          if (item.name === ".bin" || item.name.startsWith("@")) {
            if (await reachable(join(tree, item.name)) === null) continue;
            for (const child of (await readdir(join(tree, item.name))).sort()) {
              await add(join(item.name, child));
            }
          } else if (!item.name.startsWith(".")) {
            await add(item.name);
          }
        }
      }
      const input = tree === null ? undefined : trees.get(tree);
      for (const item of input?.entries ?? []) {
        if (visible.has(item.entry)) continue;
        visible.add(item.entry);
        if (!input!.selected.includes(item)) {
          input!.selected.push(item);
          const info = await stat(item.landing);
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

import { readdirSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "out", "vendor", "venv", "__pycache__"]);

export function previewDirectories(root: string, depth = 1, descend: (rel: string) => boolean = () => true): string[] {
  const found = ["."];
  const queue = [{ rel: ".", level: 0 }];
  for (let i = 0; i < queue.length && found.length < 300; i++) {
    const { rel, level } = queue[i];
    if (level >= depth || (level > 0 && !descend(rel))) continue;
    let children: string[];
    try {
      children = readdirSync(join(root, rel), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name))
        .map((entry) => entry.name).sort();
    } catch { continue; }
    for (const name of children) {
      if (found.length >= 300) break;
      const child = rel === "." ? name : `${rel}/${name}`;
      found.push(child);
      queue.push({ rel: child, level: level + 1 });
    }
  }
  return found;
}

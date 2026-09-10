import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { PreviewCandidate } from "./preview-command.js";
import type { PreviewShell } from "./preview-shell.js";

const OUTPUT_DIRS = new Set(["dist", "build", "out", "output", "artifacts"]);
const SOURCE_DIRS = new Set(["src", "source", "app", "pages", "public", "static", "templates"]);
const SOURCE_FILES = /^(?:package\.json|(?:vite|vitest|webpack|rollup|next|nuxt|astro|svelte)\.config\..+|tsconfig(?:\..+)?\.json|angular\.json|pom\.xml|build\.gradle(?:\.kts)?|pyproject\.toml|manage\.py|go\.mod|Cargo\.toml|composer\.json|Gemfile)$/i;
const SOURCE_EXT = /\.(?:tsx?|jsx|vue|svelte|csproj|fsproj)$/i;
const MAX_HTML_BYTES = 1024 * 1024;

function entries(dir: string) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function hasSource(dir: string): boolean {
  return entries(dir).some((entry) => entry.isDirectory()
    ? ["src", "source", "app", "pages"].includes(entry.name.toLowerCase())
    : SOURCE_FILES.test(entry.name) || SOURCE_EXT.test(entry.name));
}

function inSourceTree(root: string, rel: string): boolean {
  let dir = resolve(root, rel);
  const boundary = resolve(root);
  while (true) {
    if (hasSource(dir) || (dir !== boundary && SOURCE_DIRS.has(basename(dir).toLowerCase()))) return true;
    if (dir === boundary) return false;
    dir = dirname(dir);
  }
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

function readyAsset(dir: string, url: string): boolean {
  if (/^(?:https?:|data:|\/\/)/i.test(url)) return true;
  let path: string;
  try { path = decodeURIComponent(url.split(/[?#]/, 1)[0]); } catch { return false; }
  if (!path || /[&\\]|^[a-z][a-z\d+.-]*:/i.test(path)) return false;
  if (/(?:^|\/)src\//i.test(path) || /\.(?:tsx?|jsx|vue|svelte)$/i.test(path)) return false;
  const absolute = resolve(dir, path.replace(/^\/+/, ""));
  if (!absolute.startsWith(resolve(dir) + sep)) return false;
  try { return statSync(absolute).isFile(); } catch { return false; }
}

function standaloneHtml(dir: string, name: string): boolean {
  let html: string;
  try {
    const path = join(dir, name);
    if (statSync(path).size > MAX_HTML_BYTES) return false;
    html = readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  } catch { return false; }
  // 完整文档与可直接加载的脚本/样式，比 index.html 这个文件名提供了更多产物证据。
  if (!/<html(?:\s|>)/i.test(html) || !/<body(?:\s|>)/i.test(html) || !/<\/html\s*>/i.test(html)) return false;
  if (/<%|\{\{|\{%/.test(html)) return false;
  for (const match of html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<link\b[^>]*>/gi)) {
    const tag = match[0];
    const script = /^<script\b/i.test(tag);
    const url = attribute(tag, script ? "src" : "href");
    if (script && /^(?:text\/(?:babel|typescript)|application\/typescript)$/i.test(attribute(tag, "type") ?? "")) return false;
    if (!script && !/\b(?:stylesheet|modulepreload)\b/i.test(attribute(tag, "rel") ?? "")) continue;
    if (url !== undefined && !readyAsset(dir, url)) return false;
    if (script && url === undefined && /\b(?:from\s*|import\s*(?:\(\s*)?)["'](?![./]|https?:|data:)/.test(tag)) return false;
  }
  return true;
}

/** 框架探测没有命中后才走这里；构建目录独立补扫，因为常规服务扫描跳过它们。 */
export function staticPreviewCandidates(root: string, directories: string[], shell: PreviewShell): PreviewCandidate[] {
  const locations = new Set(directories);
  for (const rel of directories) {
    for (const name of OUTPUT_DIRS) locations.add(rel === "." ? name : `${rel}/${name}`);
  }
  const found: PreviewCandidate[] = [];
  for (const rel of locations) {
    if (!shell.expressible(rel)) continue;
    const dir = join(root, rel);
    try { if (!lstatSync(dir).isDirectory()) continue; } catch { continue; }
    const listing = entries(dir);
    const pages = listing.filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name));
    if (!pages.length || pages.length > 40) continue;
    const output = OUTPUT_DIRS.has(basename(dir).toLowerCase());
    if (output ? hasSource(dir) : inSourceTree(root, rel)) continue;
    if (!pages.every((page) => standaloneHtml(dir, page.name))) continue;
    const python = shell.kind === "cmd" ? "python" : "python3";
    const command = (n: number) => {
      const bare = `${python} -u -m http.server ${shell.ref(n === 1 ? "PORT" : `PORT${n}`)} --bind 0.0.0.0`;
      return rel === "." ? bare : shell.cd(rel, bare);
    };
    const note = output ? "已有构建可能过期，不会重新构建" : "请确认是本次产物";
    found.push({
      directory: rel,
      label: `${rel === "." ? "这个项目" : rel}（静态 HTML · 需 Python 3；${note}）`,
      kind: "web",
      requiresSelection: true,
      command: command(1),
      sidekick: (n) => shell.background(command(n)),
    });
  }
  return found;
}

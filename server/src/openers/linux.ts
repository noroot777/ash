import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppOpener, OpenerProbe } from "./types.js";
import { execFileText as exec } from "../exec.js";

// Linux 侧的「谁能开这个文件」写在 .desktop 里（MimeType=），文件本身的 MIME
// 由 xdg-mime 判定。两边都是 freedesktop 标准，桌面环境无关。
function desktopDirs() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  const dataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [
    join(dataHome, "applications"),
    ...dataDirs.map((dir) => join(dir, "applications")),
    "/var/lib/flatpak/exports/share/applications",
    join(dataHome, "flatpak/exports/share/applications"),
    "/var/lib/snapd/desktop/applications",
  ];
}

interface DesktopEntry {
  file: string;
  id: string;
  name: string;
  mimeTypes: string[];
}

/** 只读 `[Desktop Entry]` 这一节 —— 后面的 Action 分节里也有 Name=，不能混进来。 */
function parseDesktopEntry(file: string, id: string, raw: string): DesktopEntry | null {
  let inMain = false;
  let name: string | null = null;
  let mimeTypes: string[] = [];
  let type: string | null = null;
  let hidden = false;
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text.startsWith("[")) {
      inMain = text === "[Desktop Entry]";
      continue;
    }
    if (!inMain || !text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 0) continue;
    const key = text.slice(0, eq).trim();
    const value = text.slice(eq + 1).trim();
    if (key === "Name" && !name) name = value;
    else if (key === "Type") type = value;
    else if (key === "MimeType") mimeTypes = value.split(";").map((item) => item.trim().toLowerCase()).filter(Boolean);
    else if (key === "NoDisplay" || key === "Hidden") hidden ||= value.toLowerCase() === "true";
  }
  if (type !== "Application" || hidden || !name || !mimeTypes.length) return null;
  return { file, id, name, mimeTypes };
}

async function listDesktopEntries(): Promise<DesktopEntry[]> {
  const seen = new Set<string>();
  const out: DesktopEntry[] = [];
  for (const dir of desktopDirs()) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".desktop") || seen.has(name)) continue;
      seen.add(name); // 前面的 XDG 目录优先级更高，同名后来者不覆盖
      try {
        const entry = parseDesktopEntry(join(dir, name), name, await readFile(join(dir, name), "utf8"));
        if (entry) out.push(entry);
      } catch {
        // 读不了的条目跳过
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function fileMimeType(absPath: string): Promise<string | null> {
  for (const [file, args] of [["xdg-mime", ["query", "filetype", absPath]], ["file", ["--mime-type", "-b", absPath]]] as const) {
    try {
      const { stdout } = await exec(file, [...args], { timeout: 5000 });
      const mime = stdout.trim().split("\n")[0]?.trim().toLowerCase();
      if (mime && mime.includes("/")) return mime;
    } catch {
      // 换下一个探测手段
    }
  }
  return null;
}

async function defaultDesktopId(mime: string): Promise<string | null> {
  try {
    const { stdout } = await exec("xdg-mime", ["query", "default", mime], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function probeLinuxOpeners(absPath: string): Promise<OpenerProbe> {
  const mime = await fileMimeType(absPath);
  if (!mime) {
    return { platform: "linux", canReveal: true, apps: [], note: "本机没有 xdg-mime / file，判断不出文件类型" };
  }
  const [entries, defaultId] = await Promise.all([listDesktopEntries(), defaultDesktopId(mime)]);
  const family = `${mime.split("/")[0]}/`;
  const scored: (AppOpener & { score: number })[] = [];
  for (const entry of entries) {
    const exact = entry.mimeTypes.includes(mime);
    const loose = !exact && entry.mimeTypes.some((item) => item.startsWith(family));
    if (!exact && !loose) continue;
    scored.push({
      id: entry.file,
      name: entry.name,
      detail: entry.id,
      match: exact ? "extension" : "type",
      isDefault: entry.id === defaultId,
      score: exact ? 3 : 2,
    });
  }
  scored.sort((a, b) => (
    Number(b.isDefault) - Number(a.isDefault) || b.score - a.score || a.name.localeCompare(b.name)
  ));
  return {
    platform: "linux",
    canReveal: true,
    apps: scored.map(({ score: _score, ...app }) => app),
    note: scored.length ? null : `没有应用声明能打开 ${mime}`,
  };
}

export function linuxRevealCommand(absPath: string, dir: string) {
  // 支持 FileManager1 的桌面（GNOME/KDE/Xfce）能精确选中文件；不支持就退回打开目录。
  return process.env.DBUS_SESSION_BUS_ADDRESS
    ? {
      file: "dbus-send",
      args: [
        "--session",
        "--dest=org.freedesktop.FileManager1",
        "--type=method_call",
        "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1.ShowItems",
        `array:string:file://${absPath}`,
        "string:",
      ],
      fallback: { file: "xdg-open", args: [dir] },
    }
    : { file: "xdg-open", args: [dir], fallback: null };
}

export function linuxOpenCommand(absPath: string, appId: string | null) {
  if (!appId) return { file: "xdg-open", args: [absPath], fallback: null };
  return {
    file: "gio",
    args: ["launch", appId, absPath],
    fallback: { file: "gtk-launch", args: [appId.split("/").pop() ?? appId, absPath] },
  };
}

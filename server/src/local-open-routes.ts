import type { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { expandHome } from "./git.js";

const CONFIGURED_ROOTS = (process.env.HARNESS_LOCAL_OPEN_ROOTS ??
  "/Users/fjh/code/daily-report/videos:/Users/fjh/code/harness/review")
  .split(":")
  .map((path) => path.trim())
  .filter(Boolean)
  .map((path) => resolve(expandHome(path)));

export function isTrustedLocalOpenRemote(address: string | undefined): boolean {
  const normalized = (address ?? "").replace(/^::ffff:/i, "");
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  if (normalized.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
  const tailscaleV4 = /^100\.(\d+)\./.exec(normalized);
  return tailscaleV4 !== null && Number(tailscaleV4[1]) >= 64 && Number(tailscaleV4[1]) <= 127;
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/** Resolve symlinks on both sides so a link inside an allowed repo cannot escape it. */
export async function resolveAllowedLocalPath(raw: string, roots: string[]): Promise<string | null> {
  if (!raw.trim()) return null;
  const target = await realpath(resolve(expandHome(raw))).catch(() => null);
  if (!target) return null;
  for (const root of roots) {
    const allowed = await realpath(resolve(expandHome(root))).catch(() => null);
    if (allowed && inside(allowed, target)) return target;
  }
  return null;
}

export async function registeredProjectRoots(): Promise<string[]> {
  const rows = await db.select({ repoPath: projects.repoPath }).from(projects);
  return rows
    .map(({ repoPath }) => expandHome(repoPath).trim())
    .filter(Boolean)
    .map((repoPath) => resolve(repoPath))
    // A registered filesystem root would make this opener unrestricted, so it is not an implicit project root.
    .filter((path) => path !== sep);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function mountLocalOpenRoutes(api: Hono): void {
  api.all("/open-local", async (c) => {
    if (!isTrustedLocalOpenRemote(getConnInfo(c).remote.address)) {
      return c.text("只允许本机或 Tailscale 网内设备调用 open-local", 403);
    }
    const target = await resolveAllowedLocalPath(
      c.req.query("path") ?? "",
      [...CONFIGURED_ROOTS, ...await registeredProjectRoots()],
    );
    if (!target) {
      return c.text("local path is missing, outside the allowlist, or does not exist", 400);
    }
    const child = spawn("open", [target], { detached: true, stdio: "ignore" });
    child.unref();
    return c.html(
      `<!doctype html><meta charset=utf-8><title>Opened</title>`
      + `<body style="font:14px -apple-system,system-ui,sans-serif;padding:20px">已打开：<code>${escapeHtml(target)}</code></body>`,
    );
  });
}

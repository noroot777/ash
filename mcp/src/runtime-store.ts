import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Entry = { path: string; sha?: string; executable?: boolean; link?: string };

export function runtimeEnvelope(root: string): { id: string; files: Entry[] } {
  const envelope = JSON.parse(readFileSync(join(root, "runtime-manifest.json"), "utf8"));
  if (typeof envelope.payload !== "string" || hash(envelope.payload) !== envelope.id) throw new Error("运行时清单身份不符");
  const payload = JSON.parse(envelope.payload);
  if (payload.protocol !== 1 || !Array.isArray(payload.files)) throw new Error("运行时清单不兼容");
  return { id: envelope.id, files: payload.files };
}

function verify(root: string): void {
  const { files } = runtimeEnvelope(root);
  const lock = lstatSync(join(root, ".in-use"));
  if (!lock.isFile() || lock.size !== 0) throw new Error("运行时使用锁无效");
  const expected = new Set<string>();
  for (const entry of files) {
    if (typeof entry.path !== "string" || !entry.path || isAbsolute(entry.path)
      || entry.path.split("/").some((part) => !part || part === "." || part === "..")
      || [".in-use", "runtime-manifest.json"].includes(entry.path) || expected.has(entry.path)) throw new Error("运行时清单路径无效");
    expected.add(entry.path);
    const file = join(root, entry.path);
    const stat = lstatSync(file);
    if (entry.link !== undefined) {
      if (!stat.isSymbolicLink() || readlinkSync(file) !== entry.link || isAbsolute(entry.link)
        || !realpathSync(file).startsWith(realpathSync(root) + "/")) throw new Error("运行时软链越界或损坏");
    } else if (!stat.isFile() || hash(readFileSync(file)) !== entry.sha || Boolean(stat.mode & 0o111) !== entry.executable) {
      throw new Error(`运行时文件校验失败：${entry.path}`);
    }
  }
  const actual = new Set<string>();
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        const path = relative(root, file);
        if (path !== ".in-use" && path !== "runtime-manifest.json") actual.add(path);
      }
    }
  }
  visit(root);
  if (actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry))) {
    const missing = [...expected].filter((entry) => !actual.has(entry)).slice(0, 8);
    const extra = [...actual].filter((entry) => !expected.has(entry)).slice(0, 8);
    throw new Error(`运行时文件集合不符；缺少：${JSON.stringify(missing)}；多出：${JSON.stringify(extra)}`);
  }
}

export function managedRuntime(root: string, data: string): boolean {
  try {
    const real = realpathSync(root);
    return dirname(real) === realpathSync(join(data, ".runtimes")) && runtimeEnvelope(real).id === basename(real);
  } catch { return false; }
}

export function publishMcpRuntime(source: string, data: string, serving?: string): { root: string; close(): void } {
  const store = join(data, ".runtimes");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const storeLock = openSync(join(store, ".store-lock"), constants.O_CREAT | constants.O_RDWR | 0x20, 0o600);
  let descriptor: number | undefined;
  try {
    let target: string;
    if (serving && managedRuntime(serving, data)) target = realpathSync(serving);
    else {
      const { id } = runtimeEnvelope(source);
      target = join(realpathSync(store), id);
      if (!existsSync(target)) {
        const staging = join(store, `.staging-${randomUUID()}`);
        try {
          cpSync(source, staging, { recursive: true, verbatimSymlinks: true });
          verify(realpathSync(staging));
          renameSync(staging, target);
        } finally { rmSync(staging, { recursive: true, force: true }); }
      }
    }
    descriptor = openSync(join(target, ".in-use"), constants.O_RDONLY | 0x10 | constants.O_NONBLOCK);
    verify(target);
    return { root: resolve(target), close: () => { if (descriptor !== undefined) { closeSync(descriptor); descriptor = undefined; } } };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  } finally { closeSync(storeLock); }
}

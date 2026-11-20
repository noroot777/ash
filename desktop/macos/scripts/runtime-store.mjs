import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const manifestName = ".runtime.json";

function inventory(root, directory = "") {
  return readdirSync(join(root, directory)).sort().flatMap((name) => {
    const path = directory ? `${directory}/${name}` : name;
    if (path === manifestName || path === ".in-use") return [];
    const file = join(root, path);
    const stat = lstatSync(file);
    if (stat.isDirectory()) return [[path, "directory"], ...inventory(root, path)];
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(file);
      const destination = relative(root, resolve(dirname(file), target));
      if (isAbsolute(target) || destination === ".." || destination.startsWith("../")) {
        throw new Error(`运行时链接越界：${path}`);
      }
      return [[path, "link", target]];
    }
    if (!stat.isFile()) throw new Error(`运行时包含特殊文件：${path}`);
    return [[path, "file", stat.mode & 0o111, createHash("sha256").update(readFileSync(file)).digest("hex")]];
  });
}

function identifier(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function activateRuntime(store, id) {
  const launcher = join(store, `.mcp-${randomUUID()}`);
  const pointer = join(store, `.current-${randomUUID()}`);
  try {
    writeFileSync(launcher, `#!/bin/sh
set -eu
store=$(CDPATH= cd -P -- "$(/usr/bin/dirname -- "$0")" && pwd)
version=$(/usr/bin/readlink "$store/current")
case "$version" in ''|*[!0-9a-f]*) exit 1 ;; esac
[ "\${#version}" -eq 64 ] || exit 1
exec "$store/$version/node/bin/node" "$store/$version/mcp/dist/index.js" "$@"
`, { mode: 0o755 });
    renameSync(launcher, join(store, "mcp.sh"));
    symlinkSync(id, pointer);
    renameSync(pointer, join(store, "current"));
  } finally {
    rmSync(launcher, { force: true });
    rmSync(pointer, { force: true });
  }
}

export function sealRuntime(source) {
  const schema = inventory(source).filter(([path]) => /^server\/dist\/db\/.*\.js$/.test(path));
  writeFileSync(join(source, ".handover.json"), JSON.stringify({ protocol: 1, schema: identifier(schema) }));
  const entries = inventory(source);
  const manifest = { format: 1, id: identifier(entries), entries };
  writeFileSync(join(source, manifestName), JSON.stringify(manifest));
  return manifest;
}

export function verifyRuntime(source, expectedID) {
  const lock = lstatSync(join(source, ".in-use"));
  if (!lock.isFile() || lock.size !== 0) throw new Error(`运行时代码锁损坏：${source}`);
  const manifest = JSON.parse(readFileSync(join(source, manifestName), "utf8"));
  if (manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.id) || (expectedID && manifest.id !== expectedID)
      || identifier(manifest.entries) !== manifest.id || identifier(inventory(source)) !== manifest.id) {
    throw new Error(`运行时校验失败：${source}`);
  }
  return manifest;
}

export function installRuntime(source, store) {
  const descriptor = process.platform === "darwin" ? openSync(join(source, ".in-use"), constants.O_RDONLY | 0x10) : null;
  try { return withStoreLock(store, () => publishRuntime(source, store)); }
  finally { if (descriptor !== null) closeSync(descriptor); }
}

function withStoreLock(store, operation) {
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const descriptor = openSync(join(store, ".store.lock"), constants.O_CREAT | constants.O_RDWR | (process.platform === "darwin" ? 0x20 : 0), 0o600);
  try { return operation(); } finally { closeSync(descriptor); }
}

export function selectRuntime(source, store) {
  return withStoreLock(store, () => {
    const root = realpathSync(source);
    if (dirname(root) !== realpathSync(store)) throw new Error("运行时不属于本数据根");
    const manifest = verifyRuntime(root);
    if (manifest.id !== root.split("/").at(-1)) throw new Error("运行时目录身份不符");
    activateRuntime(store, manifest.id);
  });
}

export function collectRuntimes(store) {
  if (process.platform !== "darwin") return [];
  return withStoreLock(store, () => {
    const pinned = new Set([readlinkSync(join(store, "current"))]);
    const journal = join(dirname(store), ".mac-runtime-recovery.json");
    if (existsSync(journal)) {
      try {
        const record = JSON.parse(readFileSync(journal, "utf8"));
        if (typeof record.previous !== "string" || typeof record.next !== "string") return [];
        for (const path of [record.previous, record.next]) pinned.add(path.split("/").at(-1));
      } catch { return []; }
    }
    const removed = [];
    for (const id of readdirSync(store).filter((name) => /^[a-f0-9]{64}$/.test(name))) {
      if (pinned.has(id)) continue;
      const root = join(store, id);
      if (lstatSync(root).isSymbolicLink()) continue;
      let descriptor;
      try {
        descriptor = openSync(join(root, ".in-use"), constants.O_RDONLY | constants.O_NONBLOCK | 0x20);
        verifyRuntime(root, id);
        const scan = spawnSync("/usr/sbin/lsof", ["-nP", "-w", "-t", "+D", root], { encoding: "utf8" });
        if (scan.error || ![0, 1].includes(scan.status) || scan.stderr.trim()
          || scan.stdout.trim().split(/\s+/).some((pid) => pid && Number(pid) !== process.pid)) continue;
        rmSync(root, { recursive: true });
        removed.push(id);
      } catch {}
      finally { if (descriptor !== undefined) closeSync(descriptor); }
    }
    return removed;
  });
}

function publishRuntime(source, store) {
  const manifest = verifyRuntime(source);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  const target = join(realpathSync(store), manifest.id);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error(`运行时目标不能是链接：${target}`);
    verifyRuntime(target, manifest.id);
    activateRuntime(store, manifest.id);
    return target;
  }
  const stage = join(store, `.installing-${randomUUID()}`);
  try {
    cpSync(source, stage, { recursive: true, verbatimSymlinks: true });
    verifyRuntime(stage, manifest.id);
    try { renameSync(stage, target); }
    catch (error) {
      if (!existsSync(target) || lstatSync(target).isSymbolicLink()) throw error;
      verifyRuntime(target, manifest.id);
    }
    activateRuntime(store, manifest.id);
    return target;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, source, store] = process.argv.slice(2);
    if (operation === "seal" && source) console.log(sealRuntime(source).id);
    else if (operation === "install" && source && store) console.log(installRuntime(source, store));
    else if (operation === "activate" && source && store) selectRuntime(source, store);
    else if (operation === "gc" && source) console.log(JSON.stringify(collectRuntimes(source)));
    else throw new Error("usage: runtime-store.mjs seal <runtime> | install <runtime> <store>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import { existsSync, lstatSync, mkdtempSync, readFileSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { cleanupTestResourcesSync } from "./test-process-resources.mjs";

export function directoryOwnershipError(directory) {
  return Object.assign(new Error(`拒绝清理无法确认归属的测试执行域目录: ${directory}`), { code: "EOWNERSHIP", directory });
}

function directoryIdentity(directory) {
  try {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw directoryOwnershipError(directory);
    return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function sameDirectory(expected, actual) {
  return expected && actual && expected.dev === actual.dev && expected.ino === actual.ino;
}

function copyOwnership(directory, ownership) {
  if (!ownership) return null;
  const validIdentity = (identity) => identity && /^\d+$/.test(identity.dev) && /^\d+$/.test(identity.ino)
    && typeof identity.dev === "string" && typeof identity.ino === "string";
  if (typeof ownership.token !== "string" || !/^[a-f0-9]{64}$/.test(ownership.token)
    || typeof ownership.record !== "string" || basename(ownership.record) !== "ownership.json"
    || dirname(dirname(resolve(ownership.record))) !== resolve(tmpdir())
    || !/^ash-test-owner-[A-Za-z0-9]{6}$/.test(basename(dirname(ownership.record)))
    || !validIdentity(ownership.directoryIdentity) || !validIdentity(ownership.recordDirectoryIdentity)) {
    throw directoryOwnershipError(directory);
  }
  return Object.freeze({ token: ownership.token, record: resolve(ownership.record),
    directoryIdentity: Object.freeze({ ...ownership.directoryIdentity }),
    recordDirectoryIdentity: Object.freeze({ ...ownership.recordDirectoryIdentity }) });
}

function verifyOwnership(directory, ownership) {
  if (!ownership || !sameDirectory(ownership.recordDirectoryIdentity, directoryIdentity(dirname(ownership.record)))) {
    throw directoryOwnershipError(directory);
  }
  const stat = lstatSync(ownership.record);
  if (!stat.isFile() || stat.isSymbolicLink()) throw directoryOwnershipError(directory);
  const record = JSON.parse(readFileSync(ownership.record, "utf8"));
  if (!record || record.directory !== directory || record.token !== ownership.token
    || !sameDirectory(ownership.directoryIdentity, record.directoryIdentity)) throw directoryOwnershipError(directory);
}

export class TestDirectory {
  constructor(directory, ownership, prefix) {
    const owned = directory === undefined;
    this.path = resolve(directory ?? mkdtempSync(prefix ?? join(tmpdir(), "ash-test-scope-")));
    let recordDirectory;
    try {
      const identity = directoryIdentity(this.path);
      if (owned) {
        writeFileSync(join(this.path, "started"), String(Date.now()), { flag: "wx" });
        recordDirectory = mkdtempSync(join(tmpdir(), "ash-test-owner-"));
        this.ownership = copyOwnership(this.path, { token: randomBytes(32).toString("hex"),
          record: join(recordDirectory, "ownership.json"), directoryIdentity: identity,
          recordDirectoryIdentity: directoryIdentity(recordDirectory) });
        writeFileSync(this.ownership.record, JSON.stringify({ directory: this.path, token: this.ownership.token,
          directoryIdentity: identity }), { flag: "wx", mode: 0o600 });
      } else this.ownership = copyOwnership(this.path, ownership);
      this.identity = identity ?? this.ownership?.directoryIdentity ?? null;
      if (identity && (!this.ownership || !sameDirectory(this.ownership.directoryIdentity, identity))) throw directoryOwnershipError(this.path);
      if (identity || (this.ownership && existsSync(this.ownership.record))) verifyOwnership(this.path, this.ownership);
      Object.freeze(this);
    } catch (error) {
      if (owned) cleanupTestResourcesSync([
        () => rmSync(this.path, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }),
        () => { if (recordDirectory) rmSync(recordDirectory, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 }); },
      ], error);
      throw error;
    }
  }

  assertOwnership() {
    const identity = directoryIdentity(this.path);
    if (!identity) return;
    if (!sameDirectory(this.identity, identity)) throw directoryOwnershipError(this.path);
    verifyOwnership(this.path, this.ownership);
  }

  remove() {
    this.assertOwnership();
    rmSync(this.path, { recursive: true, force: true, maxRetries: 50, retryDelay: 20 });
    if (!this.ownership) return;
    if (existsSync(this.ownership.record)) {
      verifyOwnership(this.path, this.ownership);
      unlinkSync(this.ownership.record);
    }
    const recordDirectory = dirname(this.ownership.record);
    const identity = directoryIdentity(recordDirectory);
    if (identity) {
      if (!sameDirectory(this.ownership.recordDirectoryIdentity, identity)) throw directoryOwnershipError(this.path);
      rmdirSync(recordDirectory, { maxRetries: 50, retryDelay: 20 });
    }
  }
}

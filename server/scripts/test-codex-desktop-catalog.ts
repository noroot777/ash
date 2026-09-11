import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pruneArchivedCodexDesktopThreads } from "../src/executors/codex-desktop-catalog.js";

const root = mkdtempSync(join(tmpdir(), "ash-codex-catalog-"));
const home = join(root, "用户 Codex");
const rolloutName = (id: string) => `rollout-2026-09-11T10-00-00-${id}.jsonl`;
const content = (id: string) => JSON.stringify({ type: "session_meta", payload: { id } }) + "\n";
function rollout(id: string, archived = true) {
  const dir = join(home, archived ? "archived_sessions" : "sessions", "2026", "09", "11");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, rolloutName(id)), content(id));
}

try {
  assert.deepEqual(await pruneArchivedCodexDesktopThreads(["ash-root"], home), []);
  assert.equal(existsSync(home), false, "没有 Desktop 时不新建目录或数据库");
  mkdirSync(join(home, "sqlite"), { recursive: true });
  for (const id of ["ash-root", "ash-child", "user-thread", "resumed", "unseen-child"]) rollout(id);
  rollout("resumed", false);
  rollout("active", false);
  const files = ["codex.db", "codex-dev.db"].map((name) => join(home, "sqlite", name));
  for (const file of files) {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, missing_candidate INTEGER DEFAULT 0,
        display_title TEXT, PRIMARY KEY(host_id, thread_id));
      CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, observation_sequence INTEGER);
      CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER);
      CREATE TABLE local_thread_catalog_scan_checkpoints (host_id TEXT PRIMARY KEY, checkpoint TEXT);
      CREATE TABLE local_thread_catalog_scan_entries (host_id TEXT, thread_id TEXT, removed INTEGER,
        PRIMARY KEY(host_id, thread_id));
      CREATE TABLE automations (id TEXT PRIMARY KEY, prompt TEXT);
      INSERT INTO automations VALUES ('user-automation', 'preserve');
      INSERT INTO local_thread_catalog_sync_state VALUES ('local', 42), ('remote', 77);
      INSERT INTO local_thread_catalog_metadata VALUES (1, 10);
      INSERT INTO local_thread_catalog_scan_checkpoints VALUES ('local', 'in-flight-page');
    `);
    for (const id of ["ash-root", "ash-child", "user-thread", "active", "resumed", "missing-rollout"]) {
      db.prepare("INSERT INTO local_thread_catalog VALUES ('local', ?, 0, ?)").run(id, id);
    }
    db.prepare("INSERT INTO local_thread_catalog VALUES ('remote', 'ash-root', 0, 'remote user')").run();
    db.close();
  }
  const result = await pruneArchivedCodexDesktopThreads(
    ["ash-root", "ash-child", "ash-root", "active", "resumed", "missing-rollout", "unseen-child"], home,
  );
  assert.equal(result.length, 2);
  for (const { database, removedThreadIds } of result) {
    assert.deepEqual(removedThreadIds, ["ash-root", "ash-child"]);
    // 重新打开持久库模拟 Desktop 下次启动的列表读取，不依赖进程内缓存。
    const db = new DatabaseSync(database, { readOnly: true });
    const remaining = db.prepare("SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local' ORDER BY thread_id").all();
    assert.deepEqual(remaining.map((r) => r.thread_id), ["active", "missing-rollout", "resumed", "user-thread"]);
    assert.equal(db.prepare("SELECT count(*) n FROM local_thread_catalog WHERE host_id = 'remote'").get()?.n, 1);
    assert.equal(db.prepare("SELECT prompt FROM automations").get()?.prompt, "preserve");
    assert.equal(db.prepare("SELECT observation_sequence n FROM local_thread_catalog_sync_state WHERE host_id = 'remote'").get()?.n, 77);
    assert.equal(db.prepare("SELECT catalog_revision n FROM local_thread_catalog_metadata").get()?.n, 11);
    assert.deepEqual(db.prepare("SELECT thread_id FROM local_thread_catalog_scan_entries WHERE removed = 1 ORDER BY thread_id").all().map((r) => r.thread_id),
      ["ash-child", "ash-root", "unseen-child"], "归档 tombstone 也覆盖扫描尚未入库的子会话");
    assert.equal(db.prepare("SELECT checkpoint FROM local_thread_catalog_scan_checkpoints").get()?.checkpoint, "in-flight-page");
    db.close();
  }
  for (const id of ["ash-root", "ash-child", "user-thread", "resumed"]) {
    assert.equal(readFileSync(join(home, "archived_sessions", "2026", "09", "11", rolloutName(id)), "utf8"), content(id));
  }
  console.log("✓ 持久侧栏清理覆盖正式/开发版；保留用户、活动、已恢复、远端会话和自动化");

  for (const file of files) {
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM local_thread_catalog_scan_checkpoints");
    db.close();
  }
  assert.deepEqual(await pruneArchivedCodexDesktopThreads(["ash-root"], home), [], "重复清理无写入");
  console.log("✓ 重复清理幂等，扫描中的删除标记防止旧页回灌");

  const broken = new DatabaseSync(files[0]!);
  broken.exec("INSERT INTO local_thread_catalog VALUES ('local', 'ash-root', 0, 'restore'); DELETE FROM local_thread_catalog_metadata;");
  const before = broken.prepare("SELECT observation_sequence n FROM local_thread_catalog_sync_state WHERE host_id='local'").get()?.n;
  await assert.rejects(pruneArchivedCodexDesktopThreads(["ash-root"], home), /版本记录缺失/);
  assert.ok(broken.prepare("SELECT 1 FROM local_thread_catalog WHERE host_id='local' AND thread_id='ash-root'").get());
  assert.equal(broken.prepare("SELECT observation_sequence n FROM local_thread_catalog_sync_state WHERE host_id='local'").get()?.n, before);
  broken.exec("ALTER TABLE local_thread_catalog RENAME COLUMN missing_candidate TO incompatible_column");
  await assert.rejects(pruneArchivedCodexDesktopThreads(["ash-root"], home), /索引清理失败/);
  broken.close();
  console.log("✓ 不兼容 schema / 缺失元数据失败回滚，不误报完成");
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

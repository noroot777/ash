import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexHome, findArchivedRollout, findRollout } from "./codex-rollout.js";

type CatalogCleanup = { database: string; removedThreadIds: string[] };

/**
 * Desktop 26.903 的最近聊天来自独立的持久 catalog。另一个 app-server 的归档通知
 * 不会送到 Desktop；启动时的增量扫描也不会删除旧条目。这里补齐其 authoritative
 * removal 的索引事务，原生 rollout / state 数据库仍只交给 thread/archive 管理。
 */
export async function pruneArchivedCodexDesktopThreads(
  threadIds: readonly string[], configDir?: string,
): Promise<CatalogCleanup[]> {
  const results: CatalogCleanup[] = [];
  for (const name of ["codex.db", "codex-dev.db"]) {
    const database = join(codexHome(configDir), "sqlite", name);
    if (!existsSync(database)) continue;
    const db = new DatabaseSync(database);
    try {
      db.exec("PRAGMA busy_timeout = 1000");
      if (!hasTable(db, "local_thread_catalog")) continue;
      // 预编译检查已有 schema；不迁移第三方数据库。版本不兼容时由调用方记录 notice。
      const lookup = db.prepare("SELECT missing_candidate FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
      const remove = db.prepare("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
      const bumpSequence = db.prepare("UPDATE local_thread_catalog_sync_state SET observation_sequence = observation_sequence + 1 WHERE host_id = 'local'");
      const bumpRevision = db.prepare("UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1");
      const hasCheckpoints = hasTable(db, "local_thread_catalog_scan_checkpoints");
      const hasEntries = hasTable(db, "local_thread_catalog_scan_entries");
      if (hasCheckpoints !== hasEntries) throw new Error("Desktop catalog 扫描表不兼容");
      const checkpoint = hasCheckpoints
        ? db.prepare("SELECT 1 FROM local_thread_catalog_scan_checkpoints WHERE host_id = 'local'") : null;
      const tombstone = hasEntries ? db.prepare(`
        INSERT INTO local_thread_catalog_scan_entries (host_id, thread_id, removed) VALUES ('local', ?, 1)
        ON CONFLICT(host_id, thread_id) DO UPDATE SET removed = 1
      `) : null;
      const candidates: { id: string; archive: string }[] = [];
      for (const id of new Set(threadIds)) {
        if (!lookup.get(id) && !checkpoint?.get()) continue;
        const archive = await findArchivedRollout(id, configDir);
        // 已恢复或仍有活动副本的会话不隐藏；也不处理同名远端 host 的条目。
        if (archive && await findRollout(id, configDir) === archive) candidates.push({ id, archive });
      }
      if (!candidates.length) continue;
      const removedThreadIds: string[] = [];
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { id, archive } of candidates) {
          if (!existsSync(archive)) continue;
          if (bumpSequence.run().changes !== 1) throw new Error("Desktop catalog 本地同步状态缺失");
          // 正在进行的扫描可能已拿到旧页；removed 标记防止它把归档条目重新插入。
          if (checkpoint?.get()) tombstone!.run(id);
          if (remove.run(id).changes) removedThreadIds.push(id);
        }
        if (removedThreadIds.length && bumpRevision.run().changes !== 1) {
          throw new Error("Desktop catalog 版本记录缺失");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      results.push({ database, removedThreadIds });
    } catch (error) {
      throw new Error(`Codex 已归档，但桌面最近聊天索引清理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { db.close(); }
  }
  return results;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { handoffLocalKeyRevisions } from "../db/schema.js";
import { HandoffError } from "../handoff-types.js";
import { id } from "../util.js";

export async function localKeyRevision(connection: Pick<typeof db, "select">, url: string): Promise<string | null> {
  const [row] = await connection.select().from(handoffLocalKeyRevisions).where(eq(handoffLocalKeyRevisions.url, url));
  return row?.revision ?? null;
}

export function staleKeySave(): HandoffError {
  return new HandoffError("目标机或账号 key 在保存期间已变更，本次 key 未保存。请刷新设置或任务后重试。", 409);
}

export async function checkLocalKeyRevision(
  connection: Pick<typeof db, "select">, url: string, expected: string | null,
): Promise<void> {
  if (await localKeyRevision(connection, url) !== expected) throw staleKeySave();
}

// 删除凭证后仍保留不含密钥的版本，区分删除前后同一地址的两次使用。
export async function changeLocalKeyRevisions(connection: Pick<typeof db, "insert">, urls: Iterable<string>): Promise<void> {
  for (const url of new Set(urls)) {
    const revision = id();
    await connection.insert(handoffLocalKeyRevisions).values({ url, revision })
      .onConflictDoUpdate({ target: handoffLocalKeyRevisions.url, set: { revision } });
  }
}

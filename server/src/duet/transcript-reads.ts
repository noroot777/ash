// 讨论时间线的**读取**:落盘的 `transcript.jsonl` → 前端那份回合列表,顺带把这些回合里
// 的图补上任务归属。
//
// 为什么回填长在读这一侧、以及那两条边界(只认回合自己记下的那份清单,正文里的路径一个
// 都不认),写在 `uploads.ts` 的 `backfillArtifactUploads` 上 —— 会话 trace 那条读取路径
// 用的是同一道(审查第 3 轮 R4 是类问题)。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnImageRef } from "@ash/shared";
import { RUNS_DIR } from "../paths.js";
import { readableRunPath } from "../transcript.js";
import { backfillArtifactUploads } from "../uploads.js";

type PersistedTurn = { type?: unknown; images?: TurnImageRef[] };

/** 老记录早于 debate→duet 改名 —— 在这里归一,前端 reducer 只见 `duet.*`。 */
function normalizeType(turn: PersistedTurn): PersistedTurn {
  return typeof turn?.type === "string" && turn.type.startsWith("debate.")
    ? { ...turn, type: `duet.${turn.type.slice("debate.".length)}` }
    : turn;
}

export async function readDuetTurns(taskId: string): Promise<PersistedTurn[]> {
  let turns: PersistedTurn[];
  try {
    const raw = await readFile(readableRunPath(join(RUNS_DIR, taskId, "transcript.jsonl")), "utf8");
    turns = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as PersistedTurn).map(normalizeType);
  } catch {
    return [];
  }
  // 回合自己记下的那份清单(`images[].path`)—— 正文里的路径一个都不认。
  await backfillArtifactUploads(
    taskId,
    turns.flatMap((turn) => Array.isArray(turn?.images) ? turn.images.map((image) => image?.path) : []),
  );
  return turns;
}

// 讨论时间线的**读取**:落盘的 `transcript.jsonl` → 前端那份回合列表,顺带把这些回合里
// 的图补上任务归属。
//
// 为什么回填长在读这一侧:登记只发生在**刚写下这些字节**的那一刻(`noteAgentEventUpload`
// 挂在公共广播口上),而那一道是 2026-10-21 才补的 —— 在它之前落盘的讨论回合,图还好好躺
// 在 `data/uploads/` 里、回合记录里也写着它的路径,唯独 `uploads` 那一行没有 taskId。按
// `canReadUpload` 的判据那就是「无主资产」:多人模式下同项目的普通成员重新打开那条讨论,
// 结论看得到、图一律 404(跟「文件不存在」同一句话),而且**没有新广播就永远不会恢复**
// (审查第 3 轮 R4)。转多人时的 `claimExistingUploads` 也补不到:它只扫任务正文,讨论者
// 后来生成的图只出现在回合的 `images` 里。
//
// 两条边界:
//   · **只认回合自己记下的那份清单**(`images[].path`)。正文里的路径一个都不认 —— 那等于
//     开一条「引用即认领」的路(`bindUploadsToTask` 的注释里有这条的推演)。这份清单是服
//     务端自己复制那张图时写下的,信任级别跟广播口那一道完全相同。
//   · 再经 `uploadNameOf` 核一遍「它真落在 uploads 目录直下」,然后才登记;`registerUpload`
//     本身只补空位,别人名下的行一个字都不动。所以这一道可重入、也夺不走任何归属。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnImageRef } from "@ash/shared";
import { RUNS_DIR } from "../paths.js";
import { readableRunPath } from "../transcript.js";
import { registerUpload, uploadNameOf } from "../uploads.js";

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
  await backfillTurnUploads(taskId, turns);
  return turns;
}

/** 这些回合里的图,归属补齐(可重入;登记失败只 warn —— 不该让读时间线整条失败)。 */
async function backfillTurnUploads(taskId: string, turns: PersistedTurn[]): Promise<void> {
  const names = new Set<string>();
  for (const turn of turns) {
    if (!Array.isArray(turn?.images)) continue;
    for (const image of turn.images) {
      const name = typeof image?.path === "string" ? uploadNameOf(image.path) : null;
      if (name) names.add(name);
    }
  }
  for (const name of names) {
    try {
      await registerUpload(name, { taskId });
    } catch (error) {
      console.warn("[ash] 讨论图片归属回填失败:", error);
    }
  }
}

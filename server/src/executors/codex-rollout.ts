// 从 codex 的 rollout 文件里读**上下文水位**。
//
// 为什么非得读文件：codex `exec --json` 的 stdout 只有五种事件，带账的只有
// `turn.completed`，而它给的是**整回合累加**的流水（`input_tokens` 能到几百万）。
// 水位是「此刻上下文里装了多少」，stdout 里一个字都没有。
//
// codex 自己把每次 API 调用后的快照写进了 rollout 文件：
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<thread_id>.jsonl
//   {"type":"event_msg","payload":{"type":"token_count","info":{
//      "last_token_usage":{"input_tokens":47393,"cached_input_tokens":35328,...},
//      "model_context_window":353400}}}
// `last_token_usage.input_tokens` **已含** cached（跟 codexUsage 里那条注释同源），
// 就是最近一次调用的 prompt 规模；`model_context_window` 是 codex **自报**的窗口，
// 比按模型名猜的准，所以 codex 这条路 windowEstimated 恒为 false。
//
// 这是对 codex 私有文件格式的耦合，它升级换格式我们就读不到了。三条兜底：
// 整个模块 best-effort（任何异常都返回 null，绝不影响 agent 的执行结果）、
// 拿不到就当没这个功能（界面不显示水位，而不是显示 0），字段全部当 unknown 校验。
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ContextUsage } from "@harness/shared";

/** 只回读文件尾部这么多字节。rollout 动辄 1.5MB，而我们只要最后一条 token_count。 */
const TAIL_BYTES = 512 * 1024;

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

/**
 * 按 thread_id 找 rollout 文件。目录是 `sessions/YYYY/MM/DD/`，**按名字倒序**逐层
 * 下钻——会话都是新的，倒着找通常第一层就命中，不用整棵树扫一遍。
 */
async function findRollout(threadId: string): Promise<string | null> {
  const root = path.join(codexHome(), "sessions");
  const suffix = `-${threadId}.jsonl`;

  const descend = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null; // 目录不存在/没权限：这台机器上就没有 codex 的 rollout
    }
    if (depth === 3) {
      const hit = entries.find((e) => e.isFile() && e.name.endsWith(suffix));
      return hit ? path.join(dir, hit.name) : null;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    for (const name of dirs) {
      const found = await descend(path.join(dir, name), depth + 1);
      if (found) return found;
    }
    return null;
  };

  return descend(root, 0);
}

/** 读文件尾部若干字节，返回**完整的行**（掐头：第一行多半被切断了）。 */
async function tailLines(file: string): Promise<string[]> {
  const { size } = await stat(file);
  const start = Math.max(0, size - TAIL_BYTES);
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start })) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks).toString("utf8").split("\n");
  if (start > 0) lines.shift();
  return lines;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 读这条 thread 的上下文水位。找不到文件、没有 token_count、解析失败一律 null
 * ——「没采到」和「水位是 0」是两回事，调用方据此决定不显示。
 */
export async function readCodexContext(threadId: string): Promise<ContextUsage | null> {
  if (!threadId) return null;
  try {
    const file = await findRollout(threadId);
    if (!file) return null;
    const lines = await tailLines(file);
    // 从后往前找最后一条：中间那些是过程快照，只有最新的才是「此刻」。
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"token_count"')) continue;
      let info: any;
      try {
        info = JSON.parse(line)?.payload?.info;
      } catch {
        continue; // 半截行/脏行，往前接着找
      }
      const used = num(info?.last_token_usage?.input_tokens);
      if (used <= 0) continue;
      const window = num(info?.model_context_window);
      return { used, window: window > 0 ? window : null, windowEstimated: false };
    }
    return null;
  } catch (error) {
    console.warn(`[harness] failed to read codex context for thread ${threadId}:`, error);
    return null;
  }
}

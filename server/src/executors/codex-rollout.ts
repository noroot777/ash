// 从 Codex 的 rollout 文件里读**当前上下文水位**。
//
// `codex exec --json` 的公开 stdout 只有整回合累计 usage；最近一次模型调用实际
// 装了多少输入，只写在 ~/.codex/sessions/.../rollout-*.jsonl 的 token_count 里。
// 这是私有格式，所以本模块必须失败关闭：布局、事件名或字段一旦变化就返回 null，
// 绝不让读取失败影响任务，更不能退回上一回合的旧值冒充当前水位。
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ContextUsage } from "@ash/shared";

/** rollout 可能很大；最新 token_count 通常就在文件尾部。找不到就安全退化成无水位。 */
const TAIL_BYTES = 512 * 1024;

type ParseOutcome =
  | { kind: "context"; value: ContextUsage }
  | { kind: "missing" }
  | { kind: "incompatible"; reason: string };

const warnedThreads = new Set<string>();
const cliVersionCache = new Map<string, string>();
const CLI_VERSION_SCAN_LINES = 32;

/**
 * codex 的配置目录。`configDir` 是**这条任务的归属人**那一份(多用户模式下起跑注入的
 * `CODEX_HOME`,见 `auth/run-env.ts` 的 cliConfigDirForOwner);不传就是 server 自己
 * 环境里的那份,也就是自用模式的宿主机默认目录。
 */
export function codexHome(configDir?: string | null): string {
  return configDir?.trim() || process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

/**
 * 按 thread id 找 rollout。当前布局是 sessions/YYYY/MM/DD/；布局变化时找不到即 null。
 * 倒序下钻让活跃会话通常在前几个目录内命中，避免每轮完整扫描所有历史文件。
 * （任务接力 handoff.ts 也用它定位要搬走的会话文件，那条路要按任务归属人传 configDir。）
 */
export async function findRollout(threadId: string, configDir?: string | null): Promise<string | null> {
  const root = path.join(codexHome(configDir), "sessions");
  const suffix = `-${threadId}.jsonl`;

  const descend = async (dir: string, depth: number): Promise<string | null> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    if (depth === 3) {
      const hit = entries.find((entry) => entry.isFile() && entry.name.endsWith(suffix));
      return hit ? path.join(dir, hit.name) : null;
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of dirs) {
      const found = await descend(path.join(dir, name), depth + 1);
      if (found) return found;
    }
    return null;
  };

  return descend(root, 0);
}

/** 只返回完整行；从文件中间切入时第一行通常是半截 JSON，必须丢掉。 */
async function tailLines(file: string): Promise<string[]> {
  const { size } = await stat(file);
  if (size <= 0) return [];
  const start = Math.max(0, size - TAIL_BYTES);
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start })) chunks.push(chunk as Buffer);
  const lines = Buffer.concat(chunks).toString("utf8").split("\n");
  if (start > 0) lines.shift();
  return lines;
}

export function parseCodexCliVersionLine(line: string, threadId?: string): string | null {
  let row: any;
  try {
    // PowerShell/编辑器偶尔会在文件开头留下 BOM；JSON.parse 不接受它，但这不该让
    // 后面的合法 session_meta 一起失效。
    row = JSON.parse(line.trimStart());
  } catch {
    return null;
  }
  const sessionId = row?.payload?.session_id;
  if (row?.type !== "session_meta" || typeof sessionId !== "string" || (threadId && sessionId !== threadId)) return null;
  return typeof row.payload?.cli_version === "string" && row.payload.cli_version.trim()
    ? row.payload.cli_version.trim()
    : null;
}

/**
 * 这条会话是哪个版本的 Codex 建的。`configDir` 同 `findRollout` —— **多用户模式下必须
 * 传**:CLI 起跑时注入的是归属人那份 `CODEX_HOME`,rollout 就写在
 * `data/user-cli/<owner>/codex/sessions/…`,拿宿主机默认目录去找是找不到的(而找不到
 * 一律 fail-open 返回 null,于是起跑前的版本守卫会静默放行受影响的会话)。
 */
export async function readCodexCliVersion(threadId: string, configDir?: string | null): Promise<string | null> {
  if (!threadId) return null;
  const cached = cliVersionCache.get(threadId);
  if (cached) return cached;
  try {
    const file = await findRollout(threadId, configDir);
    if (!file) return null;
    const stream = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let inspected = 0;
    try {
      for await (const line of lines) {
        inspected += 1;
        if (!line.trim()) {
          if (inspected >= CLI_VERSION_SCAN_LINES) return null;
          continue;
        }
        const version = parseCodexCliVersionLine(line, threadId);
        if (version) {
          cliVersionCache.set(threadId, version);
          return version;
        }
        // session_meta 应在文件开头；只容忍少量空行/旁注/格式噪声，避免坏文件触发
        // 对整份巨大 rollout 的线性扫描。
        if (inspected >= CLI_VERSION_SCAN_LINES) return null;
      }
      return null;
    } finally {
      lines.close();
      stream.destroy();
    }
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseOutcome(lines: string[], notBeforeMs: number): ParseOutcome {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim();
    if (!line.includes('"token_count"')) continue;

    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      // 最新候选已经坏了时绝不能继续向前捞一个旧值。
      return { kind: "incompatible", reason: "token_count JSON 无法解析" };
    }
    // 工具输出正文里也可能出现 token_count 字样；只有真实事件才算候选。
    if (row?.payload?.type !== "token_count") continue;
    if (row?.type !== "event_msg") {
      return { kind: "incompatible", reason: "token_count 顶层事件类型已变化" };
    }

    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
    if (!Number.isFinite(at)) return { kind: "incompatible", reason: "token_count 缺少有效时间戳" };
    // 当前回合没有旧格式事件，说明格式可能已经变化。停在这里返回无值，不能拿上一轮顶上。
    if (at < notBeforeMs) return { kind: "missing" };

    const used = positiveInteger(row.payload?.info?.last_token_usage?.input_tokens);
    const window = positiveInteger(row.payload?.info?.model_context_window);
    if (!used || !window || used > window) {
      return { kind: "incompatible", reason: "token_count 水位字段缺失或数值不可信" };
    }
    return {
      kind: "context",
      value: { used, window, windowEstimated: false },
    };
  }
  return { kind: "missing" };
}

/** 纯解析入口供回归测试使用；任何不兼容形状都只返回 null。 */
export function parseCodexContextLines(lines: string[], notBeforeMs = 0): ContextUsage | null {
  const outcome = parseOutcome(lines, Math.max(0, notBeforeMs));
  return outcome.kind === "context" ? outcome.value : null;
}

/**
 * 读取该 thread 在**本回合**产生的最新水位。notBeforeMs 是回合启动时间：它既防止
 * 格式变化后误用上一轮旧值，也让缺失/损坏自然退化成“不显示水位”。
 * `configDir` 同上:这一轮的 CLI 往哪个 `CODEX_HOME` 写,就得去哪儿读(多用户模式下
 * 那是归属人的个人目录);拿宿主机默认目录去读,水位会静默恒为空。
 */
export async function readCodexContext(
  threadId: string,
  notBeforeMs = 0,
  configDir?: string | null,
): Promise<ContextUsage | null> {
  if (!threadId) return null;
  try {
    const file = await findRollout(threadId, configDir);
    if (!file) return null;
    const outcome = parseOutcome(await tailLines(file), Math.max(0, notBeforeMs));
    if (outcome.kind === "context") return outcome.value;
    if (outcome.kind === "incompatible" && !warnedThreads.has(threadId)) {
      warnedThreads.add(threadId);
      console.warn(`[ash] Codex rollout 格式不兼容，已停用该会话的上下文水位：${outcome.reason}`);
    }
    return null;
  } catch (error) {
    // 私有诊断文件读失败不能改变 agent 的执行结果；没有水位比错误水位安全。
    console.warn(`[ash] failed to read Codex context for thread ${threadId}:`, error);
    return null;
  }
}

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecTarget } from "@harness/shared";

// Profile 参数编辑器按 token 存储，但历史配置和整段粘贴可能留下
// ["--settings ~/path.json"]。直接 spawn 不经过 shell：它既不会拆词，也不会展开 ~。
// 只兼容“明显以 flag 开头且后面还有值”的项，避免误拆 --define=a value 这类
// 本来就可能需要保留空格的单 token。
function splitCombinedFlag(value: string): string[] {
  if (!/^--?[^\s=]+\s+/.test(value)) return [value];

  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  // 不完整的粘贴宁可原样交给 CLI 报错，也不猜引号本意。
  if (quote || escaped) return [value];
  if (started) words.push(current);
  return words.length > 1 ? words : [value];
}

function expandLocalHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function normalizeProfileExtraArgs(values: unknown, target: ExecTarget): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => {
      const trimmed = value.trim();
      return trimmed ? splitCombinedFlag(trimmed) : [];
    })
    .map((value) => target.kind === "local" ? expandLocalHome(value) : value);
}

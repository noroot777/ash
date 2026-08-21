// Profile 参数编辑器按 token 存储，但历史配置和整段粘贴可能留下
// ["--settings ~/path.json"]。直接 spawn 不经过 shell：它既不会拆词，也不会展开 ~。
// 只兼容“明显以 flag 开头且后面还有值”的项，避免误拆 --define=a value 这类
// 本来就可能需要保留空格的单 token。
//
// 放在 shared 而不是 server：**执行器拆词、前端判「这条参数会不会顶掉别的配置」，
// 必须是同一份拆法**。前端只按原始 token 判、执行器拆完再拼命令的话，
// `["--settings {}"]` 这种在页面上看不出冲突、跑起来却把 ash 那份 `--settings`
// 整份顶掉（claude 只认最后一个），设置页照旧显示「已覆盖 200k · 80%」。
// 这里只放纯字符串逻辑：`~` 展开要读 homedir，是 server 那侧的事。
export function splitCombinedFlag(value: string): string[] {
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

/** 存库的那份额外参数拆成 CLI 真正会收到的 token 序列（不含 `~` 展开）。 */
export function splitProfileExtraArgs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .flatMap((value) => {
      const trimmed = value.trim();
      return trimmed ? splitCombinedFlag(trimmed) : [];
    });
}

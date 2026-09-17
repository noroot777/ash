/**
 * 从 CLI 的整段输出里取出最终那个 JSON 对象。
 *
 * 边界靠**括号配平**定位，不靠「切到文本末尾再 JSON.parse」——后者对尾随字符零容忍，
 * 模型输出完 JSON 再补一句「还需要我继续吗」就整轮解析失败，而那句话恰恰是它最常见的
 * 收尾习惯（实测：`{...}` 后多一个字符即失败；往前找到的更早 `{` 同样拖着那段尾巴，
 * 一个都救不回来）。
 *
 * 扫描从左往右、只认**顶层**对象：配平成功就把游标跳过整个对象，所以 forward 这类嵌套
 * 内层对象不会被单独取走（取最后一个内层对象会得到没有 reply 字段的半截结果——旧实现
 * 是靠「切到结尾必然多一个 `}`」隐式排除它的，换成配平后必须显式跳过）。取最后一个顶层
 * 对象，保留「先输出说明、再输出最终 JSON」的既有行为。
 */
export function parseLastJsonObject(text: string): Record<string, unknown> | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  let found: Record<string, unknown> | undefined;
  for (let index = 0; index < cleaned.length; index++) {
    if (cleaned[index] !== "{") continue;
    const end = objectEnd(cleaned, index);
    // 配不平只说明「从这个 `{` 到结尾闭合不了」，后面某个 `{` 仍可能是完整对象（正文里
    // 出现过孤立的左括号就是这种），所以往后找而不是就此收手。
    if (end === undefined) continue;
    try {
      const value: unknown = JSON.parse(cleaned.slice(index, end + 1));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        found = value as Record<string, unknown>;
        index = end;
      }
    } catch { /* 正文里的伪 JSON 片段（举例、代码块）解析不出来，继续往后找。 */ }
  }
  return found;
}

/** `text[start]` 这个 `{` 配平到的 `}` 的下标；字符串字面量里的括号不计数。 */
function objectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return undefined;
}

/**
 * 解析失败时附在错误正文后的原始输出摘要。这一轮往往是工具跑了十几次之后才倒在终点上，
 * 而原始输出既不落库也不落 runs 目录，不随错误带出来，事后就只能靠反推。
 */
export function rawOutputExcerpt(text: string, limit = 600): string {
  const trimmed = text.trim();
  if (!trimmed) return "\n\n（智能体没有输出任何正文。）";
  const shown = trimmed.length > limit ? `${trimmed.slice(0, limit)}…（原文共 ${trimmed.length} 字）` : trimmed;
  return `\n\n【智能体原始输出，供排查】\n${shown}`;
}

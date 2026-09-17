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
 * 是靠「切到结尾必然多一个 `}`」隐式排除它的，换成配平后必须显式跳过）。
 *
 * 候选由 `accept` 挑，不是无脑取最后一个：尾随说明里再出现一个对象示例（「备注：格式形如
 * {"foo":"bar"}」）时，最后一个对象是那个示例，真正的最终回复排在它前面。不按目标形状筛
 * 就会拿示例覆盖回复——群聊照样报「未返回有效回复」，侧聊更糟：明明有合法 JSON 却降级成
 * 展示原文，连本轮的 forward 回传能力一起丢掉。所以调用方传入自己那份形状判据，取**最后
 * 一个满足判据**的顶层对象；不传则保持「最后一个对象」的旧行为。
 */
export function parseLastJsonObject(
  text: string,
  accept: (value: Record<string, unknown>) => boolean = () => true,
): Record<string, unknown> | undefined {
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
        // 跳过整个对象要无条件做：即便它不满足 accept，它的内层也不该被当成顶层候选。
        index = end;
        if (accept(value as Record<string, unknown>)) found = value as Record<string, unknown>;
      }
    } catch { /* 正文里的伪 JSON 片段（举例、代码块）解析不出来，继续往后找。 */ }
  }
  return found;
}

/** 常用判据：某个字段是非空字符串。 */
export const textField = (key: string) => (value: Record<string, unknown>): boolean =>
  typeof value[key] === "string" && value[key].trim().length > 0;

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

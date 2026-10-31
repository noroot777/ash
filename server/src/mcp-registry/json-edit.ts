// JSON / JSONC 的**最小无损编辑**:只插入我们那一条,别的字节一个不动。
//
// 为什么不能 `JSON.parse` → 改 → `JSON.stringify`(本轮审查 R4):那条往返**不是无损的**,
// 而这个任务的硬约束恰恰是「只在缺 ash 条目时追加,绝不动其它条目」。往返会悄悄改掉用户保存
// 的值:
//  · `9007199254740993` 超出 JS 安全整数 ⇒ 写回去变成 `…992`(第三方工具拿到的是另一个编号);
//  · `1e999` ⇒ `Infinity` ⇒ `JSON.stringify` 写成 `null`;`-0` ⇒ `0`;重复键只剩最后一个;
//  · 注释、缩进、键序全没了(上一版因此干脆**拒绝**改写带注释的配置,用户只能手工接)。
//  回读那一步也兜不住:它只看 ash 在不在,而损失已经发生在候选正文里了。
//
// 所以这里走**文本插入**:把容器对象的 `{` 找出来,在它后面插一行我们的登记,其余原文按字节
// 保留。代价是要自己认一遍 JSON 文本(下面那个小解析器带位置),收益是「只改我们那一条」从
// 一句承诺变成了结构上的事实 —— 插入点之外的字节根本没经过序列化器。
//
// 顺带:既然不再重新序列化,**带注释的 JSONC 也能自动补接了**,尾逗号也容得下(解析器按宽松
// 读,写回去时不碰它们)。
//
// 裸 Node 那一侧有一份同构实现(`scripts/json-edit.mjs`) —— setup 在 build 之前跑、导不进 TS。
// 两边的行为由 `server/scripts/test-ash-mcp-installer.ts` 的对齐组钉着。

/** 一个成员:键名,以及键和值在原文里的位置(`valueEnd` 是**之后**一位)。 */
export interface JsonMember {
  readonly key: string;
  readonly keyStart: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** 一个值;`members` 只有对象才有。`end` 是**之后**一位。 */
export interface JsonNode {
  readonly kind: "object" | "array" | "scalar";
  readonly start: number;
  readonly end: number;
  readonly members?: readonly JsonMember[];
}

/** 跳过空白、行注释与块注释(`//` 与 `/*`),回到下一个有意义的字符。 */
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return text.length;
      i = close + 2;
      continue;
    }
    return i;
  }
}

/** 一个字符串字面量的结尾(之后一位);没收尾返回 null。 */
function endOfString(text: string, i: number): number | null {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }
    if (text[j] === '"') return j + 1;
  }
  return null;
}

/** 解析一个值,带位置。读不通返回 null —— 读不通一律不改写,不猜。 */
function parseValue(text: string, from: number): JsonNode | null {
  const start = skipTrivia(text, from);
  const ch = text[start];
  if (ch === undefined) return null;
  if (ch === "{" || ch === "[") {
    const object = ch === "{";
    const members: JsonMember[] = [];
    let i = start + 1;
    for (;;) {
      i = skipTrivia(text, i);
      if (text[i] === (object ? "}" : "]")) return { kind: object ? "object" : "array", start, end: i + 1, members };
      if (i >= text.length) return null;
      if (object) {
        if (text[i] !== '"') return null;                 // 键必须是字符串(不认无引号键)
        const keyEnd = endOfString(text, i);
        if (keyEnd === null) return null;
        let key: string;
        try { key = JSON.parse(text.slice(i, keyEnd)) as string; } catch { return null; }
        const colon = skipTrivia(text, keyEnd);
        if (text[colon] !== ":") return null;
        const value = parseValue(text, colon + 1);
        if (!value) return null;
        members.push({ key, keyStart: i, valueStart: value.start, valueEnd: value.end });
        i = value.end;
      } else {
        const value = parseValue(text, i);
        if (!value) return null;
        i = value.end;
      }
      i = skipTrivia(text, i);
      if (text[i] === ",") { i++; continue; }             // 尾逗号:下一轮会撞上收尾括号,宽松放过
      if (text[i] === (object ? "}" : "]")) return { kind: object ? "object" : "array", start, end: i + 1, members };
      return null;
    }
  }
  if (ch === '"') {
    const end = endOfString(text, start);
    return end === null ? null : { kind: "scalar", start, end };
  }
  // 数字 / true / false / null:到下一个结构字符为止,内容我们不解释(**也就不会改写**)。
  let i = start;
  while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++;
  return i === start ? null : { kind: "scalar", start, end: i };
}

/** 整份文档(必须是一个对象);读不通或不是对象返回 null。 */
export function parseJsonDoc(text: string): JsonNode | null {
  const root = parseValue(text, 0);
  if (!root || root.kind !== "object") return null;
  return skipTrivia(text, root.end) === text.length ? root : null;
}

/**
 * 同名键取**最后一条** —— `JSON.parse` 就是这么取的(后来的覆盖先前的)。
 *
 * 这不是风格选择:取第一条会让读和写指向不同的容器(本轮审查 F5)。
 * `{"mcpServers":{},"mcpServers":{"other":…}}` 这种配置上,上一版把 ash 插进**第一个**
 * 空容器,而 CLI(以及我们自己的回读)用的是**最后一个** —— 文件写出去了、语法也对,
 * 生效的那个容器里却没有 ash:界面报「已接好」,启动后一个 ash 工具都看不到。
 */
const member = (node: JsonNode, key: string): JsonMember | undefined =>
  node.members?.filter((m) => m.key === key).at(-1);

/** 某一行开头的缩进(用来让插进去的那几行跟邻居对齐)。 */
function lineIndent(text: string, at: number): string {
  const nl = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(nl, at))?.[0] ?? "";
}

/** 多行正文的第 2 行起补上缩进。 */
const reindent = (body: string, indent: string): string =>
  body.split("\n").map((line, n) => (n === 0 ? line : indent + line)).join("\n");

/** 在 `obj` 的 `{` 之后插一条成员(插在最前面:这样既不碰已有的尾逗号,也不用找最后一条)。 */
function insertFirst(text: string, obj: JsonNode, entry: string): string {
  const brace = obj.start;
  const outer = lineIndent(text, brace);
  const first = obj.members?.[0];
  const indent = first ? lineIndent(text, first.keyStart) : `${outer}  `;
  const body = `${indent}${reindent(entry, indent)}`;
  // 一条成员都没有(只有空白或注释):**原文照留**,我们那条接在它后面。上一版把 `{` 到 `}`
  // 之间整段切掉,于是 `{"mcp":{/* 保留说明 */}}` 这种配置补完登记,说明文字没了(本轮审查
  // N1)。接在后面而不是前面,是为了不出现「逗号在注释之前」那种不合法的拼法。
  if (!obj.members?.length) {
    const inner = text.slice(brace + 1, obj.end - 1);
    const gap = inner.endsWith("\n") ? "" : "\n";
    return `${text.slice(0, brace + 1)}${inner}${gap}${body}\n${outer}${text.slice(obj.end - 1)}`;
  }
  return `${text.slice(0, brace + 1)}\n${body},${text.slice(brace + 1)}`;
}

export interface SpliceResult { body?: string; why?: string }

/**
 * 把 `{ [memberKey]: value }` 插进顶层 `container` 对象里,**其余字节原样**。
 *
 * - `text === null` 或空白 ⇒ 建一份新文档。
 * - 读不通、根不是对象、`container` 不是对象 ⇒ 回 `why`,**一个字节都不写**。
 * - `container` 里已经有 `memberKey` ⇒ 回 `why`(覆盖用户已有登记是不可逆的,这里是第二道闸)。
 */
export function spliceJsonMember(
  text: string | null,
  container: string,
  memberKey: string,
  value: unknown,
): SpliceResult {
  const entryValue = JSON.stringify(value, null, 2);
  const entry = `${JSON.stringify(memberKey)}: ${entryValue}`;
  if (text === null || !text.trim()) {
    return { body: `{\n  ${JSON.stringify(container)}: {\n    ${reindent(entry, "    ")}\n  }\n}\n` };
  }
  const root = parseJsonDoc(text);
  if (!root) return { why: "配置解析不了，没敢动它 —— 手工修好或删掉它再重启" };
  const hit = member(root, container);
  if (!hit) {
    return { body: insertFirst(text, root, `${JSON.stringify(container)}: {\n  ${reindent(entry, "  ")}\n}`) };
  }
  const value0 = parseValue(text, hit.valueStart);
  if (!value0 || value0.kind !== "object") return { why: `配置里的 ${container} 不是一个对象，没敢动它` };
  if (member(value0, memberKey)) return { why: `配置里已经有 ${memberKey} 这条登记了，没有覆盖它` };
  return { body: insertFirst(text, value0, entry) };
}

/** 宽松读一份 JSON/JSONC(容注释与尾逗号);读不通返回 undefined,**空文档**返回 null。 */
export function readJsonLoose(text: string | null): Record<string, unknown> | null | undefined {
  if (text === null || !text.trim()) return null;
  if (!parseJsonDoc(text)) return undefined;
  const stripped = stripTrivia(text);
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 把注释和尾逗号剔成标准 JSON(**只用于读**:写回去走 `spliceJsonMember`)。 */
export function stripTrivia(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      const end = endOfString(text, i);
      if (end === null) { out += text.slice(i); break; }
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      const next = skipTrivia(text, i);
      out += " ";
      i = next;
      continue;
    }
    if (ch === ",") {
      const next = skipTrivia(text, i + 1);
      if (text[next] === "}" || text[next] === "]") { i++; continue; }   // 尾逗号:丢掉
    }
    out += ch;
    i++;
  }
  return out;
}

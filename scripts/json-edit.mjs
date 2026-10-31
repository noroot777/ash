// JSON / JSONC 的**最小无损编辑**(裸 Node 这一侧)。
//
// 规矩本体与来历在 `server/src/mcp-registry/json-edit.ts` 的文件头,这里不复述,只留一句:
// **不许 `JSON.parse` → 改 → `JSON.stringify`**。那条往返会悄悄改掉用户保存的值
// (`9007199254740993` → `…992`、`1e999` → `null`、`-0` → `0`、重复键只剩最后一个、注释和
// 键序全丢),而本任务的硬约束是「只在缺 ash 条目时追加,绝不动其它条目」(本轮审查 R4)。
//
// 两边各一份实现是因为 setup 在 build 之前跑、导不进 TS;行为对齐由
// `server/scripts/test-ash-mcp-installer.ts` 的对齐组钉着。

function skipTrivia(text, i) {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
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

function endOfString(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }
    if (text[j] === '"') return j + 1;
  }
  return null;
}

/** 解析一个值,带位置(`end` 是之后一位)。读不通返回 null —— 读不通一律不改写,不猜。 */
function parseValue(text, from) {
  const start = skipTrivia(text, from);
  const ch = text[start];
  if (ch === undefined) return null;
  if (ch === "{" || ch === "[") {
    const object = ch === "{";
    const members = [];
    let i = start + 1;
    for (;;) {
      i = skipTrivia(text, i);
      if (text[i] === (object ? "}" : "]")) return { kind: object ? "object" : "array", start, end: i + 1, members };
      if (i >= text.length) return null;
      if (object) {
        if (text[i] !== '"') return null;
        const keyEnd = endOfString(text, i);
        if (keyEnd === null) return null;
        let key;
        try { key = JSON.parse(text.slice(i, keyEnd)); } catch { return null; }
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
      if (text[i] === ",") { i++; continue; }        // 尾逗号:下一轮撞上收尾括号,宽松放过
      if (text[i] === (object ? "}" : "]")) return { kind: object ? "object" : "array", start, end: i + 1, members };
      return null;
    }
  }
  if (ch === '"') {
    const end = endOfString(text, start);
    return end === null ? null : { kind: "scalar", start, end };
  }
  let i = start;
  while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  return i === start ? null : { kind: "scalar", start, end: i };
}

/** 整份文档(必须是一个对象);读不通或不是对象返回 null。 */
export function parseJsonDoc(text) {
  const root = parseValue(text, 0);
  if (!root || root.kind !== "object") return null;
  return skipTrivia(text, root.end) === text.length ? root : null;
}

const member = (node, key) => (node.members || []).find((m) => m.key === key);

function lineIndent(text, at) {
  const nl = text.lastIndexOf("\n", at - 1) + 1;
  return (/^[ \t]*/.exec(text.slice(nl, at)) || [""])[0];
}

const reindent = (body, indent) =>
  body.split("\n").map((line, n) => (n === 0 ? line : indent + line)).join("\n");

/** 在 `obj` 的 `{` 之后插一条成员(插最前面:既不碰已有的尾逗号,也不用找最后一条)。 */
function insertFirst(text, obj, entry) {
  const brace = obj.start;
  const outer = lineIndent(text, brace);
  const first = (obj.members || [])[0];
  const indent = first ? lineIndent(text, first.keyStart) : `${outer}  `;
  const body = `${indent}${reindent(entry, indent)}`;
  if (!(obj.members || []).length) {
    return `${text.slice(0, brace + 1)}\n${body}\n${outer}${text.slice(obj.end - 1)}`;
  }
  return `${text.slice(0, brace + 1)}\n${body},${text.slice(brace + 1)}`;
}

/**
 * 把 `{ [memberKey]: value }` 插进顶层 `container` 对象里,**其余字节原样**。
 * 返回 `{ body }` 或 `{ why }`;`why` 一律表示一个字节都没改。
 */
export function spliceJsonMember(text, container, memberKey, value) {
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
  const container0 = parseValue(text, hit.valueStart);
  if (!container0 || container0.kind !== "object") return { why: `配置里的 ${container} 不是一个对象，没敢动它` };
  if (member(container0, memberKey)) return { why: `配置里已经有 ${memberKey} 这条登记了，没有覆盖它` };
  return { body: insertFirst(text, container0, entry) };
}

/** 把注释和尾逗号剔成标准 JSON(**只用于读**;写回去走 `spliceJsonMember`)。 */
export function stripTrivia(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const end = endOfString(text, i);
      if (end === null) { out += text.slice(i); break; }
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      out += " ";
      i = skipTrivia(text, i);
      continue;
    }
    if (ch === ",") {
      const next = skipTrivia(text, i + 1);
      if (text[next] === "}" || text[next] === "]") { i++; continue; }
    }
    out += ch;
    i++;
  }
  return out;
}

/** 宽松读一份 JSON/JSONC;读不通返回 undefined,空文档返回 null。 */
export function readJsonLoose(text) {
  if (text === null || !text.trim()) return null;
  if (!parseJsonDoc(text)) return undefined;
  try {
    const parsed = JSON.parse(stripTrivia(text));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

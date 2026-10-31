// 一份 TOML 里**已经登记了哪几个 MCP**、根级关掉了哪几个 —— 结构判据,不是全文搜。
//
// 为什么是逐字符扫而不是逐行正则(本轮审查 R2,**实测复现过**):上一版按行先找 `"""`、
// 再剔 `#`,顺序正好反了。于是
//
//     # 示例 """
//     [mcp_servers.ash]      ← 真事实,却被当成多行字符串正文吞掉
//     # 结束 """
//
// 这份配置里明明已经有 ash,扫描器却说没有,安装器于是**追加第二张同名表**并报「已接好」;
// 真 grok 那边 `duplicate key` 直接让整份配置读不出来(连用户自己的 MCP 一起没了),而它的
// 退出码还是 0。注释与字符串谁先谁后不是「再补一个正则」能解决的,只能按位置从左到右定:
// `#` 出现在字符串外面就是注释、**吃到行尾**,里面的三引号不是字符串定界符。
// TS 那一侧(`server/src/codex-toml.ts`)本来就是逐字符扫的,同一份输入判得对,这里跟上。
//
// 只认两种写法,其余一律回 `why`(不写比写错便宜得多):
//  · `[mcp_servers.<名>]` / `[[…]]` / `[mcp_servers."名"]` 这样的表头 —— 取名字;
//  · 根级 `disabled_mcp_servers = ["a","b"]`(写在一行里的数组);
//  · 别的地方再出现 `mcp_servers` 这个词(内联表、点号键、某个值里带着它)⇒ 判不准,不写。

/**
 * 把注释和多行字符串的内容剔掉,按行交回来(行号保持一致)。
 *
 * 单行引号里的文本**留着** —— 那种写法会落到「判不准」那条出路,方向偏向不写。
 */
function stripTomlNoise(text) {
  const lines = [];
  let line = "";
  let ml = null;      // 多行字符串:`"""` 或 `'''`
  let quote = null;   // 单行字符串:`"` 或 `'`
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      // 单行字符串跨不了行:到这儿还没收尾说明这份 TOML 本身读不通。
      if (quote) return { why: "配置里有一个字符串到行尾还没收尾（这份 TOML 本身读不通）" };
      lines.push(line);
      line = "";
      i++;
      continue;
    }
    if (ml) {
      if (text.startsWith(ml, i)) { ml = null; i += 3; continue; }
      if (ch === "\\" && ml === '"""') { i += 2; continue; }
      i++;
      continue;                                   // 字符串正文不是事实,整段丢掉
    }
    if (quote) {
      line += ch;
      if (ch === "\\" && quote === '"') { line += text[i + 1] ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      ml = text.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; line += ch; i++; continue; }
    if (ch === "#") {                             // 注释吃到行尾(`\n` 留给上面那条分支)
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    line += ch;
    i++;
  }
  if (quote) return { why: "配置里有一个字符串到文件结尾还没收尾（这份 TOML 本身读不通）" };
  if (ml) return { why: "配置里有一个多行字符串到文件结尾还没收尾（这份 TOML 本身读不通）" };
  lines.push(line);
  return { lines };
}

/**
 * `{ names, disabled, duplicateTables }`,或者 `{ why }` = 判不准,**不许写**。
 *
 * - `names`:配置里登记过的服务名,**去重**。子表也算(`[mcp_servers.ash.env]` 在而
 *   `[mcp_servers.ash]` 不在,这家 CLI 眼里 ash 照样是配过的,所以「已有就不覆盖」要认它);
 * - `disabled`:**根级**那个 `disabled_mcp_servers` 列的名字(见下面的 `root`);
 * - `duplicateTables`:同一个名字的 `[mcp_servers.<名>]` 出现了不止一次 —— 这是**写坏了**的
 *   形状(TOML 不许重复表,CLI 会整份拒载),所以单独数出来,给写之前的候选校验用。
 */
export function scanTomlServers(text) {
  const stripped = stripTomlNoise(text);
  if (stripped.why) return { why: stripped.why };

  const seen = [];        // 所有深度的名字(含子表),去重后交出去
  const tables = [];      // 只有 `[mcp_servers.<名>]` 这一层,带重数
  let disabled = [];
  const rest = [];
  // **只有根级那个 `disabled_mcp_servers` 才是那个全局开关**(本轮审查 F2,真 grok 实测):
  // `[plugins.demo]` 底下同名的键是那个插件自己的字段,上一版不记表作用域、任意表里的同名
  // 行都当成根级事实,于是一份真 grok 能照常加 ash 的配置被判成「你关掉了 ash」、自动补接
  // 当场被拒。TS 那侧(`codex-toml.ts` 的 `tomlRootStringArray`)本来就记作用域,这里跟上。
  // TOML 里第一个表头之后再回不到根级,所以一个布尔就够。非根级那几行照样要**吃掉** ——
  // 不吃就会落到下面的 `mcp_servers` 散行检查上(`disabled_mcp_servers` 带着这个词),
  // 判不准同样会让安装器不写:那不是修好,只是换了句话拒绝。
  let root = true;
  for (const line of stripped.lines.map((l) => l.trim())) {
    if (!line) continue;
    if (line.startsWith("[")) {
      const header = /^\[\[?((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]\]?$/.exec(line);
      const path = header ? tomlKeyPath(header[1]) : null;
      if (!path) return { why: `表头 ${line} 按 TOML 读不通` };
      root = false;
      if (path[0] === "mcp_servers") {
        // `[mcp_servers]` 本体底下只能靠点号键给出名字 —— 那一档我们不认,交给「判不准」。
        if (path.length < 2) return { why: "配置里有一张 [mcp_servers] 总表（名字写在点号键里，ash 认不了）" };
        seen.push(path[1]);
        if (path.length === 2) tables.push(path[1]);
      }
      continue;
    }
    const off = /^disabled_mcp_servers[ \t]*=[ \t]*\[(.*)\][ \t]*$/.exec(line);
    if (off) {
      if (root) {
        disabled = [...(off[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) || [])].map((q) => unquoteToml(q) ?? "");
      }
      continue;
    }
    rest.push(line);
  }
  const stray = rest.find((l) => /mcp_servers/.test(l));
  if (stray) return { why: `配置里这一行提到了 mcp_servers，而 ash 读不准它的写法：${stray.slice(0, 60)}` };
  const names = [...new Set(seen)];
  const duplicateTables = names.filter((n) => tables.filter((t) => t === n).length > 1);
  return { names, disabled, duplicateTables };
}

/** `mcp_servers."ash".env` → `["mcp_servers","ash","env"]`;读不通返回 null。 */
export function tomlKeyPath(raw) {
  const out = [];
  let i = 0;
  while (i < raw.length) {
    while (raw[i] === " " || raw[i] === "\t") i++;
    if (raw[i] === '"' || raw[i] === "'") {
      const re = raw[i] === '"' ? /^"(?:[^"\\]|\\.)*"/ : /^'[^']*'/;
      const m = re.exec(raw.slice(i));
      const text = m ? unquoteToml(m[0]) : null;
      if (!m || text === null) return null;
      out.push(text);
      i += m[0].length;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(raw.slice(i));
      if (!m) return null;
      out.push(m[0]);
      i += m[0].length;
    }
    while (raw[i] === " " || raw[i] === "\t") i++;
    if (i >= raw.length) break;
    if (raw[i] !== ".") return null;
    i++;
  }
  return out.length ? out : null;
}

/** TOML 的字符串字面量 → 文本(双引号按转义解码,单引号原样);读不通返回 null。 */
export function unquoteToml(raw) {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  try { return JSON.parse(raw); } catch { return null; }
}

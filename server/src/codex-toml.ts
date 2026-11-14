// codex 的 `config.toml` 里「ash 登记在不在、叫什么、关没关」—— **唯一**一份判据。
//
// 派审预检、设置页、隔离档自动补写、执行器注入回合身份四处都读它。以前各写各的：预检用
// 结构扫描，注入那一侧还是 `^\[mcp_servers\.ash\]` 行首正则 —— `[mcp_servers."ash"]` 这种
// codex 自己认得的写法，预检说「接好了」，注入却认不出来、不给 MCP 传回合身份，审查跑完
// 交卷照样 409（新链第 4 轮审查第 1 条）。判据只有一份，才不会出现「预检越准、越替一份
// 实际交不了卷的配置背书」。
import { ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME } from "@ash/shared/mcp";

const WANTED = [ASH_MCP_SERVER_NAME, LEGACY_ASH_MCP_SERVER_NAME];

/** 一条登记**怎么起** —— 只拿来出提示，不参与拦/放。 */
export type LaunchSpec = { command?: string | null; args?: unknown; ashUrl?: string | null };

type CodexServer = { enabled: boolean; spec: LaunchSpec };

export type CodexTomlScan = {
  servers: Map<string, CodexServer>;
  /** 非空 = 扫描器自己没把握（写法超出它认得的范围），调用方必须按「判不了」处理。 */
  doubt: string | null;
  /**
   * 非空 = **连语句都切不开**，所以连 `servers` 里认出来的那几条也不可信（里面的字符串是
   * 说给用户听的原因）。`doubt` 的范围比它大得多：表里有一处我们读不懂、有个表挂错了位置、
   * 某个值的写法不认识 —— 这些都让「这份配置里没有 ash」这句话说不出口，但**不影响**已经
   * 正面认出来的根级登记。
   *
   * 分开这两档的理由:一份合法配置里只要有个叫 mcp_servers 的 profile(`[profiles.mcp_servers]`)
   * 就会答 doubt,而真 codex 读得好好的 —— 拿 doubt 当 unreadable 会把一份能用的配置判成读不懂。
   */
  unreadable: string | null;
  /**
   * 非空 = **这份配置里的 `mcp_servers` 不能再用 `[mcp_servers.x]` 表头扩展**，字符串是
   * 说给用户听的原因。谁要它：自动补写（`auth/user-cli-mcp.ts`）—— 它唯一会写的东西就是
   * 追加一段普通表头。
   *
   * 实测（codex-cli 0.153）：整张表写成内联值 `mcp_servers = { kb = {...} }` 之后再追加
   * `[mcp_servers.ash]`，codex 报 `cannot extend value of type inline table with a dotted
   * key` 并**整份拒载** —— 用户别的 MCP 一起没了。而根上的点号键（`mcp_servers.kb = {...}`、
   * `mcp_servers.kb.command = "x"`）、`[mcp_servers]` 下的内联项、普通子表都照样扩展得了
   * （四种形状都真机验过 rc=0）。所以封的只有「整张表是一个内联值」这一种。
   */
  sealed: string | null;
};

/**
 * 只认 TOML 的**结构**（表头、键路径），不解析值 —— 「有没有 ash 这条登记、是不是关着」
 * 只需要这些。认得的写法：
 *
 *   [mcp_servers.ash]        [ mcp_servers . "ash" ]       [mcp_servers.'ash'.env]
 *   mcp_servers.ash.command = "node"                       （根上的点号键）
 *   [mcp_servers]  ash = { command = "node", enabled = false }   （内联表）
 *   mcp_servers = { ash = { command = "node" } }           （整张表写成一个内联值）
 *
 * **兜底**：扫描器没认出任何登记、可文本里明明有 `mcp_servers.ash` / `mcp_servers.harness`
 * 出现在表头或行首键的位置 —— 说明写法超出了它认得的范围（多行字符串里的假表头、它没跟上的
 * 嵌套等）。那时不说「没有」，答 doubt。拦人只能落在「确定没有」上。别处出现这两个词（路径
 * 型表头、注释、值里）不算信号。
 */
export function scanCodexToml(text: string): CodexTomlScan {
  const servers = new Map<string, CodexServer>();
  const slot = (name: string) => {
    let s = servers.get(name);
    if (!s) { s = { enabled: true, spec: {} }; servers.set(name, s); }
    return s;
  };
  let table: string[] = [];
  let doubt: string | null = null;
  let unreadable: string | null = null;
  let sealed: string | null = null;
  const seen = new Set<string>();
  for (const stmt of statements(text)) {
    // 这一行按 TOML 读不通 ⇒ 后面的行怎么切都是猜,连认出来的东西都不作数(见 `unreadable`)。
    if (stmt.kind === "unparsed") { doubt ??= stmt.why; unreadable ??= stmt.why; continue; }
    if (stmt.kind === "header") {
      // **同名表重复定义**：TOML 里这是 `duplicate key`，codex 整份配置拒载（实测
      // `failed to load bootstrap configuration`）。这一档说不出「有没有 ash」,只能答
      // 判不了 —— 自动补写那一侧正是靠它才不会再往上追加一份(新链第 6 轮审查 F1)。
      const key = stmt.path.join("\u0000");
      if (!stmt.array && seen.has(key)) doubt ??= `[${stmt.path.join(".")}] 定义了两次（codex 会整份拒载）`;
      seen.add(key);
      table = stmt.path;
      const at = table.indexOf("mcp_servers");
      if (at > 0 && WANTED.includes(table[at + 1] ?? "")) {
        doubt ??= `[${table.join(".")}] 把 mcp_servers 挂在了别的表底下`;
      }
      // 表头本身就是一次登记（`[mcp_servers.ash]` 下面可以一行都没有）。
      if (at === 0 && table.length >= 2 && WANTED.includes(table[1]!)) slot(table[1]!);
      continue;
    }
    const path = [...table, ...stmt.path];
    const at = path.indexOf("mcp_servers");
    // **只有紧跟着兼容名的那种才值得说一句**:`[profiles.p.mcp_servers.ash]` 是用户以为接好
    // 了、codex 其实不读那个位置。而 `[profiles.mcp_servers]`、`[model_providers.mcp_servers]`
    // 这些是别的命名空间里恰好叫这个名字的字段 —— 合法、与 ash 无关,上一版对它们一律答
    // doubt,于是一份接得好好的配置被判成「看不准」:身份注入整个取消、派审当场被拒
    // (第 2 轮审查 F1,真机取证)。
    if (at > 0) {
      if (WANTED.includes(path[at + 1] ?? "")) doubt ??= `${path.join(".")} 把 mcp_servers 挂在了别的表底下`;
      continue;
    }
    if (at < 0) continue;
    if (path.length === 1) {
      // `mcp_servers = { ash = {...} }`：整张表写成一个内联值。**必须拆开读** —— 上一版
      // 在这里只拿 `\bash\b` 扫一眼值文本就答 doubt：codex 自己认得这种登记（真机 rc=0、
      // `mcp list` 列得出 ash，`-c mcp_servers.ash.env_vars=[...]` 也落得上去），而我们
      // 这边派审误拒、回合身份注不进去；更糟的是「没有 ash」那一半是对的时候，自动补写
      // 会追加一段普通表头，codex 整份拒载（第 2 轮审查 F1 实测三种形状）。
      const fields = inlinePairs(stmt.value);
      if (!fields) { doubt ??= "mcp_servers 整个写成了内联表，而它的内容拆不开"; continue; }
      // 拆得开也要记下「这张表封住了」：我们唯一会写的东西就是追加普通表头，而 TOML 不许
      // 用表头扩展一个已经定义成内联值的表（见 `sealed`）。
      sealed ??= "mcp_servers 整张表写成了内联值（`mcp_servers = { ... }`），TOML 不许再用"
        + " [mcp_servers.x] 表头扩展它 —— codex 会整份拒载";
      for (const field of fields) {
        const inlineName = field.path[0]!;
        if (!WANTED.includes(inlineName)) continue;
        const server = slot(inlineName);
        if (!applyServerValue(server, field.path.slice(1), field.value)) {
          doubt ??= `mcp_servers.${field.path.join(".")} 的值无法识别`;
        }
      }
      continue;
    }
    const name = path[1]!;
    if (!WANTED.includes(name)) continue;
    const s = slot(name);
    if (!applyServerValue(s, path.slice(2), stmt.value)) doubt ??= `${path.join(".")} 的值无法识别`;
  }
  if (!servers.size && !doubt) {
    // **只认「mcp_servers 底下的 ash」那个位置**：表头或点号键的第一段是 `mcp_servers`、
    // 第二段是兼容名。上一版拿「行首是 `[` 且行内有 ash/harness」当信号，codex 自己记项目
    // 信任的 `[projects."/Users/x/code/harness"]` 正好命中 —— 跑过这个仓库的机器上整份配置
    // 都成了「看不准」，预检放行、启动自检闭嘴（新链第 3 轮审查第 1 条）。
    const name = `["']?(?:${WANTED.join("|")})["']?`;
    const head = `["']?mcp_servers["']?\\s*\\.\\s*${name}`;
    const suspicious = new RegExp(`^\\s*\\[\\[?\\s*${head}\\s*[.\\]]|^\\s*${head}\\s*[.=]`, "m");
    if (suspicious.test(text)) {
      doubt = "文本里有像是 ash 登记的写法，但扫描器没认出来";
    }
  }
  return { servers, doubt, unreadable, sealed };
}

type Statement =
  | { kind: "header"; path: string[]; line: number; array: boolean }
  /** `first`/`last` = 这条键值对占的物理行(值跨行时 last > first),给就地改写用。 */
  | { kind: "pair"; path: string[]; value: string; first: number; last: number }
  /** 这一行按 TOML 读不通 —— codex 自己也读不动，所以**不许**据此说「没有 ash」。 */
  | { kind: "unparsed"; why: string };

const isHeader = (s: Statement): s is Statement & { kind: "header" } => s.kind === "header";

/**
 * 把 TOML 切成「表头」和「键 = 值」两种语句。值可以跨行（多行数组/内联表/多行字符串），
 * 所以按括号深度和多行字符串状态把续行拼回去 —— 续行里的 `[` 不会被当成表头。
 */
function statements(text: string): Statement[] {
  const out: Statement[] = [];
  let pending: { path: string[]; value: string; first: number } | null = null;
  let depth = 0;
  let ml: '"""' | "'''" | null = null;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n]!;
    if (pending) {
      const scanned = scanValue(raw, depth, ml);
      if (scanned.bad) { out.push({ kind: "unparsed", why: scanned.bad }); return out; }
      pending.value += `\n${scanned.text}`;
      depth = scanned.depth; ml = scanned.ml;
      if (!depth && !ml) { out.push({ kind: "pair", ...pending, last: n }); pending = null; }
      continue;
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      // 不在续行里时，行首的 `[` 只可能是表头；引号里的 `]` 不算收尾。
      const header = /^\[\[?((?:[^\]"']|"(?:[^"\\]|\\.)*"|'[^']*')*)\]/.exec(line);
      const path = header ? keyPath(header[1]!) : null;
      if (path) out.push({ kind: "header", path, line: n, array: line.startsWith("[[") });
      else out.push({ kind: "unparsed", why: `表头 ${line} 按 TOML 读不通` });
      continue;
    }
    const eq = splitKey(line);
    // `=` 都没有的行不是键值对(TOML 里也不合法,但不是这一档要管的);键读不通才要说一声。
    if (!eq) {
      if (/=/.test(line)) out.push({ kind: "unparsed", why: `${line} 的键按 TOML 读不通` });
      continue;
    }
    const scanned = scanValue(eq.value, 0, null);
    // 这份 TOML 本身不合法 ⇒ 后面的行怎么切都是猜,到此为止、如实答(上层据此 doubt)。
    if (scanned.bad) { out.push({ kind: "unparsed", why: scanned.bad }); return out; }
    depth = scanned.depth; ml = scanned.ml;
    if (depth || ml) pending = { path: eq.path, value: scanned.text, first: n };
    else out.push({ kind: "pair", path: eq.path, value: scanned.text, first: n, last: n });
  }
  // **文件结尾处值还没收尾**（数组少一个 `]`、多行字符串少一个 `\"\"\"`）：这份 TOML 本身
  // 不合法，codex 整份拒载。那后面那些本该是表头/键的行全被当成了这个值的续行 —— 据此说
  // 「没有 ash」是错的，自动补写还会把新表追加进那个没收尾的值里（本轮 F1 同类）。
  if (pending) out.push({ kind: "unparsed", why: `${pending.path.join(".")} 的值到文件结尾还没收尾` });
  return out;
}

/**
 * `a."b".'c'` → `["a","b","c"]`。点号只在引号外才是分隔符。
 *
 * **双引号键里的转义要按 TOML 解码**，因为 codex 就是这么读的：`[mcp_servers."\u0061sh"]`
 * 在它眼里就是 `ash`（实测 codex-cli 0.153 列出 `"name":"ash"`）。上一版只把引号摘掉，于是
 * 这份配置被判成「没有 ash」—— 派审误拒、回合身份注不进去，自动补写还会再追加一份**同名**
 * 表，TOML 里那是重复定义，codex 整份配置拒载、别的 MCP 一起没了（新链第 6 轮审查 F1）。
 *
 * `null` = 这串键按 TOML 读不通（引号没收尾、转义不认）。那时**不许当成「没有」**：这种
 * 文本 codex 自己也读不动，替它下结论只会错，一律交给上层答 doubt。
 */
function keyPath(raw: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;                    // 这一段出现过引号形式(引号键允许空名、允许空白)
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"' || ch === "'") {
      const seg = readQuotedKey(raw, i, ch);
      if (!seg) return null;
      cur += seg.text; i = seg.next; quoted = true; continue;
    }
    // 引号外的空白只是分隔用的:TOML 的裸键本来就只许 `A-Za-z0-9_-`,不含空白。
    if (ch === " " || ch === "\t") { i++; continue; }
    if (ch === ".") { parts.push(cur); cur = ""; quoted = false; i++; continue; }
    cur += ch; i++;
  }
  parts.push(cur);
  return quoted || parts.every((p) => p.length) ? parts : null;
}

/** TOML 的转义键:双引号是基本字符串(认转义),单引号是字面量(原样)。 */
function readQuotedKey(raw: string, at: number, quote: '"' | "'"): { text: string; next: number } | null {
  const simple: Record<string, string> = {
    b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\",
  };
  let out = "";
  let i = at + 1;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === quote) return { text: out, next: i + 1 };
    if (quote === "'" || ch !== "\\") { out += ch; i++; continue; }
    const esc = raw[i + 1];
    if (esc !== undefined && simple[esc] !== undefined) { out += simple[esc]; i += 2; continue; }
    if (esc === "u" || esc === "U") {
      const width = esc === "u" ? 4 : 8;
      const hex = raw.slice(i + 2, i + 2 + width);
      if (hex.length !== width || !/^[0-9a-fA-F]+$/.test(hex)) return null;
      const code = Number.parseInt(hex, 16);
      // 代理区与超出平面的码位不是合法 TOML 标量值 —— codex 也会拒,别替它编一个名字出来。
      if (code > 0x10_ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
      out += String.fromCodePoint(code); i += 2 + width; continue;
    }
    return null;                         // TOML 不认的转义
  }
  return null;                           // 引号没收尾
}

/** 找引号外的第一个 `=`，切成键路径和值。 */
function splitKey(line: string): { path: string[]; value: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      // 基本字符串里 `\"` 不收尾 —— 不跳过它,`"a\"b" = 1` 的 `=` 会被当成在引号里。
      if (ch === "\\" && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "=") {
      const path = keyPath(line.slice(0, i));
      return path ? { path, value: line.slice(i + 1) } : null;
    }
  }
  return null;
}

/**
 * 已经在一段 `delim` 开头的多行字符串里面了，从 `text[at]` 起找它在哪收尾。
 *
 * 两条 TOML 规矩，错一条就会把**字符串里的示例**当成真配置。第 5 轮 F2 实测：合法的
 * `developer_instructions` 里放一段带转义三引号的 `[mcp_servers.ash]` 示例，上一版在那个
 * 转义引号处就把字符串结束了，于是认出一条根本不存在的 ash 登记；真 codex `mcp list` 只
 * 列出 kb，而执行器照着那条假登记注入 `-c mcp_servers.ash.env_vars=…`，整份配置当场拒载
 * （`invalid transport in mcp_servers.ash`）—— 原来读得动的那些 MCP 一起没了。
 *
 * ① 多行**基本**字符串（三个双引号）里反斜杠是转义：被转义的那个引号是内容，所以紧跟其后
 *    只剩两个引号时并不收尾；连反斜杠本身一起跳过，这样 `\\` 之后的三引号才是真收尾。行尾
 *    那个反斜杠（合法的续行写法）跳过去正好落到行尾，下一行接着扫，不影响。多行**字面量**
 *    字符串（三个单引号）里没有转义，反斜杠原样算一个字符。
 * ② 连续引号：内容里最多允许两个连续引号，所以一串 n 个引号里**只有最后三个**是收尾符
 *    （四个引号收尾时，内容末尾还留着一个引号）。n > 5 这份 TOML 本身不合法 —— codex 自己
 *    也读不动，那就别替它猜，如实答 bad。
 *
 * @returns end = 收尾符后面那个下标；end=null 表示这段文本里没收尾（还要接着往下读），
 *          带 bad 则是这份 TOML 本身不合法。
 */
function scanMultiline(
  text: string,
  at: number,
  delim: '"""' | "'''",
): { end: number | null; bad?: string } {
  const q = delim[0]!;
  let i = at;
  while (i < text.length) {
    if (text[i] === "\\" && delim === '"""') { i += 2; continue; }
    if (text[i] !== q) { i++; continue; }
    let run = 0;
    while (text[i + run] === q) run++;
    if (run < 3) { i += run; continue; }
    if (run > 5) return { end: null, bad: `多行字符串里有 ${run} 个连续 ${q}，这份 TOML 不合法` };
    return { end: i + run };
  }
  return { end: null };
}

/** 跟踪一段值文本的括号深度与多行字符串状态，并去掉引号外的行尾注释。 */
function scanValue(
  text: string,
  depth: number,
  ml: '"""' | "'''" | null,
): { text: string; depth: number; ml: '"""' | "'''" | null; bad?: string } {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ml) {
      const found = scanMultiline(text, i, ml);
      // 没收尾:这一段整条都在字符串里(里面的 `#`、`[`、`=` 全是内容,一个都不许当语法看)。
      if (found.end === null) return { text: out + text.slice(i), depth, ml, bad: found.bad };
      out += text.slice(i, found.end);
      i = found.end - 1;
      ml = null;
      continue;
    }
    if (quote) {
      out += ch;
      if (ch === "\\" && quote === '"') { out += text[i + 1] ?? ""; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      ml = text.slice(i, i + 3) as '"""' | "'''"; out += ml; i += 2; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === "#") break;
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    out += ch;
  }
  return { text: out, depth, ml };
}

function inlinePairs(raw: string): { path: string[]; value: string }[] | null {
  const value = raw.trim();
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  const body = value.slice(1, -1);
  const fields: { path: string[]; value: string }[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let multiline: '"""' | "'''" | null = null;
  for (let index = 0; index <= body.length; index++) {
    const character = body[index];
    if (multiline) {
      // 转义引号、连续引号的规矩跟外面一模一样,所以共用 `scanMultiline` —— 内联表这一路
      // 自己写一份收尾判断,就是第 5 轮 F2 那个「同一层的另一条路没修」:它漏的是连续引号,
      // `{ x = """a"""" }` 会被它判成到末尾都还在字符串里。
      const found = scanMultiline(body, index, multiline);
      if (found.end === null) return null;    // 没收尾/不合法:都不该据此把内联表拆开
      index = found.end - 1;
      multiline = null;
      continue;
    }
    if (quote) {
      if (character === "\\" && quote === '"') { index++; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (body.startsWith('"""', index) || body.startsWith("'''", index)) {
      multiline = body.slice(index, index + 3) as '"""' | "'''"; index += 2; continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "[" || character === "{") depth++;
    if (character === "]" || character === "}") depth--;
    if (depth < 0) return null;
    if (depth || (character !== "," && index !== body.length)) continue;
    const field = body.slice(start, index).trim();
    if (field) {
      const pair = splitKey(field);
      if (!pair) return null;
      fields.push(pair);
    } else if (index !== body.length) return null;
    start = index + 1;
  }
  return depth || quote || multiline ? null : fields;
}

function applyServerValue(server: CodexServer, path: string[], raw: string): boolean {
  const value = raw.trim();
  if (!path.length || (path.length === 1 && path[0] === "env")) {
    const fields = inlinePairs(value);
    return fields !== null && fields.every((field) => applyServerValue(server, [...path, ...field.path], field.value));
  }
  if (path.length === 1) {
    if (path[0] === "enabled") {
      if (value !== "true" && value !== "false") return false;
      server.enabled = value === "true";
    } else if (path[0] === "command") server.spec.command = tomlString(value);
    else if (path[0] === "args") server.spec.args = tomlStringArray(value);
  } else if (path.length === 2 && path[0] === "env" && path[1] === "ASH_URL") {
    server.spec.ashUrl = tomlString(value);
  }
  return true;
}

function tomlString(raw: string): string | null {
  const v = raw.trim();
  const read = readTomlString(v, 0);
  return read && read.end === v.length ? read.value : null;
}

/** 数组里的全部字符串;有一个解不开就是 null(codex 自己也读不动这一条,别拿一截当整条)。 */
function tomlStringArray(raw: string): string[] | null {
  return tomlStringValues(raw);
}

const TOML_ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\x1b", '"': '"', "\\": "\\" };

/**
 * 按 TOML 规则解码基本字符串的内容(引号之间那段)。上一版用 `JSON.parse` 顶替:它不认 `\U`、
 * 却认 TOML 没有的 `\/`,跟 codex 读到的值对不上。认的转义取 TOML 1.1 的全集(多认 `\e`、`\xHH`):
 * 这个解码器的用处是「codex 会读到什么」,多认只会多看见,不会漏看。`null` = 解不开。
 */
function decodeBasic(body: string, multiline: boolean): string | null {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") { out += ch; continue; }
    const next = body[i + 1];
    if (next === undefined) return null;
    if (multiline && /[ \t\r\n]/.test(next)) {
      // 行尾反斜杠:吃掉它后面直到下一个非空白字符的全部空白和换行。
      let j = i + 1;
      while (j < body.length && /[ \t]/.test(body[j]!)) j++;
      if (body[j] !== "\n" && body[j] !== "\r") return null;
      while (j < body.length && /[ \t\r\n]/.test(body[j]!)) j++;
      i = j - 1;
      continue;
    }
    if (next in TOML_ESCAPES) { out += TOML_ESCAPES[next]; i++; continue; }
    const width = next === "u" ? 4 : next === "U" ? 8 : next === "x" ? 2 : 0;
    const hex = body.slice(i + 2, i + 2 + width);
    if (!width || hex.length !== width || !/^[0-9a-f]+$/i.test(hex)) return null;
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    out += String.fromCodePoint(code);
    i += 1 + width;
  }
  return out;
}

/** 从 `at`(一个引号)读一个 TOML 字符串(四种引法都认),返回解码后的值和收尾后的下标。 */
function readTomlString(text: string, at: number): { value: string; end: number } | null {
  const delim = text.startsWith('"""', at) ? '"""' : text.startsWith("'''", at) ? "'''" : null;
  if (delim) {
    const found = scanMultiline(text, at + 3, delim);
    if (found.end === null || found.bad) return null;
    // 收尾那串可以是 3~5 个引号,多出来的一两个属于内容;紧跟开头的那个换行不算内容。
    const body = text.slice(at + 3, found.end - 3).replace(/^\r?\n/, "");
    const value = delim === "'''" ? body : decodeBasic(body, true);
    return value === null ? null : { value, end: found.end };
  }
  if (text[at] === "'") {
    const end = text.indexOf("'", at + 1);
    return end < 0 || text.slice(at, end).includes("\n") ? null : { value: text.slice(at + 1, end), end: end + 1 };
  }
  if (text[at] !== '"') return null;
  let j = at + 1;
  while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
  if (text[j] !== '"') return null;
  const value = decodeBasic(text.slice(at + 1, j), false);
  return value === null ? null : { value, end: j + 1 };
}

/**
 * 一段值文本(去过注释的,见 `statements`)里**全部**字符串字面量解码后的值,按出现顺序;
 * 内联表的键也在内。有一个解不开就是 null。给「codex 实际会读到什么」做核对用:原文里看不见的
 * 东西(`\u002f` 之类的转义)解码后才看得见。
 */
export function tomlStringValues(value: string): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '"' && value[i] !== "'") continue;
    const read = readTomlString(value, i);
    if (!read) return null;
    out.push(read.value);
    i = read.end - 1;
  }
  return out;
}

/**
 * 根级 `<key> = ["a","b"]`(grok 的 `disabled_mcp_servers`)。
 *
 * 判据必须走**结构扫描**而不是全文正则(本轮审查 R7):上一版 `/^[ \t]*disabled_mcp_servers…/m`
 * 对整份 TOML 逐行匹配,于是
 *  · 另一个 MCP 的三引号多行字符串里恰好有这么一行 ⇒ 被当成根级事实,一条启用着的 ash
 *    被判成「已关闭」,预检当场硬拒;
 *  · 真的写成多行数组 ⇒ 反过来漏读。
 * 两头都错,而这个文件里本来就有一个认得多行字符串、认得表作用域的扫描器。
 *
 * `null` = 这份 TOML 有读不通的地方(调用方自己已经按 unknown 处理),或者根级没有这个键。
 */
export function tomlRootStringArray(text: string, key: string): string[] | null {
  let root = true;
  for (const stmt of statements(text)) {
    if (stmt.kind === "unparsed") return null;         // 读不通 ⇒ 不下结论
    if (stmt.kind === "header") { root = false; continue; }
    // 根级才算:`[other]` 底下同名的键是别人的字段,不是这个开关。
    if (root && stmt.path.length === 1 && stmt.path[0] === key) return tomlStringArray(stmt.value);
  }
  return null;
}

export type TomlPairSpan = { table: string[]; path: string[]; first: number; last: number; value: string };

/**
 * 每条键值对落在哪张表下、占哪几行 —— 给「只改某个键、别的字节一个不动」的就地改写用
 * (mcp-registry/relocate.ts)。`table` 是它上面最近那个表头的路径(根级为空数组);`value` 是
 * 去过行尾注释的值文本(跨行的拼好了),要看值就用 `tomlStringValues` 解它,别回头读原文行。
 * 有读不通的语句就回 null:那种文本连「这个键在哪」都说不准,不许据此改。
 */
export function tomlPairSpans(text: string): TomlPairSpan[] | null {
  const spans: TomlPairSpan[] = [];
  let table: string[] = [];
  for (const statement of statements(text)) {
    if (statement.kind === "unparsed") return null;
    if (statement.kind === "header") table = statement.path;
    else spans.push({ table, path: statement.path, first: statement.first, last: statement.last, value: statement.value });
  }
  return spans;
}

/**
 * 把 `[mcp_servers.<name>]` 连同它的子表（`.env` 等）整段抠出来，表头一律改写成
 * `[mcp_servers.<as>…]` 的规范拼法（带引号、带行尾注释的表头都认，历史名顺手改成规范名）。
 *
 * 切段用的是扫描器同一份表头识别：多行字符串里的 `[` 不算表头，`[[…]]` 数组表也算一次
 * 切换。抠出来的东西必须自己就能被认成一条**有启动命令**的登记，否则返回 null 让调用方
 * 用内置模板 —— 一部分写在 `[mcp_servers]` 底下的点号键里时，只抠走 `.env` 那段会造出
 * 一条没有 command 的登记，codex 照样整份拒载。
 */
export function extractTomlTables(config: string, name: string, as = name): string | null {
  const lines = config.split(/\r?\n/);
  const heads = statements(config).filter(isHeader);
  const picked: string[] = [];
  heads.forEach((h, i) => {
    if (h.path[0] !== "mcp_servers" || h.path[1] !== name) return;
    const rest = h.path.slice(2).map((seg) => `.${/^[A-Za-z0-9_-]+$/.test(seg) ? seg : JSON.stringify(seg)}`).join("");
    const head = `mcp_servers.${as}${rest}`;
    picked.push(h.array ? `[[${head}]]` : `[${head}]`, ...lines.slice(h.line + 1, heads[i + 1]?.line ?? lines.length));
  });
  while (picked.length && !picked[picked.length - 1]!.trim()) picked.pop();
  if (!picked.length) return null;
  const block = picked.join("\n");
  return scanCodexToml(block).servers.get(as)?.spec.command ? block : null;
}

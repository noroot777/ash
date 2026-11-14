// 宿主登记搬进新隔离档之前的收口:**要发布的那整条里,还有没有不是当前这一份的 ash 脚本引用**。
//
// 判的是 CLI **实际会读到的值**,不是原文(第 6 轮审查:TOML 里 `"/old/mcp/dist/index.js"` 原文上
// 看不见 `mcp/dist`,codex 解码后就是旧入口;反过来行尾注释原文上看得见,codex 根本不读)。所以:
//   · JSON 族:解析后的对象,递归看每个字符串值;
//   · TOML 族:按语句逐条,把去过注释的值按 TOML 规则解码成字符串再看;有一条解不开、或者整段
//     读不通,就当作「说不准」,一律拒绝 —— 证明不了不依赖旧入口,就不发布;
//   · 每个值先把路径的等价写法归一(分隔符连写、`\` 与 `/`、`./`、`x/..`、`%2F` 之类的百分号编码),
//     再把当前入口的每一次**完整**出现抹掉(两侧得是分隔符:它也可能只是另一条更长路径的一截),
//     然后去掉引号(shell 里 `"/old/mcp/"'dist'` 拼起来就是一条路径),剩下的还看得见 ash 脚本就算残留。
//
// 静态判不了的,这里不假装能判:运行时才拼出来的路径(shell 变量展开、命令替换),以及用户自己的
// 启动器程序内部又去找旧安装 —— 那些只能看到「它是用户自己的启动方式」,跟 ash 的安装位置无关,原样搬。
import { tomlPairSpans, tomlStringValues } from "../codex-toml.js";

/** ash 脚本的提及:`…/mcp/dist/index.js`,以及 node 会解析到它的目录写法 `…/mcp/dist`。 */
const SCRIPT_MENTION = /mcp\/dist(?:\/index\.js(?![\w.-])|\/?(?![\w./-]))/i;
/** 当前入口的一次「完整出现」两侧必须是这些字符(或者值的两端)。 */
const OPEN = /[\s"'`=(,;&|]/;
const CLOSE = /[\s"'`),;&|]/;

/** 路径的等价写法归一成一种,只给判定用(不拿去发布)。 */
export function normalizePath(text: string): string {
  let out = text.replace(/[\\/]+/g, "/");
  for (let prev = ""; prev !== out;) {
    prev = out;
    out = out.replace(/\/\.(?=\/|$)/g, "").replace(/\/(?!\.\.?(?:\/|$))[^/\s"'`=;&|]+\/\.\.(?=\/|$)/g, "");
  }
  return out;
}

const percentDecoded = (text: string): string =>
  text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });

/** 一个值里有没有不是当前入口的 ash 脚本引用。 */
export function staleIn(value: string, entry: string): boolean {
  const current = normalizePath(entry);
  return [value, percentDecoded(value)].some((form) => {
    const text = normalizePath(form);
    let rest = "";
    let from = 0;
    for (let at = text.indexOf(current); at !== -1; at = text.indexOf(current, at + 1)) {
      const end = at + current.length;
      const whole = (at === 0 || OPEN.test(text[at - 1]!)) && (end === text.length || CLOSE.test(text[end]!));
      if (whole && at >= from) {
        rest += `${text.slice(from, at)} `;
        from = end;
      }
    }
    return SCRIPT_MENTION.test((rest + text.slice(from)).replace(/["'`]/g, ""));
  });
}

/** JSON 族要发布的那整条里,第一个还引用着旧 ash 脚本的字符串值(返回说给用户听的那一处)。 */
export function staleField(value: unknown, entry: string, path = ""): string | null {
  if (typeof value === "string") return staleIn(value, entry) ? `${path || "登记"} 还引用着旧的 ash 脚本` : null;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = staleField(item, entry, `${path}[${i}]`);
      if (hit) return hit;
    }
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const hit = staleField(item, entry, path ? `${path}.${key}` : key);
      if (hit) return hit;
    }
  }
  return null;
}

/** TOML 族要发布的那段里,第一条还引用着(或者说不准有没有引用)旧 ash 脚本的语句。 */
export function staleStatement(block: string, entry: string): string | null {
  const spans = tomlPairSpans(block);
  if (!spans) return "宿主那段 TOML 有语句读不通,说不准它引用了什么";
  for (const span of spans) {
    const where = `[${span.table.join(".")}] 里的 ${span.path.join(".")}`;
    const values = tomlStringValues(span.value);
    if (!values) return `${where} 按 TOML 解不开,说不准它引用了什么`;
    if (values.some((value) => staleIn(value, entry))) return `${where} 还引用着旧的 ash 脚本`;
  }
  return null;
}

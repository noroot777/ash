// 界面上看得见的产品名残留：改名 Navi 之后，旧名 ash 不论大小写（ash / Ash / ASH）都不该再出现在
// 给人看的文字里。由 check-conventions.mjs 调用，跟它一起挂在前端 build 前置。
//
// 扫的是「展示文字」这一层：web 与 mobile 源码里的 JSX 文本、字符串和模板字面量（注释不算，按语法树取），
// 以及 web 样式表里 `content:` 生成的文字（DOM 正文里读不到它，只扫正文会漏）。
// 仍然叫 ash 的标识符照常放行，判据是它贴着标识符记号：`ash-accepted`、`ash/<id8>`、`[ash]` 日志前缀、
// `~/ash-workspaces`、`mcp__ash__`、`"ash"` 这类，以及整串就是一个标识符的字面量（`kind === "ash"`）。
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const DIRS = ["web/src", "mobile/src", "mobile/app", "mobile/components"];
const BRAND = /(?<![\w\-./@[$\\~#%'"`])(?:ash|Ash|ASH)(?![\w\-/@\]=%'"`]|[.:][\w/])/;
const IDENTIFIER = /^[\w@./:\-[\]]*$/;

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out; // 这个目录不存在（手机端目录随版本有增减）
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(path);
  }
  return out;
}

const shows = (text) => {
  const trimmed = text.trim();
  return BRAND.test(trimmed) && !IDENTIFIER.test(trimmed);
};

/** 返回 `路径:行  文字` 形式的命中清单；空数组 = 没有残留。 */
export function brandTextHits(root) {
  const hits = [];
  for (const dir of DIRS) {
    for (const file of walk(join(root, dir))) {
      const rel = relative(root, file);
      const src = readFileSync(file, "utf8");
      if (file.endsWith(".css")) {
        src.split("\n").forEach((line, i) => {
          for (const m of line.matchAll(/content:\s*(["'])(.*?)\1/g)) if (shows(m[2])) hits.push(`${rel}:${i + 1}  ${m[2]}`);
        });
        continue;
      }
      const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
        if ((ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
          || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && shows(node.text)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          hits.push(`${rel}:${line}  ${node.text.trim().slice(0, 72)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }
  return hits;
}

// 从日志里抽「最后那个致命错误块」+ 末尾几行,逐行截断,避免整份 DOM 快照灌进上下文。
import { readFileSync, existsSync } from "node:fs";
const CAP = Number(process.env.DIGEST_CAP ?? 240);
const SPAN = Number(process.env.DIGEST_SPAN ?? 22);
const clip = (s) => (s.length > CAP ? s.slice(0, CAP) + ` …[+${s.length - CAP}B]` : s);
const FATAL = /^(AssertionError|TypeError|RangeError|ReferenceError|SyntaxError|Error):|^(Error|AssertionError|TypeError) \[|^(locator|page|browserType|expect)\.[a-zA-Z]+:|^\s*throw |MODULE_NOT_FOUND|Cannot find module/;
for (const f of process.argv.slice(2)) {
  const path = f.startsWith("/") ? f : new URL(`../${f}`, import.meta.url).pathname;
  console.log(`\n######## ${f}`);
  if (!existsSync(path)) { console.log("  (日志不存在)"); continue; }
  const lines = readFileSync(path, "utf8").split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) if (FATAL.test(lines[i])) { at = i; break; }
  if (at >= 0) {
    console.log(`  --- 致命块 @行${at + 1} ---`);
    for (const l of lines.slice(at, at + SPAN)) console.log("  " + clip(l));
  } else {
    console.log("  (没找到致命块)");
  }
  const tail = lines.filter((l) => l.trim()).slice(-6);
  console.log("  --- 末尾 6 行非空 ---");
  for (const l of tail) console.log("  " + clip(l));
}

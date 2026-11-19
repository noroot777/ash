// win-remote 读回对端文件时按 UTF-8 解码。对端是 Windows PowerShell 5.1,不带 -Encoding 的
// Get-Content 按活动代码页(936)解,npm/node 写下的 UTF-8 中文就回成「涓枃杈撳嚭」。
// macOS 上没有 5.1 可跑,所以钉的是生成出来的脚本:回传读文件、锁文件读内容都带 UTF-8。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { remoteWrapper } from "./win-remote/transport.mjs";
import { lockGuardPs } from "./win-remote/lock.mjs";

const wrapper = remoteWrapper({ cmd: "node -e \"console.log('中文输出')\"", cwd: "D:\\ws", token: "0".repeat(18), timeout: 60_000, self: "10.0.0.2", port: 9 });
const stmts = wrapper.split("; ");
for (const [v, file] of [["$__t", "$__o"], ["$__g", "$__r"]]) {
  const read = stmts.find((s) => s.startsWith(`${v}=`));
  assert.ok(read, `wrapper 里有读 ${file} 的那一句`);
  assert.match(read, new RegExp(`Get-Content -LiteralPath \\${file} -Raw -Encoding UTF8\\b`), `${file} 按 UTF-8 读回:${read}`);
}

assert.match(lockGuardPs("D:\\repo", "abc"), /Get-Content -LiteralPath '[^']*win-remote\.lock' -Raw -Encoding UTF8\b/, "锁守卫报「易主」时读锁内容也按 UTF-8");

// 往后新加的读文件同样要带编码:扫 win-remote 的源码,代码里(不算注释)每个 Get-Content 都得写 -Encoding。
const dir = new URL("./win-remote/", import.meta.url);
const sources = [new URL("./win-remote.mjs", import.meta.url), ...readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => new URL(f, dir))];
const bare = [];
for (const url of sources) {
  readFileSync(url, "utf8").split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(/Get-Content\b[^)`;|]*/g)) if (!/-Encoding\s/.test(m[0])) bare.push(`${url.pathname.split("/scripts/")[1]}:${i + 1}  ${m[0].trim()}`);
  });
}
assert.deepEqual(bare, [], `这些 Get-Content 没写 -Encoding,在 5.1 上会按代码页解码:\n${bare.join("\n")}`);

console.log("✓ win-remote 读回传与锁内容按 UTF-8 解码");

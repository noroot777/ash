// 回归测试：**运行时不许再加载 `@libsql/client`**。
//
// 换掉数据库驱动的全部意义在于「Windows 上 npm install 不再需要 Visual Studio Build
// Tools」。而这件事非常容易被一行 import 悄悄作废——`drizzle-orm/libsql` 的入口第一行就是
// `import { createClient } from "@libsql/client"`，谁顺手写一句 `import { drizzle } from
// "drizzle-orm/libsql"`，那个原生模块就又被拉进进程了。macOS 上一切照常，类型检查也看不出
// 来，跑测试同样看不出来（本机装着那个包）——只有真的在解析这一刻拦一下才拦得住。
//
// 做法：起子进程，挂上 no-libsql-hook.mjs（解析到 `@libsql/*` 就 throw），在里面 import 一
// 遍真实的 db 层，看能不能干净跑完。外加一条静态扫描兜住那些还没被 import 到的文件。
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(here, "..");
const hookUrl = pathToFileURL(join(here, "no-libsql-hook.mjs")).href;

function run(entry: string): { ok: boolean; out: string } {
  // db/index.ts 一被 import 就会开库文件，给它临时库，别碰用户的。
  const tmp = mkdtempSync(join(tmpdir(), "harness-no-libsql-"));
  try {
    const res = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--import", hookUrl, "--input-type=module", "--eval", entry],
      {
        cwd: serverRoot,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, HARNESS_DB: join(tmp, "probe.db") },
      },
    );
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    return { ok: res.status === 0 && out.includes("PROBE_OK"), out };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ① 反向自检：钩子本身得真的会拦。少了这一步，钩子哪天失效了正向用例照样「通过」，
//    这个测试就成了只会报平安的摆设。
//    包名拼出来而不是写死，是为了不被下面第 ③ 步的静态扫描当成违规——本文件也在扫描范围内。
const LIBSQL_PKG = ["@libsql", "client"].join("/");
const control = run(`import "${LIBSQL_PKG}"; console.log("PROBE_OK");`);
if (control.ok || !control.out.includes("LIBSQL_LOADED")) {
  console.error("[no-libsql] 钩子没生效：直接 import @libsql/client 居然没被拦下");
  console.error(control.out.slice(-2000));
  process.exit(1);
}
console.log("[no-libsql] 钩子自检通过（直接 import @libsql/client 会被拦）");

// ② 正向：真实的 db 层不应该碰到 @libsql/*。
const dbEntry = pathToFileURL(join(serverRoot, "src/db/index.ts")).href;
const seedEntry = pathToFileURL(join(serverRoot, "src/preview-seed.ts")).href;
const real = run(`import "${dbEntry}"; import "${seedEntry}"; console.log("PROBE_OK");`);
if (!real.ok) {
  if (real.out.includes("LIBSQL_LOADED")) {
    console.error("[no-libsql] 有代码在运行时加载了 @libsql/client —— Windows 会因此重新需要原生编译：");
    for (const line of real.out.split("\n")) {
      if (line.includes("LIBSQL_LOADED")) console.error(`  ${line.trim()}`);
    }
    console.error("  改用 `drizzle-orm/libsql/driver-core`，见 server/src/db/index.ts 的注释");
  } else {
    console.error("[no-libsql] 探针没跑通，但不是因为 @libsql —— 原始输出：");
    console.error(real.out.slice(-3000));
  }
  process.exit(1);
}
console.log("[no-libsql] db 层全程没有加载 @libsql/*");

// ③ 静态兜底：探针只覆盖被 import 到的那些文件。剩下的靠扫源码——两个坏 specifier，
//    `@libsql/*` 和 `drizzle-orm/libsql` 的**入口**（子路径 driver-core / session 是干净的，
//    放行）。只认真正的 import 形态（`from "x"` / 裸 `import "x"` / `import("x")`），因为这
//    两个名字出现在注释和字符串里是正常的——本文件和那个钩子就全是在讲它们。
const badSpecifier = String.raw`(?:@libsql\/[^"']*|drizzle-orm\/libsql)`;
const BAD = [
  new RegExp(String.raw`\bfrom\s+["']${badSpecifier}["']`),
  new RegExp(String.raw`^\s*import\s+["']${badSpecifier}["']`),
  new RegExp(String.raw`\bimport\s*\(\s*["']${badSpecifier}["']`),
];
const isComment = (line: string) => /^(\/\/|\/\*|\*)/.test(line.trim());
const offenders: string[] = [];
function scan(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "drizzle") continue;
      scan(p);
      continue;
    }
    if (!e.name.endsWith(".ts") && !e.name.endsWith(".mjs")) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (isComment(line)) continue;
      if (!BAD.some((re) => re.test(line))) continue;
      offenders.push(`${relative(serverRoot, p)}: ${line.trim().slice(0, 100)}`);
    }
  }
}
scan(join(serverRoot, "src"));
scan(here);
if (offenders.length) {
  console.error("[no-libsql] 这些地方仍然引用了 libsql：");
  for (const f of offenders) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[no-libsql] 源码里没有残留的 libsql import");
console.log("[no-libsql] all checks passed");

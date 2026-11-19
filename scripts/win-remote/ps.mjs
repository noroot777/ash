/**
 * PowerShell 单引号字面量的**唯一**转义入口。
 *
 * 为什么要单独一个文件:这个转义原来在三个地方各写各的 —— `lock.mjs` 有个私有 `q()`、
 * `sync.mjs` 的 `workspaceGuardPs` 手写 `.replace(/'/g, "''")`、`transport.mjs` 的 `$__d`
 * 又写了一遍,而 `sync.mjs` 自己那份 PS 模板(`$repo = '<path>'`、`Join-Path $repo '<rel>'`)
 * **漏了**。结果是:守卫层挡得住带撇号的路径,主路径反而挡不住 —— 用户名或
 * `WIN_REMOTE_WORKSPACE` 里有一个 `'`(Windows 完全允许 `O'Brien`、`foo'bar`),
 * 单引号提前闭合,后面整段脚本被当字符串吞到下一处 `'`,整份 `.ps1` ParserError,
 * 同步固定失败,而报错行还落在八竿子打不着的提示语上。
 *
 * 「每处各自记得转义」不是个能保住的约定:新加一处插值就是新加一条漏网的路。所以从此
 * **所有**要进 PS 单引号的字符串都走这里,模板里不再出现裸的 `'${...}'`。
 */

/** 转义并**连引号一起**返回,所以模板里写 `${psq(x)}` 而不是 `'${psq(x)}'`。 */
export const psq = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;

/**
 * 读对端一个文本文件的全文,按 UTF-8 解码,读不到给空串。`path` 是 PS 表达式(`$__o` 或 `psq(...)`)。
 *
 * 不带 `-Encoding` 的 `Get-Content` 在 Windows PowerShell 5.1 上按活动代码页(中文机器 936)解码,
 * 而这里读的东西 —— npm/node/tsx 重定向出来的输出、锁文件 —— 落盘的都是 UTF-8 字节,
 * 中文就回成「鉁?璺緞」。7 默认是 UTF-8,所以只在 5.1 上坏,开发机上看不出来。
 * 显式写 UTF8 两代行为一致(有 BOM 也会剥掉)。仍用 `Get-Content` 而不是 `[IO.File]::ReadAllText`:
 * 后者按 FileShare.Read 打开,而超时被杀之后可能还有脱链的孙进程握着输出文件的写句柄,
 * 那样它会直接抛共享冲突、把已经写下的输出整份丢掉;`Get-Content` 允许别人同时在写。
 */
export const psReadText = (path) => `[string](Get-Content -LiteralPath ${path} -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)`;

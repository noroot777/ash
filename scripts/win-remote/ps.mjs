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

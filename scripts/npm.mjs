// 根脚本怎么在 Windows 上叫得动 npm。
//
// Windows 上 npm 是 `npm.cmd`,而 Node 自 CVE-2024-27980 起拒绝在没有 `shell` 的情况下
// 执行批处理 —— 直接 `spawn("npm", …)` 会 EINVAL,整条 dev 链起不来。
//
// 这里开 `shell: true` 是安全的:根脚本传的参数全是写死的字面量(`-w`、`server`、`run`),
// 没有任何用户可控内容。**要跑用户参数的那条路不能这么写** —— 那边走
// `server/src/executors/bin-resolve.ts` 的垫片拆封 + 显式引号,两者别混用。
export const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
export const NPM_SPAWN_OPTS = process.platform === "win32" ? { shell: true } : {};

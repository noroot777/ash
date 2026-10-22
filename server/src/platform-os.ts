// 「这是哪个操作系统」**两个常量,一个 import 都没有**。
//
// 独占一个文件是为了打断一个环:platform.ts(系统调用那一半)和 platform-paths.ts
// (纯路径那一半)都要用它,而 platform.ts 又要把路径那一半原样转出去 —— 两边互相 import
// 时 ESM 会先求值被依赖的那一侧,于是 `export const PATH_DELIMITER = IS_WINDOWS ? …` 撞上
// TDZ(`Cannot access 'IS_WINDOWS' before initialization`,实测)。叶子模块没有这个问题。
//
// 对外仍然从 platform.ts 取(它原样转出),所以既有的使用方一行都不用改。
export const IS_WINDOWS = process.platform === "win32";
export const IS_MAC = process.platform === "darwin";

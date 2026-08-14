// 模块解析钩子：只要有人在运行时 import `@libsql/*` 就当场炸。
// 由 test-no-libsql.ts 通过 `node --import` 挂上，用途见那个文件的顶部注释。
//
// 用 `registerHooks`(同线程同步钩子)而不是 `register`：后者在 Node 26 已经打上
// DEP0205，而且要多起一个 loader 线程；这里只需要在解析这一刻拦一下。
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@libsql/")) {
      throw new Error(`LIBSQL_LOADED: ${specifier} <- ${context.parentURL ?? "?"}`);
    }
    return next(specifier, context);
  },
});

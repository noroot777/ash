// 服务入口，只做一件事：跑的是 mac app 里那份代码时先拿到代码锁（@navi/shared/code-lock），再加载服务本体
// （main.ts）。拿锁之前一个业务模块都不读：换包那几秒里起来的进程等在锁上，等到之后读到的是一整份新代码。
import { holdCodeLock } from "@navi/shared/code-lock";

holdCodeLock();
// 先拿库的单例锁、再加载会开库的服务本体（为什么非得分两步见 startup-lock.ts）。
await import("./startup-lock.js");
await import("./main.js");

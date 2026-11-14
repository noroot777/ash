#!/usr/bin/env node
// ash MCP 入口，只做一件事：跑的是 mac app 里那份代码时先拿到代码锁（@ash/shared/code-lock），再加载本体
// （main.ts）。拿锁之前一个业务模块都不读：换包那几秒里起来的进程等在锁上，等到之后读到的是一整份新代码。
import { holdCodeLock } from "@ash/shared/code-lock";

holdCodeLock();
await import("./main.js");

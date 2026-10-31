// `hostCliPolicy` 的 React 绑定。
//
// 单独一个文件,是因为那一份**刻意不 import 任何东西**(它夹在 api.ts 与
// cliModelCatalog.ts 中间,一 import 就成环)。订阅口已经现成,这里只是把它接到
// `useSyncExternalStore` 上:政策在页面开着的时候就能被设置页改掉,组件得跟着翻面。
import { useSyncExternalStore } from "react";
import { hostCliIsolated, onHostCliPolicyChange } from "./hostCliPolicy.ts";

/** 宿主机那份 CLI 登录态对任务算不算数。与服务端 `isHostCliIsolated()` 同一条判据。 */
export function useHostCliIsolated(): boolean {
  return useSyncExternalStore(onHostCliPolicyChange, hostCliIsolated, () => false);
}

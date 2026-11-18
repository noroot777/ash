// 副作用模块：main.tsx 的第一个 import。其余模块有的在被 import 的那一刻就读存储（theme.ts），
// 所以挪键必须先于它们执行（ESM 按 import 的先后求值）。说明见 storageRename.ts。
import { renameLegacyStorageKeys } from "./storageRename.ts";

for (const pick of [() => window.localStorage, () => window.sessionStorage]) {
  try {
    renameLegacyStorageKeys(pick());
  } catch {
    // 隐私模式 / 禁用存储时拿 Storage 本身就会抛：没有存储也就没有旧键可挪。
  }
}

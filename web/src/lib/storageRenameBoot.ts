// 副作用模块：main.tsx 的第一个 import。其余模块有的在被 import 的那一刻就读存储（theme.ts），
// 所以挪键必须先于它们执行（ESM 按 import 的先后求值）。说明见 storageRename.ts。
import { keepLegacyReadable, renameLegacyStorageKeys } from "./storageRename.ts";

for (const pick of [() => window.localStorage, () => window.sessionStorage]) {
  let storage: Storage;
  try {
    storage = pick();
  } catch {
    continue; // 隐私模式 / 禁用存储时拿 Storage 本身就会抛：没有存储也就没有旧键可挪。
  }
  try {
    const { stuck } = renameLegacyStorageKeys(storage);
    if (stuck.length > 0) {
      console.warn(`[navi] 存储快满，${stuck.length} 条旧数据这次没挪到新名下，先照旧读：`, stuck.map((entry) => entry.legacyKey));
      keepLegacyReadable(storage, stuck);
    }
  } catch {
    // 读写存储本身出错：旧键原样留着，下次启动再挪。
  }
}

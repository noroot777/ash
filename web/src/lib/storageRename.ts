// 本机存储（localStorage / sessionStorage）里的键一律挂在 `navi:` / `navi.` 前缀下。项目改过两次名
// （harness → ash → navi），老版本页面存下的偏好、草稿、布局还挂在旧前缀上：页面一启动、任何模块读存储
// 之前（main.tsx 第一行 import 的 storageRenameBoot.ts），把它们整批挪到新前缀。之后各处只认新键，不必
// 每读一处就回头找一次旧的。
//
// 新键已经在（比如另一个已升级的标签页先写过）就以新的为准，旧的直接丢掉。挪完旧键就删掉：还开着的
// 老版本标签页读到的会是空值，只是那一页的偏好回到默认，刷新一下就是新版本、读得到挪过来的那份。
//
// 下面这张表里的旧前缀是兼容值：批量改名时别把它们也换成 navi，不然旧数据就没人认了。
export const LEGACY_STORAGE_PREFIXES: readonly (readonly [legacy: string, current: string])[] = [
  ["ash:", "navi:"],
  ["ash.", "navi."],
  ["harness-next:", "navi:"],
];

type KeyValueStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">;

/** 把一份存储里挂在旧前缀下的键挪到新前缀，返回挪过（或因新键已在而丢掉）的旧键数。 */
export function renameLegacyStorageKeys(storage: KeyValueStorage): number {
  // 先把键名抄下来再动：边遍历边增删，key(i) 的顺序会变。
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  let moved = 0;
  for (const key of keys) {
    const rule = LEGACY_STORAGE_PREFIXES.find(([legacy]) => key.startsWith(legacy));
    if (!rule) continue;
    const value = storage.getItem(key);
    if (value === null) continue;
    const next = rule[1] + key.slice(rule[0].length);
    // 写不进去（配额满）就留着旧键，下次启动再挪，不拿丢数据换一个干净的存储。
    if (storage.getItem(next) === null) {
      try {
        storage.setItem(next, value);
      } catch {
        continue;
      }
    }
    storage.removeItem(key);
    moved++;
  }
  return moved;
}

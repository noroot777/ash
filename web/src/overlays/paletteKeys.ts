// 命令面板里「键位」这一栏的两条判据：怎么筛得到、打完回车算不算直达。
//
// 显示成 `T T`（照着念的写法），敲进来的是 `tt`（连着打的写法）。两种形态必须都算数：
// 只认带空格的那一种，就会出现「打 tt 一条不剩，回车也没反应」—— 键位本来就是给人
// 照着敲的，敲的人不会替你补空格。
export function normalizeKeys(keys: string | undefined): string {
  return (keys ?? "").replace(/\s+/g, "").toLowerCase();
}

// 搜索面里额外挂上去空格的形态，让 `tt` 和 `t t` 筛出同一条。
export function keysSearchText(keys: string | undefined): string {
  return keys ? `${keys} ${normalizeKeys(keys)}` : "";
}

// 回车直达：整串输入恰好就是某条的键位。空输入不算 —— 那时候回车该按高亮行走。
export function matchesKeysQuery(keys: string | undefined, query: string): boolean {
  const typed = normalizeKeys(query);
  return !!keys && typed.length > 0 && normalizeKeys(keys) === typed;
}

// 首启向导的**版本边界**:这台 ash 在向导出现之前就已经在干活了吗。
//
// 向导出不出,判据只有一条持久记录(`onboardedAt`,个人面)。但这个键是这一版才有的,
// 老库里一个字都没有 —— 只认它的话,每台升上来的实例都会被糊一屏「欢迎,先加供应商」。
//
// 豁免因此放在这里**一次性**定下来,而不是每次 `/auth/state` 拿实时业务列表反推。
// 反推过一版,代价是:首装的人在向导里刚注册完执行器、一刷新向导就自己消失了(资源
// 存在只能证明资源存在,证明不了「这个人被领着走过一遍」);被提前加进共享项目的新
// 同事更是整段跳过。判据钉在边界上,这两种误判同时消失。
//
// 边界标记**单独一行**(`onboardingBaseline`),不复用 `onboardedAt`:空库首装那一遍
// 什么都不该盖章,没有独立标记就区分不出「跑过、结论是不盖」和「还没跑过」。它不是
// `AppSettings` 的键,而 `getAppSettings` 读到不认识的键会跳过(`isSettingKey`),所以
// 这一行对设置接口完全不可见。
import type { Client } from "./node-sqlite-client.js";

export const ONBOARDING_BASELINE_KEY = "onboardingBaseline";

/** 边界上就已经存在的东西 —— 有任何一样,这台机器就不是今天才装的。 */
async function hasPriorWork(client: Client): Promise<boolean> {
  for (const table of ["agents", "projects"]) {
    const rows = await client.execute(`SELECT 1 FROM ${table} LIMIT 1`);
    if (rows.rows.length) return true;
  }
  return false;
}

export async function stampOnboardingBaseline(client: Client): Promise<void> {
  try {
    const marked = await client.execute({
      sql: "SELECT 1 FROM app_settings WHERE key = ? LIMIT 1",
      args: [ONBOARDING_BASELINE_KEY],
    });
    if (marked.rows.length) return; // 这台机器早就过了边界,判据到此为止
    const stamp = JSON.stringify(new Date().toISOString());
    // 标记**先写**。之后哪一步崩了,老实例最多被多领一遍向导(走完就不再出);反过来
    // 先盖章的话,一台空库实例「这一遍还没跑完」的状态会在下次启动时被它自己刚建出来
    // 的执行器盖掉 —— 那正是要修掉的那个误判。
    await client.execute({
      sql: "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
      args: [ONBOARDING_BASELINE_KEY, stamp],
    });
    if (!(await hasPriorWork(client))) return; // 真·空库首装:一个章都不盖

    await client.execute({
      sql: "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('onboardedAt', ?)",
      args: [stamp],
    });
    // 多人模式下 `onboardedAt` 按人存,全局那行不替任何人表态(见
    // `auth/personal-settings.ts` 的 `ownPersonalSetting`)—— 所以边界上在册的人各盖
    // 一份。边界之后新建的用户没有这一行,照常被领一遍,这正是要的:他自己一个执行器
    // 都没有。
    const users = await client.execute("SELECT id FROM users");
    for (const row of users.rows) {
      await client.execute({
        sql: "INSERT OR IGNORE INTO user_settings (user_id, key, value) VALUES (?, 'onboardedAt', ?)",
        args: [String(row.id), stamp],
      });
    }
  } catch (e) {
    console.warn("[ash] 首启向导版本边界标定失败,忽略:", e);
  }
}

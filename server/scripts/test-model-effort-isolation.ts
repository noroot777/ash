// 「宿主机 CLI 额度隔离」与「已探到的档位表」必须同步翻面。
//
// 2026-10-01 第 1 轮审查复现 A/B:`cachedModelEfforts()` 原先只靠「隔离档那条路不写
// 缓存,所以自然什么都查不到」—— 那只覆盖了「一直是隔离」,漏掉**状态转换**:
// 切档之前探到的宿主机档位仍躺在缓存里(TTL 6 小时),于是目录按隔离返回兜底规则,
// 而校验链读旧缓存按 CLI 原话放行 —— 界面给得出的档位保存时被 400 拒掉,重启一次
// 又能存进去了。两套依据,同一个瞬间。
//
// 这条测试按报告要求钉**两类转换**(自用 → 多人隔离、多人共用 → 多人隔离),每一档都
// 把四个消费面一起问一遍,断言它们的依据同源:
//   ① 目录      modelCatalogFor()     —— 界面下拉能选什么
//   ② 访问器    cachedModelEfforts()  —— 三条校验链的唯一入口
//   ③ profile / 任务校验  POST /api/agents、PATCH /api/tasks/:id (真 HTTP)
//   ④ 执行器解析 resolveExecutorFor() —— 派任务前最后一道,报错文案带「依据」
//
// 判别用例选 `opencode` + `anthropic/claude-opus-4-8` + `low`:本机那份 models.dev
// 快照说它支持 low,而内置规则 `opencode:multimodel:anthropic` 只给 high/max ——
// 探针放行、规则拒绝,方向相反,任何一面没跟上翻面都会露出来。
//
// 跑法(自带临时库与临时 models.dev 快照):
//   npm -w server run test:model-effort-isolation
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-effort-isolation-"));
// 不读开发机真实的 `~/.cache/opencode/models.json`:那份文件装没装、是哪天的快照都
// 不在测试掌控内。XDG_CACHE_HOME 是 opencode-model-efforts.ts 认的那个入口。
const cacheHome = join(stage, "cache");
mkdirSync(join(cacheHome, "opencode"), { recursive: true });
writeFileSync(
  join(cacheHome, "opencode", "models.json"),
  JSON.stringify({
    anthropic: {
      models: {
        "claude-opus-4-8": {
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        },
      },
    },
  }),
);
process.env.XDG_CACHE_HOME = cacheHome;
process.env.ASH_DB ||= join(stage, "effort-isolation.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-model-effort-isolation");

const { db, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, tasks } = await import("../src/db/schema.js");
const mode = await import("../src/auth/mode.js");
const { patchAppSettings } = await import("../src/app-settings.js");
const { cachedModelEfforts, modelCatalogFor, resetModelCatalogCache } = await import("../src/executors/model-probe.js");
const { resolveExecutorFor } = await import("../src/executors/index.js");
const { api } = await import("../src/routes.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { Hono } = await import("hono");
const { id, now } = await import("../src/util.js");

await ensureSchema();
mountTaskRoutes(api);
const app = new Hono();
app.route("/api", api);

const TYPE = "opencode" as const;
const MODEL = "anthropic/claude-opus-4-8";
const KEY = MODEL;
const EFFORT = "low";

const call = async (path: string, method: string, body?: unknown) =>
  app.fetch(new Request(`http://127.0.0.1:4317${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));

// 一个现成的 profile + 任务,给 ③④ 两面用。profile 不带 effort,免得它自己先被卡住。
const PROFILE = "opencode-probe-profile";
const PROJECT = id();
const TASK = id();
await db.insert(agents).values({
  id: PROFILE, name: "opencode@probe", type: TYPE, model: MODEL, extraArgs: "[]",
  reasoningEffort: null, speed: null, providerId: null, isDefault: true,
});
await db.insert(projects).values({ id: PROJECT, name: "effort-isolation", repoPath: join(stage, "repo"), createdAt: now() });
await db.insert(tasks).values({
  id: TASK, projectId: PROJECT, title: "档位依据同源", body: "不运行",
  status: "backlog", agentType: TYPE, executorId: PROFILE, model: MODEL,
  createdAt: now(), updatedAt: now(),
});

/** 把四个面一起问一遍。返回「这一面认不认 low」。 */
async function surfaces(): Promise<{
  catalog: boolean; accessor: boolean; profile: boolean; task: boolean; executor: boolean; reason: string;
}> {
  const catalog = await modelCatalogFor(TYPE);
  const accessor = cachedModelEfforts(TYPE);
  const profileRes = await call("/api/agents", "POST", {
    name: `probe-${Date.now()}`, type: TYPE, model: MODEL, reasoningEffort: EFFORT,
  });
  const taskRes = await call(`/api/tasks/${TASK}`, "PATCH", { reasoningEffort: EFFORT });
  let executor = true;
  let reason = "";
  try {
    await resolveExecutorFor({ executorId: PROFILE, type: TYPE, model: MODEL, reasoningEffort: EFFORT });
  } catch (error) {
    executor = false;
    reason = (error as Error).message;
  }
  return {
    catalog: (catalog.modelEfforts?.[KEY] ?? []).includes(EFFORT),
    accessor: (accessor?.[KEY] ?? []).includes(EFFORT),
    profile: profileRes.status === 201,
    task: taskRes.status === 200,
    executor,
    reason,
  };
}

/** 五个面必须给出同一个答案 —— 不一致正是那个 bug 的形状。 */
function assertAgree(label: string, got: Awaited<ReturnType<typeof surfaces>>, expected: boolean): void {
  const faces = { 目录: got.catalog, 访问器: got.accessor, profile校验: got.profile, 任务校验: got.task, 执行器解析: got.executor };
  for (const [name, value] of Object.entries(faces)) {
    assert.equal(value, expected, `${label}:${name} 认为 low ${value ? "可用" : "不可用"}，应为 ${expected ? "可用" : "不可用"}（全部：${JSON.stringify(faces)}）`);
  }
}

// ── ① 自用 → 多人隔离 ──────────────────────────────────────────────────────
const solo = await surfaces();
assertAgree("自用模式", solo, true);
assert.ok(
  (await modelCatalogFor(TYPE)).modelEfforts?.[KEY]?.includes("xhigh"),
  "自用模式下应拿到快照里的完整档位（低于并集的那几个由 CLI 并集求交裁掉）",
);

await mode.setInstanceMode("multi", join(stage, "root"), false);
assert.equal(await mode.isHostCliIsolated(), true, "sharedHostCli=false 的多人模式就是隔离档");
const isolatedFromSolo = await surfaces();
assertAgree("自用 → 多人隔离", isolatedFromSolo, false);
assert.match(
  isolatedFromSolo.reason,
  /依据：ash 内置规则/,
  `隔离档下的拒绝必须说清依据来自内置规则，got: ${isolatedFromSolo.reason}`,
);
// 缓存里那份宿主机探测结果**还在**(TTL 6 小时没到) —— 这正是复现 A 的前置条件。
// 访问器必须在它仍然存在的情况下拒绝端出来,而不是依赖「缓存已经空了」。
assert.equal(cachedModelEfforts(TYPE), undefined, "隔离档下访问器必须返回 undefined");

// ── ② 多人共用 → 多人隔离 ──────────────────────────────────────────────────
resetModelCatalogCache();
await patchAppSettings({ sharedHostCli: true });
assert.equal(await mode.isHostCliIsolated(), false, "共用宿主机 CLI 的多人模式不是隔离档");
assertAgree("多人共用", await surfaces(), true);

await patchAppSettings({ sharedHostCli: false });
assert.equal(await mode.isHostCliIsolated(), true, "改回不共用就该是隔离档");
const isolatedFromShared = await surfaces();
assertAgree("多人共用 → 多人隔离", isolatedFromShared, false);
assert.equal(cachedModelEfforts(TYPE), undefined, "共用→隔离同样要让旧结果立刻失效");

console.log("✓ 档位依据在自用 / 多人共用 / 多人隔离三档之间同源翻面（五个消费面一致）");

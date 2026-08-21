// 起手式库的「三种来源合成一种条目」语义（server/src/workflows.ts）。
//
// 钉住的是产品承诺里最容易被后续重构悄悄破坏的那几条：
//   ① 系统自带的**改得动**（就地改，不 fork 出「标准交付 的副本」）
//   ② 系统自带的**删不掉**，但停用得了 —— 对开箱自带的东西说「彻底删除」是句假话
//   ③ 改坏了**永远能退回去**：restore = 删覆写行，连同停用状态一起清
//   ④ 自带条目的 id 恒等于内置 key，被覆写/恢复都不变 —— 否则项目默认引用会悬空
//   ⑤ 三级作用域每一级都可能指向没了的条目：**往下落一级，不报错**
//
// 跑法：npm -w server run test:workflow-library
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-workflow-library-"));
process.env.ASH_DB = join(root, "ash.db");

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.error(`✗ ${name}\n    expected ${e}\n    actual   ${a}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, workflows } = await import("../src/db/schema.js");
  const { patchAppSettings } = await import("../src/app-settings.js");
  const { findWorkflow, listWorkflows, resolveWorkflowDef } = await import("../src/workflows.js");
  const { BUILTIN_WORKFLOWS, builtinWorkflowDef } = await import("@ash/shared/workflow-presets");
  const { makeStep } = await import("@ash/shared/workflow");
  const { eq, isNull } = await import("drizzle-orm");
  await ensureSchema();

  const at = "2026-08-04T00:00:00.000Z";
  await db.insert(projects).values({ id: "p1", name: "test", repoPath: root, createdAt: at });

  // ── 空库：看到的就是出厂那几条，顺序固定 ────────────────────────────────
  const fresh = await listWorkflows();
  check("空库列出全部自带", fresh.map((w) => w.id), BUILTIN_WORKFLOWS.map((b) => b.key));
  check("自带都标 builtin", fresh.every((w) => w.builtin && !w.modified && !w.disabled), true);
  check("自带没有 updatedAt", fresh[0]!.updatedAt, null);

  // 底层写覆写行的路径与 PATCH 端点共用 writeOverride，这里直接调库函数验证读侧合成
  const override = async (key: string, patch: Record<string, unknown>) => {
    const existing = (await db.select().from(workflows).where(eq(workflows.builtinKey, key))).at(0);
    if (existing) {
      await db.update(workflows).set({ ...patch, updatedAt: at }).where(eq(workflows.id, existing.id));
      return;
    }
    const meta = BUILTIN_WORKFLOWS.find((b) => b.key === key)!;
    await db.insert(workflows).values({
      id: `ov-${key}`, builtinKey: key, name: meta.name, description: meta.desc,
      def: JSON.stringify(builtinWorkflowDef(key)!), disabled: false,
      createdAt: at, updatedAt: at, ...patch,
    });
  };

  // ── ①④ 自带的就地改：id 不变、名字跟着变、标上「已改过」 ────────────────
  const tweaked = builtinWorkflowDef("standard")!;
  tweaked.steps.splice(1, 0, makeStep("command", "extra"));
  (tweaked.steps[1]!.p as { cmd: string }).cmd = "npm run lint";
  await override("standard", { name: "我们的标准线", def: JSON.stringify(tweaked) });
  const edited = (await findWorkflow("standard"))!;
  check("改过之后 id 还是内置 key", edited.id, "standard");
  check("名字就地生效", edited.name, "我们的标准线");
  check("标上已改过", [edited.builtin, edited.modified], [true, true]);
  check("站数跟着变", edited.def.steps.length, 5);
  check("没有 fork 出第二条", (await listWorkflows()).filter((w) => w.name === "我们的标准线").length, 1);
  check("库里条目总数不变", (await listWorkflows()).length, BUILTIN_WORKFLOWS.length);

  // ② 停用不算「改过」：只是不在菜单里出现
  await override("fast", { disabled: true });
  const off = (await findWorkflow("fast"))!;
  check("停用了", off.disabled, true);
  check("停用不算改过", off.modified, false);

  // ── ③ restore = 删覆写行，内容和停用状态一起回到出厂 ────────────────────
  await db.delete(workflows).where(eq(workflows.builtinKey, "standard"));
  const restored = (await findWorkflow("standard"))!;
  check("恢复后名字回来", restored.name, BUILTIN_WORKFLOWS.find((b) => b.key === "standard")!.name);
  check("恢复后线回到出厂", restored.def, builtinWorkflowDef("standard"));
  check("恢复后不再标改过", [restored.modified, restored.disabled], [false, false]);

  // ── 用户自建条目 ────────────────────────────────────────────────────────
  const own = { workspace: "isolated" as const, steps: [makeStep("run", "s1"), makeStep("human", "s2")] };
  await db.insert(workflows).values({
    id: "mine", builtinKey: null, name: "我的线", description: "",
    def: JSON.stringify(own), disabled: false, createdAt: at, updatedAt: at,
  });
  const mine = (await findWorkflow("mine"))!;
  check("自建条目读得到", [mine.id, mine.name, mine.builtin], ["mine", "我的线", false]);
  check("自建排在自带后面", (await listWorkflows()).at(-1)!.id, "mine");
  check("按 id 查自建不会串到覆写行", (await findWorkflow("ov-fast")), null);

  // ── ⑤ 三级作用域：显式 → 项目 → 全局 → 出厂推荐 ─────────────────────────
  check("什么都没设 → 出厂推荐", (await resolveWorkflowDef({ projectId: "p1" })).id, "standard");

  await patchAppSettings({ defaultWorkflowId: "mine" });
  check("全局默认生效", (await resolveWorkflowDef({ projectId: "p1" })).id, "mine");

  await db.update(projects).set({ workflowId: "frontend" }).where(eq(projects.id, "p1"));
  check("项目默认压过全局", (await resolveWorkflowDef({ projectId: "p1" })).id, "frontend");
  check("没给项目就跳过这一级", (await resolveWorkflowDef({})).id, "mine");

  check("任务显式选的压过项目", (await resolveWorkflowDef({ explicitId: "release", projectId: "p1" })).id, "release");
  check("解析出来的是完整定义", (await resolveWorkflowDef({ explicitId: "release" })).def, builtinWorkflowDef("release"));

  // 指向没了的条目 → 往下落一级，不报错
  await db.update(projects).set({ workflowId: "ghost" }).where(eq(projects.id, "p1"));
  check("项目默认悬空就落到全局", (await resolveWorkflowDef({ projectId: "p1" })).id, "mine");
  check("显式选的悬空也照样落下去", (await resolveWorkflowDef({ explicitId: "ghost", projectId: "p1" })).id, "mine");

  // 停用的条目不该被「继承」到，但显式选它仍然给（用户此刻就是要它）
  await db.update(workflows).set({ disabled: true }).where(eq(workflows.id, "mine"));
  check("全局默认指向停用条目就落到出厂推荐", (await resolveWorkflowDef({})).id, "standard");
  check("显式选停用的条目照给", (await resolveWorkflowDef({ explicitId: "mine" })).id, "mine");

  // 全局默认也没了 → 出厂推荐永远兜得住
  await db.delete(workflows).where(isNull(workflows.builtinKey));
  await patchAppSettings({ defaultWorkflowId: "gone" });
  check("最后一级永远兜得住", (await resolveWorkflowDef({ projectId: "p1" })).id, "standard");

  // ── 坏数据不能把整个库打成 500 ──────────────────────────────────────────
  await override("release", { def: "{ 这不是 json" });
  const broken = (await findWorkflow("release"))!;
  check("坏 JSON 退回出厂定义", broken.def, builtinWorkflowDef("release"));
  await override("release", { def: JSON.stringify({ workspace: "isolated", steps: [{ kind: "accept" }] }) });
  check("过不了闸的线也退回出厂定义", (await findWorkflow("release"))!.def, builtinWorkflowDef("release"));
  check("库还能整体列出来", (await listWorkflows()).length, BUILTIN_WORKFLOWS.length);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} 处不符` : "\n起手式库语义全部符合预期");
process.exit(failures ? 1 : 0);

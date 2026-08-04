// 起手式库：一条「线」（WorkflowDef）从哪儿来、能被谁改、改坏了怎么退回去。
//
// 库里只有一种条目对外形状（WorkflowItem），但底下有三种来源：
//   ① 系统自带且没动过 —— 库表里**没有行**，定义来自 shared/workflow-presets.ts
//   ② 系统自带但被改过 —— 库表里有 builtin_key = 该 key 的**覆写行**
//   ③ 用户自建         —— 库表里有 builtin_key 为空的普通行
// 「恢复系统默认」= 删掉②那行，于是自动回落到①。所以自带条目**永远删不掉、也永远
// 改得动**：删不掉是因为「彻底没了」对开箱自带的东西是句假话（下次升级它又回来了），
// 改得动是因为用户的项目跟我们预设的流程本来就不一样。想让它别出现在菜单里 → 停用。
//
// 另一条贯穿的口径：**起手式是快照不是引用**。任务创建时把 def 拷进 tasks.workflow，
// 之后改库不会追着改在跑的任务。所以这里所有写操作都不需要考虑「影响了谁」。
import type { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { WorkflowDef, WorkflowItem } from "@harness/shared/workflow";
import { normalizeWorkflowDef } from "@harness/shared/workflow";
import {
  BUILTIN_WORKFLOWS, DEFAULT_WORKFLOW_KEY, builtinWorkflowDef, isBuiltinKey,
} from "@harness/shared/workflow-presets";
import { getAppSettings, patchAppSettings } from "./app-settings.js";
import { db } from "./db/index.js";
import { projects, workflows } from "./db/schema.js";
import { id, now } from "./util.js";

type Row = typeof workflows.$inferSelect;

const MAX_NAME = 60;
const MAX_DESC = 120;

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

// 存进库的 def 一律先过收敛+闸：界面上放行、存进去被拒（或者反过来）这种事不该发生。
function parseDef(value: unknown): { def?: WorkflowDef; error?: string } {
  return normalizeWorkflowDef(value);
}

function readDef(raw: string): WorkflowDef | null {
  try {
    return parseDef(JSON.parse(raw)).def ?? null;
  } catch {
    return null;
  }
}

function rowItem(row: Row, builtinName?: string, builtinDesc?: string): WorkflowItem {
  const def = readDef(row.def);
  const factory = row.builtinKey ? builtinWorkflowDef(row.builtinKey) : null;
  return {
    id: row.builtinKey ?? row.id,
    name: row.name || builtinName || "未命名",
    description: row.description || builtinDesc || "",
    // 库里存着一条过不了闸的线（手改过库、或者闸后来收紧了）时，自带条目退回出厂定义，
    // 用户条目退回空白线——总之不能让一条坏数据把整个库的接口打成 500。
    def: def ?? factory ?? builtinWorkflowDef("blank")!,
    builtin: !!row.builtinKey,
    // 只有内容真跟出厂不一样才算「已改过」：单纯停用也会落一行覆写，那不叫改过。
    modified: !!row.builtinKey && (
      row.name !== builtinName || row.description !== builtinDesc
      || JSON.stringify(def) !== JSON.stringify(factory)
    ),
    disabled: row.disabled,
    updatedAt: row.updatedAt,
  };
}

function factoryItem(key: string, name: string, desc: string): WorkflowItem {
  return {
    id: key, name, description: desc, def: builtinWorkflowDef(key)!,
    builtin: true, modified: false, disabled: false, updatedAt: null,
  };
}

// 自带的排在前面且**顺序固定**（那是产品排的从简到繁的梯子，不该被改动时间打乱），
// 用户自建的按最近创建在前跟在后面。
export async function listWorkflows(): Promise<WorkflowItem[]> {
  const rows = await db.select().from(workflows).orderBy(desc(workflows.createdAt));
  const overrides = new Map(rows.filter((r) => r.builtinKey).map((r) => [r.builtinKey!, r]));
  const builtins = BUILTIN_WORKFLOWS.map((b) => {
    const row = overrides.get(b.key);
    return row ? rowItem(row, b.name, b.desc) : factoryItem(b.key, b.name, b.desc);
  });
  const own = rows.filter((r) => !r.builtinKey).map((r) => rowItem(r));
  return [...builtins, ...own];
}

export async function findWorkflow(itemId: string): Promise<WorkflowItem | null> {
  if (isBuiltinKey(itemId)) {
    const meta = BUILTIN_WORKFLOWS.find((b) => b.key === itemId)!;
    const row = (await db.select().from(workflows).where(eq(workflows.builtinKey, itemId))).at(0);
    return row ? rowItem(row, meta.name, meta.desc) : factoryItem(itemId, meta.name, meta.desc);
  }
  const row = (
    await db.select().from(workflows).where(and(eq(workflows.id, itemId), isNull(workflows.builtinKey)))
  ).at(0);
  return row ? rowItem(row) : null;
}

// 覆写行的 upsert：自带条目第一次被改时才落行，之后就地更新。
async function writeOverride(key: string, patch: Partial<Row>): Promise<void> {
  const existing = (await db.select().from(workflows).where(eq(workflows.builtinKey, key))).at(0);
  const meta = BUILTIN_WORKFLOWS.find((b) => b.key === key)!;
  if (existing) {
    await db.update(workflows).set({ ...patch, updatedAt: now() }).where(eq(workflows.id, existing.id));
    return;
  }
  await db.insert(workflows).values({
    id: id(), builtinKey: key,
    name: meta.name, description: meta.desc,
    def: JSON.stringify(builtinWorkflowDef(key)!),
    disabled: false, createdAt: now(), updatedAt: now(),
    ...patch,
  });
}

// ── 三级作用域 ────────────────────────────────────────────────────────────
// 任务显式选的 → 项目默认 → 全局默认 → 出厂推荐。每一级都可能指向一条被删掉或停用
// 的条目，**那就往下落一级而不是报错**：一条起手式没了不该让「新建任务」也点不动。
export async function resolveWorkflowDef(opts: {
  explicitId?: string | null;
  projectId?: string | null;
}): Promise<{ id: string; def: WorkflowDef }> {
  const chain: (string | null | undefined)[] = [opts.explicitId];
  if (opts.projectId) {
    const project = (await db.select().from(projects).where(eq(projects.id, opts.projectId))).at(0);
    chain.push(project?.workflowId);
  }
  chain.push((await getAppSettings()).defaultWorkflowId);
  for (const candidate of chain) {
    if (!candidate) continue;
    const item = await findWorkflow(candidate);
    // 显式选的即便停用了也照用（用户此刻就是要它）；被继承来的默认值则跳过停用项。
    if (item && (!item.disabled || candidate === opts.explicitId)) return { id: item.id, def: item.def };
  }
  const fallback = await findWorkflow(DEFAULT_WORKFLOW_KEY);
  return { id: DEFAULT_WORKFLOW_KEY, def: fallback?.def ?? builtinWorkflowDef(DEFAULT_WORKFLOW_KEY)! };
}

export function mountWorkflowRoutes(api: Hono): void {
  api.get("/workflows", async (c) => c.json(await listWorkflows()));

  api.get("/workflows/:id", async (c) => {
    const item = await findWorkflow(c.req.param("id"));
    return item ? c.json(item) : c.json({ error: "起手式不存在" }, 404);
  });

  api.post("/workflows", async (c) => {
    const body = await c.req.json<{ name?: unknown; description?: unknown; def?: unknown }>();
    const name = text(body.name, MAX_NAME);
    if (!name) return c.json({ error: `名称必填，且不超过 ${MAX_NAME} 个字符` }, 400);
    const parsed = parseDef(body.def);
    if (!parsed.def) return c.json({ error: parsed.error }, 400);
    const row: Row = {
      id: id(), builtinKey: null, name,
      description: text(body.description, MAX_DESC) ?? "",
      def: JSON.stringify(parsed.def), disabled: false,
      createdAt: now(), updatedAt: now(),
    };
    await db.insert(workflows).values(row);
    return c.json(rowItem(row), 201);
  });

  // 自带条目**就地改**（不悄悄 fork 成「标准交付 的副本」——那样用户下次还得自己认哪个
  // 是在用的那条）；改完带上 modified 标记 + 永远可用的「恢复系统默认」。
  api.patch("/workflows/:id", async (c) => {
    const itemId = c.req.param("id");
    const existing = await findWorkflow(itemId);
    if (!existing) return c.json({ error: "起手式不存在" }, 404);
    const body = await c.req.json<{
      name?: unknown; description?: unknown; def?: unknown; disabled?: unknown;
    }>();
    const patch: Partial<Row> = {};
    if (body.name !== undefined) {
      const name = text(body.name, MAX_NAME);
      if (!name) return c.json({ error: `名称必填，且不超过 ${MAX_NAME} 个字符` }, 400);
      patch.name = name;
    }
    if (body.description !== undefined) patch.description = text(body.description, MAX_DESC) ?? "";
    if (body.def !== undefined) {
      const parsed = parseDef(body.def);
      if (!parsed.def) return c.json({ error: parsed.error }, 400);
      patch.def = JSON.stringify(parsed.def);
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return c.json({ error: "disabled 必须是 boolean" }, 400);
      patch.disabled = body.disabled;
    }
    if (!Object.keys(patch).length) return c.json(existing);
    if (existing.builtin) await writeOverride(itemId, patch);
    else await db.update(workflows).set({ ...patch, updatedAt: now() }).where(eq(workflows.id, itemId));
    return c.json((await findWorkflow(itemId))!);
  });

  // 自带的删不掉：409 并明确指路（停用 / 恢复默认），别让前端去猜。
  api.delete("/workflows/:id", async (c) => {
    const itemId = c.req.param("id");
    if (isBuiltinKey(itemId)) {
      return c.json({ error: "系统自带的起手式删不掉，可以「停用」让它不再出现，或「恢复系统默认」" }, 409);
    }
    const existing = await findWorkflow(itemId);
    if (!existing) return c.json({ error: "起手式不存在" }, 404);
    await db.delete(workflows).where(eq(workflows.id, itemId));
    await clearReferences(itemId);
    return c.json({ deleted: true });
  });

  // 恢复系统默认 = 删掉那条覆写行。停用状态一并清掉：用户点「恢复」要的是回到刚装好
  // 的样子，不是「内容回来了但还是不在菜单里」。
  api.post("/workflows/:id/restore", async (c) => {
    const itemId = c.req.param("id");
    if (!isBuiltinKey(itemId)) return c.json({ error: "只有系统自带的起手式能恢复默认" }, 400);
    await db.delete(workflows).where(eq(workflows.builtinKey, itemId));
    return c.json((await findWorkflow(itemId))!);
  });
}

// 删掉一条用户起手式后，项目默认/全局默认里指向它的引用一并清空。留着悬空 id 也能跑
// （resolveWorkflowDef 会往下落一级），但设置页会显示成「默认：（找不到）」。
async function clearReferences(itemId: string): Promise<void> {
  await db.update(projects).set({ workflowId: null }).where(eq(projects.workflowId, itemId));
  const settings = await getAppSettings();
  if (settings.defaultWorkflowId === itemId) await patchAppSettings({ defaultWorkflowId: "" });
}

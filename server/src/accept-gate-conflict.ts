// 「让任务解决」：合并预览撞冲突时，验收台上那一行的直达出路。
//
// 从前唯一的走法是先点「验收通过」、等服务端在门禁之前被基准拦下（accept-gate.ts 的
// baselineRefusal），那时才顺手把冲突交给任务 —— 冲突明明在点之前就摆在验收台上了。这里走的是
// **同一份交接**（accept-conflict.ts 的 handOffConflict / flushConflictHandoff），判据也是同一份
// （accept-gate-state.ts 的 judgeGateBaseline），只是不绕那一按。
import { eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { flushConflictHandoff, handOffConflict } from "./accept-conflict.js";
import { acceptGateCommandOf, judgeGateBaseline } from "./accept-gate-state.js";
import { noteConflictHandoff } from "./accept-gate-conflict-registry.js";
import { beginAccepting, endAccepting } from "./acceptance-lock.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";

export async function handOffPreviewConflict(taskId: string): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  if (IS_PREVIEW_INSTANCE) return { ok: false, error: previewRefusal("交接冲突") };
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return { ok: false, error: "任务不存在" };
  if (task.archived) return { ok: false, error: "任务已归档，不能再交给它" };
  if (task.stage === "accepted" || task.stage === "merged") return { ok: false, error: "这个任务已经验收过了" };
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project || !acceptGateCommandOf(project)) return { ok: false, error: "这个项目没设验收前置命令，没有合并预览可判" };
  // 跟验收同一把互斥：交接登记与发出之间不许插进一次验收（那一按会自己再登记一份，两份唤醒）。
  if (!beginAccepting(taskId)) return { ok: false, error: "这个任务正在验收，等它结束再交" };
  let handed: { message: string } | null = null;
  let refusal = "现在没有合并预览冲突，不用交给任务";
  try {
    const { head, judged } = await judgeGateBaseline(task, project);
    const block = judged.block;
    if (block?.reason === "merge_conflict") {
      const handoff = await handOffConflict(task, { ...block, preview: true });
      if (handoff) {
        noteConflictHandoff(taskId, head, block.targetCommit);
        handed = handoff;
      } else refusal = "这份冲突缺文件或分支信息，没能交给任务";
    }
  } finally {
    endAccepting(taskId);
  }
  if (!handed) return { ok: false, error: refusal };
  // 必须在 endAccepting 之后：锁内叫醒会被验收互斥静默退避（见 accept-conflict.ts 顶部）。
  flushConflictHandoff(taskId);
  bus.publish({ type: "task.acceptGate", taskId });
  return { ok: true, message: handed.message };
}

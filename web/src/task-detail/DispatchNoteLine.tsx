import type { DispatchNote } from "./dispatchNotes.ts";

/** 会话里靠右的那一句小灰字；点它在左抽屉打开那条派出去的任务。 */
export function DispatchNoteLine({ note, onOpen }: { note: DispatchNote; onOpen: (taskId: string) => void }) {
  return (
    <p className="dispatch-note">
      <button type="button" aria-label={`打开派出的任务：${note.title}`} onClick={() => onOpen(note.id)}>
        开了新任务「{note.title}」{note.agent ? `，交给 ${note.agent}` : ""}
      </button>
    </p>
  );
}

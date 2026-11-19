import type { DispatchNote } from "./dispatchNotes.ts";

export function DispatchNoteLine({ note, onOpen }: { note: DispatchNote; onOpen: (taskId: string) => void }) {
  return (
    <p className="dispatch-note">
      <button type="button" aria-label={`打开子任务：${note.title}`} onClick={() => onOpen(note.id)}>
        开了新任务「{note.title}」{note.agent ? `，交给 ${note.agent}` : ""}
      </button>
    </p>
  );
}

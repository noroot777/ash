/** 派出去的一条：任务号、标题、交给了谁。 */
type DispatchedTask = { id: string; title: string; agent: string | null };

/** 「开了新任务〈标题〉，交给 X」。给了 `onOpen` 就是一颗键，点它在左抽屉打开那条任务；没给（远程视图）只是一句话。 */
export function DispatchNoteLine({ note, onOpen }: { note: DispatchedTask; onOpen?: (taskId: string) => void }) {
  const text = `开了新任务「${note.title}」${note.agent ? `，交给 ${note.agent}` : ""}`;
  return (
    <p className="dispatch-note">
      {onOpen
        ? <button type="button" aria-label={`打开子任务：${note.title}`} onClick={() => onOpen(note.id)}>{text}</button>
        : <span>{text}</span>}
    </p>
  );
}

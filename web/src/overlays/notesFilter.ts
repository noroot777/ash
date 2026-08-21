import type { Note } from "@ash/shared";

export type NoteConversionFilter = "all" | "converted" | "unconverted";

export const NOTE_CONVERSION_FILTERS: ReadonlyArray<{
  value: NoteConversionFilter;
  label: string;
  detail: string;
}> = [
  { value: "all", label: "全部", detail: "所有随手记" },
  { value: "converted", label: "已转任务", detail: "至少关联一个任务" },
  { value: "unconverted", label: "未转任务", detail: "尚未关联任务" },
];

export function filterNotes(
  rows: Note[],
  query: string,
  conversion: NoteConversionFilter,
  draft?: { id: string | null; body: string },
): Note[] {
  const keyword = query.trim().toLocaleLowerCase();
  return rows.filter((note) => {
    const converted = note.taskLinks.length > 0;
    if (conversion === "converted" && !converted) return false;
    if (conversion === "unconverted" && converted) return false;
    if (!keyword) return true;
    const body = note.id === draft?.id ? draft.body : note.body;
    return body.toLocaleLowerCase().includes(keyword);
  });
}

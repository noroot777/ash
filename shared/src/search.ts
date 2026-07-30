// 全局搜索(⌘K)的结果形状。纯类型文件,index.ts 只做再导出 —— 拆分理由与
// 「只能搬类型、不能搬运行时值」的原因见 ./events.ts 头部注释。
import type { TaskStatus } from "./index.js";

// One hit per task or note. Task fields rank title > body > conversation, and
// task hits are returned before note hits. `conversation` means the match was
// found inside the task's session transcripts (data/runs/<taskId>/*.md|jsonl),
// which is where run artifacts like output directory names live.
export type SearchField = "title" | "body" | "conversation";

export interface TaskSearchHit {
  kind: "task";
  id: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  projectName: string | null;
  archived: boolean;
  field: SearchField;
  // Context around the first match, whitespace-collapsed to one line.
  // Empty for title hits (the title is already shown).
  snippet: string;
  // Task body prefix for the command-palette preview.
  preview?: string;
  updatedAt: string;
}

export interface NoteSearchHit {
  kind: "note";
  id: string;
  title: string;
  projectId: string;
  projectName: string | null;
  field: "body";
  snippet: string;
  // Note body for the command-palette preview.
  preview?: string;
  updatedAt: string;
  taskId: string | null;
}

export type SearchHit = TaskSearchHit | NoteSearchHit;

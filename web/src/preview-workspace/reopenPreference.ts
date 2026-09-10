const key = (taskId: string) => `ash.annotation-reopen-dismissed.${taskId}`;
export const reopenPreferenceEvent = "ash:annotation-reopen-preference";
export function reopenDismissed(taskId: string): boolean {
  try { return localStorage.getItem(key(taskId)) === "1"; } catch { return false; }
}
export function setReopenDismissed(taskId: string, dismissed: boolean): void {
  try { localStorage.setItem(key(taskId), dismissed ? "1" : "0"); } catch { /* The current workspace also holds the preference in memory. */ }
  window.dispatchEvent(new CustomEvent(reopenPreferenceEvent, { detail: taskId }));
}

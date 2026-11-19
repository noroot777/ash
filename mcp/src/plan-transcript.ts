export function planTranscript(entries: { at: string; turnStartedAt: string; event: Record<string, unknown> }[]): string {
  const plans = new Map<string, { at: string; text: string; complete: boolean }>();
  for (const entry of entries) {
    const event = entry.event;
    if (event.kind !== "plan" || typeof event.id !== "string" || typeof event.text !== "string") continue;
    const key = `${entry.turnStartedAt}:${event.id}`;
    plans.set(key, {
      at: entry.turnStartedAt || entry.at,
      text: event.delta ? `${plans.get(key)?.text ?? ""}${event.text}` : event.text,
      complete: event.status === "complete",
    });
  }
  return [...plans.values()].filter((plan) => plan.text.trim()).map((plan) =>
    `### ${plan.complete ? "计划" : "计划草稿"} · ${plan.at}\n\n${plan.text}`,
  ).join("\n\n");
}

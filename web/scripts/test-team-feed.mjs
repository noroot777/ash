import assert from "node:assert/strict";
import { leadTurns, mergeFeed, timeMs } from "../src/team/teamData.ts";

const batch = (key, at) => ({ key, at, workers: [], serial: false });
const rowKinds = (rows) => rows.map((row) => (row.kind === "batch" ? `batch:${row.batch.key}` : `conv:${row.item.kind}`));

// ISO UTC task timestamps and space-separated conversation timestamps represent
// the same instants. Lexical comparison gets this wrong at the separator; epoch
// comparison must put a dispatch during the agent turn immediately after it.
{
  const items = [
    {
      kind: "agent",
      label: "lead",
      lines: [],
      time: "2026-07-27 16:35:00+08:00",
      endedAt: "2026-07-27 16:35:42+08:00",
    },
    { kind: "system", text: "worker finished", at: "2026-07-27 16:41:29+08:00" },
  ];
  const rows = mergeFeed(items, [batch("mixed-format", "2026-07-27T08:35:30.352Z")]);
  assert.deepEqual(rowKinds(rows), ["conv:agent", "batch:mixed-format", "conv:system"]);
}

// When TeamView mounts after live events already exist, the historical snapshot
// is intentionally absent. Dispatches older than the first visible user message
// still belong before that message, not in the final catch-all after it.
{
  const items = [
    { kind: "user", text: "latest question", at: "2026-07-27T14:33:35.116Z" },
    {
      kind: "agent",
      label: "lead",
      lines: [],
      time: "2026-07-27T14:33:35.116Z",
      endedAt: "2026-07-27T14:36:46.073Z",
    },
  ];
  const rows = mergeFeed(items, [
    batch("16:35", "2026-07-27T08:35:30.352Z"),
    batch("17:00", "2026-07-27T09:00:20.000Z"),
  ]);
  assert.deepEqual(rowKinds(rows), ["batch:16:35", "batch:17:00", "conv:user", "conv:agent"]);
}

// Invalid item times inherit the previous known boundary; invalid batch times
// have no insertion point and remain stable at the end.
{
  const items = [
    { kind: "system", text: "known", at: "2026-07-27T10:00:00.000Z" },
    { kind: "system", text: "bad", at: "not-a-time" },
    { kind: "user", text: "untimed" },
  ];
  const rows = mergeFeed(items, [
    batch("known", "2026-07-27T09:59:00.000Z"),
    batch("invalid-a", "not-a-time"),
    batch("invalid-b", ""),
  ]);
  assert.deepEqual(rowKinds(rows), [
    "batch:known",
    "conv:system",
    "conv:system",
    "conv:user",
    "batch:invalid-a",
    "batch:invalid-b",
  ]);
}

{
  const turns = leadTurns([
    {
      kind: "agent",
      label: "lead",
      lines: [],
      time: "2026-07-27 16:35:00+08:00",
      endedAt: "2026-07-27T08:35:42.000Z",
    },
    { kind: "agent", label: "lead", lines: [], time: "invalid", endedAt: "2026-07-27T09:00:00.000Z" },
  ]);
  assert.deepEqual(turns, [{ from: timeMs("2026-07-27T08:35:00.000Z"), to: timeMs("2026-07-27T08:35:42.000Z") }]);
}

console.log("team feed timestamp tests passed");

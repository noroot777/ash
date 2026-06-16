import { fileURLToPath } from "node:url";

// Anchor data to <repo>/data regardless of launch cwd, so the DB and run
// artifacts live in one place whether started via `npm start`, `npm -w server`,
// or `tsx` in dev (DESIGN.md §11 — fixes the cwd-dependent data location).
export const DATA_DIR = fileURLToPath(new URL("../../data", import.meta.url));
export const RUNS_DIR = fileURLToPath(new URL("../../data/runs", import.meta.url));

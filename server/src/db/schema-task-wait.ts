import type { ReviewTargetIdentity } from "./schema-regression-evidence.js";

export type WaitOrigin = { kind: "ordinary" } | {
  kind: "review" | "unknown";
  directory: string;
  generation: string | null;
};

export type TaskWaitOwnership = {
  turn?: { identity: ReviewTargetIdentity; origin: WaitOrigin };
  question?: {
    occupancy: string;
    origin: WaitOrigin;
    text: string;
    options: string | null;
    items: string | null;
  };
  checkpoint?: { generation: number; origin: WaitOrigin };
};

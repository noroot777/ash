import type { ReviewTargetIdentity } from "./schema-regression-evidence.js";
import type { TaskStatus } from "@ash/shared";

export type WaitOrigin = { kind: "ordinary" } | {
  kind: "review" | "unknown";
  directory: string;
  generation: string | null;
};

export type TaskWaitOwnership = {
  repairDelivery?: { messageId: string; generation: string; identity: ReviewTargetIdentity };
  start?: {
    directory: string;
    generation: string;
    identity: ReviewTargetIdentity;
    priorStatus: TaskStatus;
    repair?: true;
  };
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

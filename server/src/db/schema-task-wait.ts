import type { ReviewDelivery, ReviewTargetIdentity } from "./schema-regression-evidence.js";
import type { TaskStatus } from "@ash/shared";

export type WaitOrigin = { kind: "ordinary" } | {
  kind: "review" | "unknown";
  directory: string;
  generation: string | null;
};

export type TaskWaitOwnership = {
  acceptedFinalization?: { directory: string; generation: string; token: string };
  repairDelivery?: { messageId: string; generation: string; identity: ReviewTargetIdentity };
  deliveredReview?: { directory: string; generation: string; identity: ReviewTargetIdentity;
    input?: ReviewDelivery; pid?: number; unitToken?: string | null; confirmedAt: string };
  start?: {
    directory: string;
    generation: string;
    identity: ReviewTargetIdentity;
    priorStatus: TaskStatus;
    repair?: true;
    acceptedRepair?: true;
    delivery?: ReviewDelivery;
    phase?: "prepared" | "launching" | "uncertain";
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

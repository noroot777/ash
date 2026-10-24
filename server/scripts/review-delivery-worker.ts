import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { RunHandle, RunOpts } from "../src/executors/types.js";
import type { scheduledMessages } from "../src/db/schema.js";

const { db } = await import("../src/db/index.js");
const { continueTask } = await import("../src/orchestrator.js");
const { deliveryOptions, monitorWakeGuard } = await import("../src/pending-verdict.js");
const { markSent } = await import("../src/pending-messages.js");
const { takeResumePrompt } = await import("../src/task-resume-prompt.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const [serialized, fault, marker] = process.argv.slice(2);
const input = JSON.parse(serialized!) as { taskId: string; text: string;
  message?: typeof scheduledMessages.$inferSelect; options?: Parameters<typeof continueTask>[2] };
const run = (options: RunOpts): RunHandle => {
  assert(options.prompt.includes(input.text));
  execFileSync(process.execPath, ["-e", "require('fs').appendFileSync(process.argv[1],'delivered\\n')", marker!]);
  return { sessionId: "review-delivery-test", commandLine: "local review delivery test", kill() {},
    events: (async function* () { yield { kind: "done" as const, exitStatus: 0 }; })() };
};
for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
  executor.run = run;
  executor.runSteerable = run;
}
const transaction = db.transaction;
db.transaction = async function (...args) {
  const stack = new Error().stack ?? "";
  if ((fault === "before" && stack.includes("assertReviewTurnStart"))
    || (fault === "after" && stack.includes("commitReviewTurnDelivery"))) process.exit(86);
  const result = await transaction.apply(this, args);
  if ((fault === "intent" && stack.includes("assertReviewTurnStart"))
    || (fault === "committed" && stack.includes("commitReviewTurnDelivery"))) process.exit(86);
  return result;
};
const delivered = await continueTask(input.taskId, input.text, {
  ...(input.message ? { ...deliveryOptions(input.message), wakeGuard: monitorWakeGuard(input.message) } : input.options),
  onDelivered: async () => {
    if (input.message) await markSent(input.message);
    else if (input.options?.reviewDelivery?.kind === "checkpoint") {
      assert(await takeResumePrompt(input.taskId, input.text, input.options.reviewDelivery.promptGeneration));
    }
  },
});
console.log("CONTINUE_RESULT", delivered);

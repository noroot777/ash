import { runServerFixture } from "./run-server-fixture.mjs";
import { checkTaskCreationOrigin } from "./task-creation-origin-checks.mjs";

await runServerFixture("test-task-creation-origin", checkTaskCreationOrigin);

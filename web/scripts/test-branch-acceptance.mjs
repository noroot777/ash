import { runServerFixture } from "./run-server-fixture.mjs";
import { checkBranchAcceptance } from "./branch-acceptance-checks.mjs";

await runServerFixture("test-branch-acceptance", checkBranchAcceptance);

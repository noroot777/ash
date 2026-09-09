import { runServerFixture } from "./run-server-fixture.mjs";
import { checkAssistantEntry } from "./assistant-entry-checks.mjs";

await runServerFixture("assistant-browser-fixture", checkAssistantEntry);

import { TestProcessScope } from "./test-process-scope.mjs";

for (const directory of process.argv.slice(2)) {
  const scope = new TestProcessScope(directory);
  await scope.stop();
  scope.remove();
}

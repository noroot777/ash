import { TestProcessScope } from "./test-process-scope.mjs";
import { readFileSync } from "node:fs";

const errors = [];
const retired = [];
const args = process.argv.slice(2);
const pending = args.length === 2 && args[0] === "--scopes" ? JSON.parse(args[1])
  : args.length ? args.map((directory) => ({ directory })) : JSON.parse(readFileSync(0, "utf8"));
for (const { directory, domain, directoryOwnership } of pending) {
  try {
    const scope = new TestProcessScope(directory, domain, directoryOwnership);
    await scope.stop();
    scope.remove();
    retired.push(directory);
  } catch (error) { errors.push(error); }
}
console.log(`ASH_TEST_SCOPE_CLEANUP=${JSON.stringify(retired)}`);
if (errors.length) throw new AggregateError(errors, "测试执行域清理未全部成功");

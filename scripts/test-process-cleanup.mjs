import { TestProcessScope } from "./test-process-scope.mjs";

const errors = [];
for (const directory of process.argv.slice(2)) {
  try {
    const scope = new TestProcessScope(directory);
    await scope.stop();
    scope.remove();
  } catch (error) { errors.push(error); }
}
if (errors.length) throw new AggregateError(errors, "测试执行域清理未全部成功");

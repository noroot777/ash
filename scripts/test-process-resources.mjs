const reportedErrors = new Set();

export function reportTestResourceError(error) {
  const errors = error instanceof AggregateError ? error.errors : [error];
  if (errors.every((entry) => reportedErrors.has(entry))) return;
  for (const entry of errors) reportedErrors.add(entry);
  console.error(error);
}

export function cleanupTestResourcesSync(cleanups, operationError) {
  const cleanupErrors = [];
  for (const cleanup of cleanups) {
    try { cleanup(); }
    catch (error) { cleanupErrors.push(error); }
  }
  const errors = [operationError, ...cleanupErrors].filter(Boolean);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const cause = errors[0];
    throw Object.assign(new AggregateError(errors,
      `测试执行或资源清理失败\n${errors.map((error) => error.stack ?? error.message).join("\n")}`, { cause }), {
      code: cause.code, stdout: operationError?.stdout, stderr: operationError?.stderr, cleanupErrors,
    });
  }
}

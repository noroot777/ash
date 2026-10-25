import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, monitors, schema, teardown } from "./monitors-fixture.js";
import { setupRegression } from "./regression-fixture.js";

try {
  const fixture = await setupRegression();
  for (const exitCode of [0, 7]) {
    const output = `SOURCE_REGRESSION_${exitCode}`;
    const monitorId = await fixture.run(`node -e "console.log('${output}');process.exit(${exitCode})"`);
    const record = (await db.select().from(schema.regressionChecks)
      .where(eq(schema.regressionChecks.monitorId, monitorId)))[0]!;
    const monitor = (await db.select().from(monitors).where(eq(monitors.id, monitorId)))[0]!;
    assert.ok(record.startedAt);
    assert.ok(record.endedAt);
    assert.equal(record.exitCode, exitCode);
    assert.equal(monitor.exitCode, exitCode);
    assert.equal(record.error, null);
    assert.ok(record.logDigest);
    assert.match(readFileSync(record.logPath, "utf8"), new RegExp(output));
  }
  console.log("✓ source-mode regression: worker startup, full logs and success/failure exit codes");
} finally {
  await teardown();
}

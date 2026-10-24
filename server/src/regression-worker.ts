import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { regressionChecks } from "./db/schema.js";
import { userShellLaunch } from "./platform.js";
import { safeRunDirectory } from "./review-evidence.js";
import { regressionLogDigest } from "./regression-files.js";
import { regressionSnapshot } from "./regression-snapshot.js";

const monitorId = process.argv[2];
try {
  const record = (await db.select().from(regressionChecks).where(eq(regressionChecks.monitorId, monitorId)))[0];
  if (!record) throw new Error("回归登记不存在");
  const claimed = await db.update(regressionChecks).set({
    before: regressionSnapshot(record.cwd), startedAt: new Date().toISOString(),
  }).where(and(eq(regressionChecks.monitorId, monitorId), isNull(regressionChecks.startedAt))).returning();
  if (!claimed.length) throw new Error("回归命令已经启动，不能重复执行");
  let code: number | null = null;
  let failure: string | null = null;
  try {
    if (!(await safeRunDirectory(dirname(record.logPath)))) throw new Error("回归日志目录不安全");
    const handle = await open(record.logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const launch = userShellLaunch(record.command);
      code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(launch.file, launch.args, {
          cwd: record.cwd, stdio: ["ignore", handle.fd, handle.fd], windowsHide: true,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await db.update(regressionChecks).set({
    after: regressionSnapshot(record.cwd), exitCode: code, error: failure,
    endedAt: new Date().toISOString(), logDigest: await regressionLogDigest(record.logPath),
  }).where(eq(regressionChecks.monitorId, monitorId));
  console.log(`REGRESSION_FINISHED exitCode=${code} monitor=${monitorId} log=${record.logPath}${failure ? ` error=${failure}` : ""}`);
  process.exitCode = code ?? 1;
} finally {
  dbClient.close();
}

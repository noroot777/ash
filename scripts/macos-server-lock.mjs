import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function macServerLockPath(repo, port) {
  const identity = `${realpathSync(repo)}\n${port}`;
  const hash = createHash("sha256").update(identity).digest("hex");
  return `/tmp/ash-server-start-${process.getuid()}-${hash}.lock`;
}

export function coordinateMacRestart(repo, port) {
  if (process.platform !== "darwin") return;
  const lock = macServerLockPath(repo, port);
  const inherited = process.env.ASH_MAC_RESTART_LOCK;
  delete process.env.ASH_MAC_RESTART_LOCK;
  if (inherited === lock) return;
  const result = spawnSync("/usr/bin/lockf", ["-k", lock, process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, ASH_MAC_RESTART_LOCK: lock },
  });
  if (result.error) process.stderr.write(`无法协调 macOS 服务重启：${result.error.message}\n`);
  process.exit(result.status ?? 1);
}

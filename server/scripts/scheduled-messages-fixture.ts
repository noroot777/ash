import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IS_WINDOWS } from "../src/platform.js";

export function installFakeClaude(root: string): string {
  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "fake-claude.js"),
    `const fs = require("fs");
let buf = "";
const resident = process.argv.includes("--input-format");
function succeed(input) {
  fs.appendFileSync(process.env.ASH_TEST_LEAD_LOG, input + "\\n");
  process.stdout.write(JSON.stringify({ type: "system", session_id: "scheduled-message-test" }) + "\\n");
  process.stdout.write(
    JSON.stringify({ type: "result", subtype: "success", session_id: "scheduled-message-test" }) + "\\n",
  );
  process.exit(0);
}
process.stdin.on("data", (d) => {
  buf += d;
  if (!resident) return;
  const i = buf.indexOf("\\n");
  if (i < 0) return;
  succeed(buf.slice(0, i));
});
process.stdin.on("end", () => {
  if (resident) return process.exit(1);
  if (!process.env.ASH_TURN_TOKEN) return process.exit(9);
  if (buf.includes("保持运行等待引导")) {
    fs.appendFileSync(process.env.ASH_TEST_LEAD_LOG, buf + "\\n");
    process.stdout.write(JSON.stringify({ type: "system", session_id: "scheduled-steer-cli-session" }) + "\\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (buf.includes("保持新方向运行")) {
    fs.appendFileSync(process.env.ASH_TEST_LEAD_LOG, buf + "\\n");
    process.stdout.write(JSON.stringify({ type: "system", session_id: "scheduled-steer-cli-session" }) + "\\n");
    setInterval(() => {}, 1000);
    return;
  }
  if (!buf) return process.exit(1);
  succeed(buf);
});
`,
  );
  writeFileSync(
    join(fakeBin, IS_WINDOWS ? "claude.cmd" : "claude"),
    IS_WINDOWS ? `@node "%~dp0fake-claude.js" %*\r\n` : `#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n`,
    { mode: 0o755 },
  );
  return fakeBin;
}

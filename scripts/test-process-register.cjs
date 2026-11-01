const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const native = require("./test-process-native.cjs");
const directory = process.env.ASH_TEST_PROCESS_SCOPE;
if (directory) {
  const domain = JSON.parse(fs.readFileSync(path.join(directory, "domain.json"), "utf8"));
  const born = native.invoke(domain.executable, ["inspect", domain.name, String(process.pid)]);
  const stream = (descriptor) => {
    try { const stat = fs.fstatSync(descriptor); return `${stat.dev}:${stat.ino}`; } catch { return null; }
  };
  const id = randomUUID();
  const pending = path.join(directory, `${id}.pending`);
  const record = { kind: "process", domain: domain.name, pid: process.pid, born,
    script: process.argv[1] ?? "", streams: [stream(1), stream(2)] };
  fs.writeFileSync(pending, JSON.stringify(record), { flag: "wx" });
  try { fs.linkSync(pending, path.join(directory, `${id}.json`)); }
  finally { fs.unlinkSync(pending); }
}

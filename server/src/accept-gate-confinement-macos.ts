import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { cachedGateMacScannerExecutable, gateMacScannerExecutable } from "./accept-gate-macos-native.js";
import { inspectProcessSync, isPidAlive } from "./platform.js";
import type { GateConfinement } from "./accept-gate-confinement.js";

export const MAC_GATE_ENV = "ASH_ACCEPT_GATE_UNIT";
export const MAC_GATE_NOTICE = "macOS 兼容监督：实际执行验收命令，按进程组、已观察后代和继承标记收尾；"
  + "不具备 cgroup/Job 的整次运行内核保证，清空标记并脱离的未观察后代可能无法识别。独立测试快照保留，不自动删除。";
export const macGateToken = (logPath: string): string => createHash("sha256").update(logPath).digest("hex");
export const isMacGateScope = (id: string | null | undefined): boolean => !!id?.startsWith("macos-observed:");

type Member = { pid: number; born: number };
type Row = Member & { ppid: number; group: number; marked: number; zombie: boolean };
type Evidence = { version: 1; id: string; pid: number; startedAt: string; rootBorn: number; members: Member[] };

export function macGateConfinement(logPath: string, pid: number, startedAt: string | null, existingId?: string): GateConfinement {
  const token = macGateToken(logPath);
  const id = `macos-observed:${token}`;
  const path = `${logPath}.macos-processes.json`;
  let executable = cachedGateMacScannerExecutable();
  let timer: NodeJS.Timeout | null = null;
  const scan = (): Row[] => {
    if (!executable) throw new Error("macOS 进程监督器尚未就绪");
    return (JSON.parse(execFileSync(executable, ["scan", `${MAC_GATE_ENV}=${token}`], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024,
    })) as { rows: Row[] }).rows;
  };
  const load = (): Evidence => {
    const evidence = JSON.parse(readFileSync(path, "utf8")) as Evidence;
    if (evidence.version !== 1 || evidence.id !== id || evidence.pid !== pid || evidence.startedAt !== startedAt
      || !Number.isSafeInteger(evidence.rootBorn) || evidence.rootBorn < 1 || !Array.isArray(evidence.members)
      || evidence.members.some(member => !member || !Number.isSafeInteger(member.pid) || member.pid < 2
        || !Number.isSafeInteger(member.born) || member.born < 1)) throw new Error("macOS 监督身份记录不匹配");
    return evidence;
  };
  const save = (evidence: Evidence) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(evidence));
    renameSync(`${path}.tmp`, path);
  };
  const reading = (): ReturnType<GateConfinement["read"]> => {
    try {
      if (existingId && existingId !== id) throw new Error("macOS 监督标识不匹配");
      const evidence = load();
      const rows = scan();
      const previous = new Map(evidence.members.map(member => [member.pid, member.born]));
      if (evidence.members.some(member => !rows.some(row => row.pid === member.pid) && isPidAlive(member.pid))) {
        throw new Error("已观察进程仍存活但原生身份读取失败，保留占用");
      }
      const root = rows.find(row => row.pid === pid);
      const groupOwned = rows.some(row => !row.zombie && row.group === pid
        && (row.marked === 1 || previous.get(row.pid) === row.born));
      const selected = new Map<number, Row>();
      for (const row of rows) {
        if (!row.zombie && (row.marked === 1 || previous.get(row.pid) === row.born
          || (groupOwned && row.group === pid && row.born >= evidence.rootBorn && (!root || root.born === evidence.rootBorn)))) selected.set(row.pid, row);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          const parent = selected.get(row.ppid);
          if (!row.zombie && !selected.has(row.pid) && parent && row.born >= parent.born) {
            selected.set(row.pid, row);
            changed = true;
          }
        }
      }
      evidence.members = [...selected.values()].map(({ pid, born }) => ({ pid, born }));
      save(evidence);
      return { kind: "members", coverage: "observed-processes", members: evidence.members.map(member => ({
        pid: member.pid, gen: String(member.born),
      })) };
    } catch (error) { return { kind: "unqueryable", why: String(error) }; }
  };
  return {
    id,
    async enroll(candidate) {
      if (existingId || candidate !== pid || !startedAt || inspectProcessSync(pid)?.startedAt !== startedAt) return false;
      executable = await gateMacScannerExecutable();
      const root = scan().find(row => row.pid === pid && row.marked === 1 && row.group === pid);
      if (!root || inspectProcessSync(pid)?.startedAt !== startedAt) return false;
      save({ version: 1, id, pid, startedAt, rootBorn: root.born, members: [{ pid, born: root.born }] });
      timer = setInterval(() => { reading(); }, 250);
      timer.unref();
      return true;
    },
    preExecEnv: () => null,
    read: reading,
    killAll(signal) {
      const read = reading();
      if (read.kind !== "members" || !executable) return 0;
      let signaled = 0;
      for (const member of read.members) {
        try {
          execFileSync(executable, ["signal", String(member.pid), member.gen!, signal === "SIGKILL" ? "9" : "15"], { timeout: 3_000 });
          signaled++;
        } catch {}
      }
      return signaled;
    },
    dispose() { if (timer) clearInterval(timer); timer = null; },
    async prepare() { executable = await gateMacScannerExecutable(); },
  };
}

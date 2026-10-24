import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cachedGateMacScannerExecutable, gateMacScannerExecutable } from "./accept-gate-macos-native.js";
import { inspectProcessSync, isPidAlive } from "./platform.js";
import type { GateConfinement } from "./accept-gate-confinement.js";

export const MAC_GATE_ENV = "ASH_ACCEPT_GATE_UNIT";
export const MAC_GATE_NOTICE = "macOS 兼容监督：实际执行验收命令，按进程组、已观察后代和继承标记收尾；"
  + "不具备 cgroup/Job 的整次运行内核保证，清空标记并脱离的未观察后代可能无法识别。独立测试快照保留，不自动删除。";
export const macGateToken = (logPath: string): string => createHash("sha256").update(logPath).digest("hex");
export const isMacGateScope = (id: string | null | undefined): boolean => !!id?.startsWith("macos-observed:");

type Member = { pid: number; born: number };
type Row = Member & { ppid: number; group: number; session: number; marked: number; zombie: boolean };
type Scan = { rows: Row[]; groupMembers: number[] };
type Evidence = { version: 2; id: string; pid: number; startedAt: string; rootBorn: number;
  guardian: Member; groupClosed: boolean; members: Member[] };
export const macGateGuardianPath = (logPath: string): string => `${logPath}.macos-guardian.pid`;
export async function macGateBootstrap(logPath: string) {
  return { macGuard: await gateMacScannerExecutable(), macGuardFile: macGateGuardianPath(logPath) };
}

export function macGateConfinement(logPath: string, pid: number, startedAt: string | null, existingId?: string): GateConfinement {
  const token = macGateToken(logPath);
  const id = `macos-observed:${token}`;
  const path = `${logPath}.macos-processes.json`;
  let executable = cachedGateMacScannerExecutable();
  let timer: NodeJS.Timeout | null = null;
  let registeredGuardian: Member | null = null;
  const scan = (): Scan => {
    if (!executable) throw new Error("macOS 进程监督器尚未就绪");
    return JSON.parse(execFileSync(executable, ["scan", `${MAC_GATE_ENV}=${token}`, String(pid)], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024,
    })) as Scan;
  };
  const validMember = (member: Member): boolean => !!member && Number.isSafeInteger(member.pid) && member.pid > 1
    && Number.isSafeInteger(member.born) && member.born > 0;
  const load = (): Evidence => {
    const evidence = JSON.parse(readFileSync(path, "utf8")) as Evidence;
    if (evidence.version !== 2 || evidence.id !== id || evidence.pid !== pid || evidence.startedAt !== startedAt
      || !Number.isSafeInteger(evidence.rootBorn) || evidence.rootBorn < 1 || !Array.isArray(evidence.members)
      || !validMember(evidence.guardian) || evidence.guardian.pid === pid || evidence.guardian.born < evidence.rootBorn
      || (registeredGuardian && (registeredGuardian.pid !== evidence.guardian.pid || registeredGuardian.born !== evidence.guardian.born))
      || typeof evidence.groupClosed !== "boolean"
      || evidence.members.some(member => !validMember(member))) throw new Error("macOS 监督身份记录不匹配");
    registeredGuardian = evidence.guardian;
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
      const { rows, groupMembers } = scan();
      const previous = new Map(evidence.members.map(member => [member.pid, member.born]));
      if (evidence.members.some(member => !rows.some(row => row.pid === member.pid) && isPidAlive(member.pid))) {
        throw new Error("已观察进程仍存活但原生身份读取失败，保留占用");
      }
      const guardian = rows.find(row => row.pid === evidence.guardian.pid && row.born === evidence.guardian.born);
      const root = rows.find(row => row.pid === pid && row.born === evidence.rootBorn && row.group === pid && row.session === pid);
      const groupRows = groupMembers.map(member => rows.find(row => row.pid === member));
      if (!evidence.groupClosed && groupMembers.length > 0
        && ((!root && (!guardian || guardian.zombie || guardian.group !== pid || guardian.session !== pid))
          || groupRows.some(row => !row || row.group !== pid || row.session !== pid || row.born < evidence.rootBorn))) {
        throw new Error("已登记进程组的代际或成员身份无法核验，保留占用");
      }
      const groupOwned = !evidence.groupClosed && groupMembers.length > 0;
      const selected = new Map<number, Row>();
      for (const row of rows) {
        if (row.pid === evidence.guardian.pid && row.born === evidence.guardian.born) continue;
        if (!row.zombie && (row.marked === 1 || previous.get(row.pid) === row.born
          || (groupOwned && groupMembers.includes(row.pid)))) selected.set(row.pid, row);
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          const parent = selected.get(row.ppid);
          if (row.pid === evidence.guardian.pid && row.born === evidence.guardian.born) continue;
          if (!row.zombie && !selected.has(row.pid) && parent && row.born >= parent.born) {
            selected.set(row.pid, row);
            changed = true;
          }
        }
      }
      evidence.members = [...selected.values()].map(({ pid, born }) => ({ pid, born }));
      if (!evidence.members.length) evidence.groupClosed = true;
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
      const deadline = Date.now() + 5_000;
      while (!existsSync(macGateGuardianPath(logPath)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      const guardianPid = Number(readFileSync(macGateGuardianPath(logPath), "utf8"));
      const { rows } = scan();
      const root = rows.find(row => row.pid === pid && row.marked === 1 && row.group === pid && row.session === pid);
      const guardian = rows.find(row => row.pid === guardianPid && row.ppid === pid && row.marked === 1
        && row.group === pid && row.session === pid && !row.zombie);
      if (!root || !guardian || guardian.born < root.born || inspectProcessSync(pid)?.startedAt !== startedAt) return false;
      save({ version: 2, id, pid, startedAt, rootBorn: root.born, guardian: { pid: guardian.pid, born: guardian.born },
        groupClosed: false, members: [{ pid, born: root.born }] });
      registeredGuardian = { pid: guardian.pid, born: guardian.born };
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
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      try {
        const guardian = registeredGuardian ?? load().guardian;
        if (executable) execFileSync(executable, ["signal", String(guardian.pid), String(guardian.born), "15"], { timeout: 3_000 });
      } catch {}
    },
    async prepare() { executable = await gateMacScannerExecutable(); },
  };
}

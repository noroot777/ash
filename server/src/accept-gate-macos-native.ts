import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileText } from "./exec.js";

let compiling: Promise<string> | null = null;

export function gateMacScannerExecutable(): Promise<string> {
  compiling ??= compileScanner().finally(() => { compiling = null; });
  return compiling;
}

export function cachedGateMacScannerExecutable(): string | null {
  const digest = createHash("sha256").update(MAC_SCANNER_SOURCE).digest("hex");
  const executable = join(tmpdir(), "ash-accept-gate", `macos-scanner-${process.arch}-${digest}`);
  return existsSync(executable) ? executable : null;
}

async function compileScanner(): Promise<string> {
  const directory = join(tmpdir(), "ash-accept-gate");
  mkdirSync(directory, { recursive: true });
  const digest = createHash("sha256").update(MAC_SCANNER_SOURCE).digest("hex");
  const executable = join(directory, `macos-scanner-${process.arch}-${digest}`);
  if (existsSync(executable)) return executable;
  const temporary = join(directory, `compile-${randomUUID()}`);
  try {
    writeFileSync(`${temporary}.c`, MAC_SCANNER_SOURCE, { flag: "wx" });
    await execFileText("/usr/bin/clang", ["-O2", "-Wall", "-Werror", `${temporary}.c`, "-o", temporary], { timeout: 30_000 });
    renameSync(temporary, executable);
    return executable;
  } finally {
    rmSync(`${temporary}.c`, { force: true });
    rmSync(temporary, { force: true });
  }
}

export const MAC_SCANNER_SOURCE = String.raw`
#include <libproc.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned long long birth(const struct proc_bsdinfo *info) {
  return info->pbi_start_tvsec * 1000000ULL + info->pbi_start_tvusec;
}

static int info_for(int pid, struct proc_bsdinfo *info) {
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == sizeof(*info);
}

static int marked(int pid, const char *token) {
  int mib[] = { CTL_KERN, KERN_ARGMAX };
  int capacity = 0;
  size_t size = sizeof(capacity);
  if (sysctl(mib, 2, &capacity, &size, NULL, 0) != 0 || capacity < 1) return -1;
  char *buffer = malloc(capacity);
  if (!buffer) return -1;
  int args_mib[] = { CTL_KERN, KERN_PROCARGS2, pid };
  size = capacity;
  if (sysctl(args_mib, 3, buffer, &size, NULL, 0) != 0 || size < sizeof(int)) {
    free(buffer);
    return -1;
  }
  int argc;
  memcpy(&argc, buffer, sizeof(argc));
  char *cursor = buffer + sizeof(argc), *end = buffer + size;
  char *terminator = memchr(cursor, 0, end - cursor);
  if (!terminator || argc < 0) { free(buffer); return -1; }
  cursor = terminator + 1;
  while (cursor < end && !*cursor) cursor++;
  for (int index = 0; index < argc; index++) {
    terminator = memchr(cursor, 0, end - cursor);
    if (!terminator) { free(buffer); return -1; }
    cursor = terminator + 1;
  }
  int result = 0;
  while (cursor < end && *cursor) {
    terminator = memchr(cursor, 0, end - cursor);
    if (!terminator) { result = -1; break; }
    if (strlen(token) == (size_t)(terminator - cursor) && !memcmp(cursor, token, strlen(token))) {
      result = 1;
      break;
    }
    cursor = terminator + 1;
  }
  free(buffer);
  return result;
}

int main(int argc, char **argv) {
  if (argc == 4 && !strcmp(argv[1], "guard")) {
    int parent = atoi(argv[2]);
    if (parent < 2) return 1;
    for (;;) {
      if (getppid() != parent && access(argv[3], F_OK) != 0) return 0;
      usleep(100000);
    }
  }
  if (argc == 5 && !strcmp(argv[1], "signal")) {
    int pid = atoi(argv[2]);
    struct proc_bsdinfo info;
    if (pid < 2 || !info_for(pid, &info) || birth(&info) != strtoull(argv[3], NULL, 10)) return 2;
    if (info.pbi_uid != getuid()) return 3;
    return kill(pid, atoi(argv[4])) == 0 || errno == ESRCH ? 0 : 4;
  }
  if ((argc != 3 && argc != 4) || strcmp(argv[1], "scan")) return 1;
  int count = proc_listallpids(NULL, 0);
  if (count < 1) return 2;
  int capacity = count + 1024;
  int *pids = calloc(capacity, sizeof(int));
  if (!pids) return 3;
  count = proc_listallpids(pids, capacity * sizeof(int));
  if (count < 1 || count >= capacity) { free(pids); return 4; }
  printf("{\"rows\":[");
  int comma = 0;
  for (int index = 0; index < count; index++) {
    struct proc_bsdinfo before, after;
    int pid = pids[index];
    if (pid < 2 || !info_for(pid, &before) || before.pbi_uid != getuid()) continue;
    int token = marked(pid, argv[2]);
    if (!info_for(pid, &after) || birth(&before) != birth(&after)) continue;
    printf("%s{\"pid\":%d,\"ppid\":%u,\"group\":%u,\"session\":%d,\"born\":%llu,\"marked\":%d,\"zombie\":%s}",
      comma++ ? "," : "", pid, after.pbi_ppid, after.pbi_pgid, getsid(pid), birth(&after), token, after.pbi_status == SZOMB ? "true" : "false");
  }
  free(pids);
  printf("],\"groupMembers\":[");
  if (argc == 4) {
    int group = atoi(argv[3]);
    if (group < 2) return 5;
    int bytes = proc_listpids(PROC_PGRP_ONLY, group, NULL, 0);
    if (bytes < 0) return 6;
    int size = bytes + 1024 * sizeof(int);
    pids = calloc(1, size);
    if (!pids) return 7;
    bytes = proc_listpids(PROC_PGRP_ONLY, group, pids, size);
    if (bytes < 0 || bytes >= size) { free(pids); return 8; }
    if (bytes == 0 && (kill(-group, 0) == 0 || errno != ESRCH)) { free(pids); return 9; }
    comma = 0;
    for (int index = 0; index < bytes / sizeof(int); index++) {
      if (pids[index] > 1) printf("%s%d", comma++ ? "," : "", pids[index]);
    }
    free(pids);
  }
  printf("]}\n");
  return 0;
}
`;

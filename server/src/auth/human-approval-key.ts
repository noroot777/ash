import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

type KeyFileEntry = { owner: number; file: boolean; directory: boolean; symlink: boolean };
export type HumanApprovalKeyFiles = {
  serviceOwner(): number | undefined;
  inspect(path: string): KeyFileEntry;
  writable(path: string): boolean;
  read(path: string): string;
};

const keyFiles: HumanApprovalKeyFiles = {
  serviceOwner: () => process.geteuid?.(),
  inspect: (path) => {
    const entry = lstatSync(path);
    return { owner: entry.uid, file: entry.isFile(), directory: entry.isDirectory(), symlink: entry.isSymbolicLink() };
  },
  writable: (path) => {
    try { accessSync(path, constants.W_OK); return true; }
    catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  },
  read: (path) => readFileSync(path, "utf8").trim(),
};

export function readTrustedHumanApprovalKeyFile(path: string, files = keyFiles): string {
  const serviceOwner = files.serviceOwner();
  if (serviceOwner === undefined || !isAbsolute(path)) throw new Error("公钥文件需要可核验的独立属主和绝对路径");
  for (let current = path; ; current = dirname(current)) {
    const entry = files.inspect(current);
    if (entry.symlink || (current === path ? !entry.file : !entry.directory)) throw new Error(`公钥路径不是普通文件或目录，或包含符号链接：${current}`);
    if (entry.owner === serviceOwner || files.writable(current)) throw new Error(`公钥文件或上级目录可被服务运行账号修改：${current}`);
    if (dirname(current) === current) break;
  }
  return files.read(path);
}

export function humanApprovalPublicKeyFile(): string | undefined {
  return process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY_FILE || undefined;
}

export function configuredHumanApprovalKey(): string | undefined {
  if (process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY) return process.env.ASH_HUMAN_APPROVAL_PUBLIC_KEY;
  const path = humanApprovalPublicKeyFile();
  return path ? readTrustedHumanApprovalKeyFile(path) : undefined;
}

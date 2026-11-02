export function filesystemFailure(error: unknown): error is NodeJS.ErrnoException {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as NodeJS.ErrnoException;
  return typeof failure.code === "string" && typeof failure.errno === "number" && typeof failure.syscall === "string";
}

export type ReadResult<Value> = { kind: "value"; value: Value }
  | { kind: "missing" | "unreadable"; error: NodeJS.ErrnoException };

export async function readResult<Value>(read: () => Promise<Value>): Promise<ReadResult<Value>> {
  try { return { kind: "value", value: await read() }; }
  catch (error) {
    if (filesystemFailure(error)) {
      if (error.code === "EMFILE" || error.code === "ENFILE") {
        throw new Error(`读取依赖解析输入时文件句柄耗尽（${error.code}），无法确认隔离；`
          + `请释放占用的文件句柄或提高系统限额后重试，门禁不会将这次失败当成入口不存在`, { cause: error });
      }
      return { kind: error.code === "ENOENT" || error.code === "ENOTDIR" ? "missing" : "unreadable", error };
    }
    throw error;
  }
}

export function inputFailure(path: string, error: NodeJS.ErrnoException): Error {
  return new Error(`无法读取隔离证明输入 ${path}（${error.syscall}: ${error.code}），不能据此认定路径不存在；`
    + `请检查该路径的访问权限、文件系统和当前占用，恢复可读取后重试`, { cause: error });
}

export async function requiredRead<Value>(path: string, read: () => Promise<Value>): Promise<Value> {
  const result = await readResult(read);
  if (result.kind === "value") return result.value;
  throw inputFailure(path, result.error);
}

export async function optionalRead<Value>(path: string, read: () => Promise<Value>,
  absentCodes = ["ENOENT", "ENOTDIR"]): Promise<Value | null> {
  const result = await readResult(read);
  if (result.kind === "value") return result.value;
  if (absentCodes.includes(result.error.code!)) return null;
  throw inputFailure(path, result.error);
}

export async function available<Value>(read: () => Promise<Value>): Promise<Value | null> {
  const result = await readResult(read);
  return result.kind === "value" ? result.value : null;
}

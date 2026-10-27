export function filesystemFailure(error: unknown): error is NodeJS.ErrnoException {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as NodeJS.ErrnoException;
  return typeof failure.code === "string" && typeof failure.errno === "number" && typeof failure.syscall === "string";
}

export async function available<Value>(read: () => Promise<Value>): Promise<Value | null> {
  try { return await read(); }
  catch (error) {
    if (filesystemFailure(error)) {
      if (error.code === "EMFILE" || error.code === "ENFILE") {
        throw new Error(`读取依赖解析输入时文件句柄耗尽（${error.code}），无法确认隔离；`
          + `请释放占用的文件句柄或提高系统限额后重试，门禁不会将这次失败当成入口不存在`, { cause: error });
      }
      return null;
    }
    throw error;
  }
}

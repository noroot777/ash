export function filesystemFailure(error: unknown): error is NodeJS.ErrnoException {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as NodeJS.ErrnoException;
  return typeof failure.code === "string" && typeof failure.errno === "number" && typeof failure.syscall === "string";
}

export async function available<Value>(read: () => Promise<Value>): Promise<Value | null> {
  try { return await read(); }
  catch (error) {
    if (filesystemFailure(error)) return null;
    throw error;
  }
}

import { AsyncLocalStorage } from "node:async_hooks";

type StartReceipt = { taskId: string; acknowledge(): void };
const starting = new AsyncLocalStorage<StartReceipt>();
const receipts = new WeakMap<object, StartReceipt>();

export function acknowledgeTaskStart(taskId: string): void {
  const receipt = starting.getStore();
  if (receipt?.taskId === taskId) receipt.acknowledge();
}

export function registerStartReceipt(taskId: string, handle: object): void {
  const receipt = starting.getStore();
  if (receipt?.taskId === taskId) receipts.set(handle, receipt);
}

export function acknowledgeStartReceipt(handle: object): void {
  receipts.get(handle)?.acknowledge();
  receipts.delete(handle);
}

export function waitForStartReceipt(taskId: string, start: () => Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    void starting.run({ taskId, acknowledge: () => resolve(true) }, async () => {
      try { await start(); }
      finally { resolve(false); }
    }).catch(() => resolve(false));
  });
}

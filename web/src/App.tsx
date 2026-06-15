import { useEffect, useState } from "react";

type Health = { ok: boolean; ts: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-2xl font-medium tracking-tight">Harness</h1>
        <p className="mt-1 text-sm text-neutral-500">
          编排本地 / 远程编程智能体的控制台 · M0 骨架
        </p>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              health?.ok ? "bg-emerald-400" : err ? "bg-red-400" : "bg-neutral-600"
            }`}
          />
          <span className="text-neutral-300">
            {health?.ok
              ? "后端已连接"
              : err
                ? "后端未连接"
                : "正在检查后端…"}
          </span>
        </div>
        {health && (
          <p className="mt-2 font-mono text-xs text-neutral-500">
            /api/health · {health.ts}
          </p>
        )}
        {err && <p className="mt-2 font-mono text-xs text-red-400">{err}</p>}
      </div>
    </div>
  );
}

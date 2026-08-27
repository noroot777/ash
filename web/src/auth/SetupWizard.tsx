// 首启向导(§二)。它只管一次性的分叉:这台 ash 是给一个人用,还是给几个人用。
//
// 「切到多人」的表单本体在 `MultiModeForm.tsx` —— 设置页危险区走的是同一份,
// 那三条警告(转不回、根目录锁死、宿主订阅被抹去)只能有一份拷贝。
import { useCallback, useState } from "react";
import { ApiError } from "../lib/apiClient.ts";
import { authApi } from "../lib/authApi.ts";
import { KeyReveal } from "./KeyReveal.tsx";
import { MultiModeForm } from "./MultiModeForm.tsx";

type Step = "choose" | "multi-form" | "key";

export function SetupWizard({ onDone }: { onDone: () => Promise<void> | void }) {
  const [step, setStep] = useState<Step>("choose");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedKey, setIssuedKey] = useState("");

  const chooseSingle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await authApi.chooseSingle();
      await onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "设置失败");
      setBusy(false);
    }
  }, [onDone]);

  if (step === "key") {
    return (
      <div className="auth-shell">
        <div className="auth-card auth-card--wide">
          <KeyReveal
            value={issuedKey}
            title="这是你的管理员 key"
            confirmLabel="进入实例"
            onConfirm={() => void onDone()}
          />
        </div>
      </div>
    );
  }

  if (step === "multi-form") {
    return (
      <div className="auth-shell">
        <div className="auth-card auth-card--wide">
          <h1>切到多人模式</h1>
          <MultiModeForm
            onCancel={() => setStep("choose")}
            onIssued={(key) => {
              setIssuedKey(key);
              setStep("key");
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card auth-card--wide">
        <h1>这台 ash 给谁用？</h1>
        <p className="auth-note">选完就能开始。之后从自用切到多人还来得及，反过来不行。</p>

        <button type="button" className="auth-choice" onClick={() => void chooseSingle()} disabled={busy}>
          <b>只有我自己</b>
          <span>
            零鉴权，打开就用。CLI 继续用这台机器上的登录态（<code>~/.claude</code> 等），
            订阅照用。这是原来的行为，一点不变。
          </span>
        </button>

        <button type="button" className="auth-choice" onClick={() => setStep("multi-form")} disabled={busy}>
          <b>几个人一起用</b>
          <span>
            每人一把 key、一个自己的目录、一套自己的执行器与供应商。
            权限是<b>防误操作的护栏，不是 OS 级隔离</b>：所有 agent 都以同一个系统账号运行。
            传输安全靠 Tailscale / 反向代理的 TLS，ash 自己不做 HTTPS。
          </span>
        </button>

        {error ? <p className="auth-error">{error}</p> : null}
      </div>
    </div>
  );
}

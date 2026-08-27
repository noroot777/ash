// 「配置搬家」设置节(§十)。换一台机器、或者把自己那套给同事复制一份时用。
//
// 两条硬约束在界面上必须讲明白,否则会有人把这份文件当备份用:
//  ① **永远不含 API key** —— 这份文件会在聊天工具里传,带 key 就是现成的泄露渠道。
//  ② 导入是**并入**不是覆盖:同名的一律跳过并如实列出,不静默改掉对方已有的配置。
import { useCallback, useRef, useState } from "react";
import type { ConfigBundle, ConfigBundleKind } from "@ash/shared";
import { CONFIG_BUNDLE_KINDS, CONFIG_BUNDLE_LABELS } from "@ash/shared/multiuser";
import { ApiError } from "../lib/apiClient.ts";
import { configTransferApi } from "../lib/authApi.ts";
import { Button } from "../components/ui.tsx";
import "./config-transfer-settings.css";

type ImportResult = { imported: Record<string, number>; skipped: string[]; notes: string[] };

function countOf(bundle: ConfigBundle, kind: ConfigBundleKind): number {
  return bundle.items[kind]?.length ?? 0;
}

export function ConfigTransferSettings({ notify }: { notify: (message: string) => void }) {
  const [selected, setSelected] = useState<ConfigBundleKind[]>([...CONFIG_BUNDLE_KINDS]);
  const [busy, setBusy] = useState(false);
  const [staged, setStaged] = useState<{ bundle: ConfigBundle; fileName: string } | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggle = (kind: ConfigBundleKind) =>
    setSelected((prev) => (prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]));

  const doExport = useCallback(async () => {
    setBusy(true);
    try {
      const bundle = await configTransferApi.exportBundle(selected);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ash-config-${bundle.exportedAt.slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify("已导出");
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "导出失败");
    } finally {
      setBusy(false);
    }
  }, [selected, notify]);

  const stage = useCallback(
    async (file: File) => {
      setResult(null);
      try {
        const parsed = JSON.parse(await file.text()) as ConfigBundle;
        if (parsed?.version !== 1 || !parsed.items) throw new Error("bad");
        setStaged({ bundle: parsed, fileName: file.name });
      } catch {
        notify("这不是一份 ash 配置文件");
      }
    },
    [notify],
  );

  const doImport = useCallback(async () => {
    if (!staged) return;
    setBusy(true);
    try {
      setResult(await configTransferApi.importBundle(staged.bundle));
      setStaged(null);
    } catch (e) {
      notify(e instanceof ApiError ? e.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }, [staged, notify]);

  return (
    <section className="settings-section cfgx">
      <header>
        <h2>配置搬家</h2>
        <p className="settings-hint">
          把你自己那套执行器、模式预设、起手式、审查者和个人 CLI 环境打包成一个文件，
          换机器或者给同事复制时导入。
        </p>
      </header>

      <div className="cfgx-warning">
        导出文件<b>不含任何 API key</b> —— 这种文件多半会走聊天工具传，带 key 等于把凭据递出去。
        供应商只带地址和协议，导入方自己补 key。
      </div>

      <div className="cfgx-block">
        <h3>导出</h3>
        <div className="cfgx-kinds">
          {CONFIG_BUNDLE_KINDS.map((kind) => (
            <label key={kind} className="cfgx-kind">
              <input type="checkbox" checked={selected.includes(kind)} onChange={() => toggle(kind)} />
              <span>{CONFIG_BUNDLE_LABELS[kind]}</span>
            </label>
          ))}
        </div>
        <div className="cfgx-actions">
          <Button variant="primary" disabled={busy || !selected.length} onClick={() => void doExport()}>
            导出为文件
          </Button>
        </div>
      </div>

      <div className="cfgx-block">
        <h3>导入</h3>
        <p className="settings-hint">
          导入是<b>并入</b>：同名的执行器 / 预设 / 起手式一律跳过，不会改掉你已有的。
          执行器按<b>名字</b>找供应商 —— 对面没有同名供应商时，那个执行器会先落成「没挂供应商」，你补上就能跑。
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="cfgx-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void stage(file);
          }}
        />
        <div className="cfgx-actions">
          <Button onClick={() => fileRef.current?.click()}>选择配置文件…</Button>
        </div>

        {staged ? (
          <div className="cfgx-staged">
            <p>
              <code>{staged.fileName}</code>
              {staged.bundle.exportedAt ? `（导出于 ${new Date(staged.bundle.exportedAt).toLocaleString()}）` : null}
            </p>
            <ul>
              {staged.bundle.kinds.map((kind) => (
                <li key={kind}>
                  {CONFIG_BUNDLE_LABELS[kind] ?? kind}：{countOf(staged.bundle, kind)} 条
                </li>
              ))}
            </ul>
            <div className="cfgx-actions">
              <Button variant="ghost" onClick={() => setStaged(null)}>取消</Button>
              <Button variant="primary" disabled={busy} onClick={() => void doImport()}>
                {busy ? "正在导入…" : "导入"}
              </Button>
            </div>
          </div>
        ) : null}

        {result ? (
          <div className="cfgx-result">
            <p>
              <b>导入完成。</b>
              {Object.entries(result.imported)
                .filter(([, n]) => n > 0)
                .map(([kind, n]) => `${CONFIG_BUNDLE_LABELS[kind as ConfigBundleKind] ?? kind} ${n} 条`)
                .join("、") || "没有新增内容"}
            </p>
            {result.skipped.length ? (
              <p className="cfgx-muted">同名跳过：{result.skipped.join("、")}</p>
            ) : null}
            {result.notes.map((note) => (
              <p key={note} className="cfgx-muted">{note}</p>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

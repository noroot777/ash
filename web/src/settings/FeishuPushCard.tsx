import { useId, useState } from "react";
import type { FeishuStatus, ImOptions, ProjectView } from "@ash/shared";
import { Button, Checkbox, Toggle } from "../components/ui.tsx";
import { api } from "../lib/api.ts";
import { HANDOFF_URL_RE, normalizeTargetUrl } from "./handoffTargetUi.ts";
import { useServerDraft } from "./useServerDraft.ts";

// 推送卡：实例级的推送选项。canManage 为假时照样显示（看得到「推送开没开」本身就是信息），
// 只是全部收成只读。
//
// 两个开关点了就存；地址和额度是要打完再存的文本，各配一颗保存按钮，免得每敲一个字发一次请求。

const DEFAULT_QUOTA = 10_000;

export function FeishuPushCard({ status, projects, onStatus, notify }: {
  status: FeishuStatus;
  /** null = 项目清单还没读到（不是没有项目）。 */
  projects: ProjectView[] | null;
  onStatus: (next: FeishuStatus) => void;
  notify: (message: string) => void;
}) {
  const { options, canManage } = status;
  const [busy, setBusy] = useState(false);
  const [baseUrl, setBaseUrl, baseUrlDirty] = useServerDraft(options.publicBaseUrl ?? "");
  const [quota, setQuota, quotaDirty] = useServerDraft(String(options.monthlyQuota));
  const locked = busy || !canManage;
  const urlId = useId();
  const quotaId = useId();

  const patch = async (change: Partial<ImOptions>, done: string) => {
    setBusy(true);
    try {
      onStatus(await api.patchFeishuOptions(change));
      notify(done);
    } catch (error) {
      notify(error instanceof Error ? error.message : "推送设置保存失败");
    } finally {
      setBusy(false);
    }
  };

  const normalizedUrl = normalizeTargetUrl(baseUrl);
  const urlInvalid = normalizedUrl !== "" && !HANDOFF_URL_RE.test(normalizedUrl);
  const quotaNumber = Number(quota.trim());
  const quotaInvalid = !Number.isInteger(quotaNumber) || quotaNumber < 1;
  // 已经不在列表里的项目（删掉了 / 看不见）照样留在勾选清单里：清掉它不是这张卡该替用户做的决定。
  const titleOnly = new Set(options.titleOnlyProjectIds);
  const toggleTitleOnly = (projectId: string, checked: boolean) => {
    const next = new Set(titleOnly);
    if (checked) next.add(projectId);
    else next.delete(projectId);
    void patch({ titleOnlyProjectIds: [...next] }, checked ? "这个项目的卡片改为只推标题和链接" : "这个项目的卡片恢复推送完整内容");
  };

  return (
    <section className="settings-section" data-settings-anchor="feishu-push">
      <h2>推送</h2>
      {!canManage && <p className="settings-note">推送选项是整台实例共用的，只有实例管理员能改；这里按只读展示。</p>}
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <b>飞书通道</b>
            <small>关掉就断开长连接、机器人下线：什么都不推，飞书里发消息也没人接。凭证不会被清掉。</small>
          </div>
          <Toggle
            label={options.enabled ? "已开启" : "已关闭"}
            checked={options.enabled}
            disabled={locked}
            onChange={(checked) => void patch({ enabled: checked }, checked ? "飞书通道已开启" : "飞书通道已关闭，机器人下线")}
          />
        </div>
        <div className="settings-row">
          <div>
            <b>完成也推</b>
            <small>任务完成、验收合并、门禁出结果时各推一条通知。要你拍板的卡（提问、待验收、失败）不受这个开关影响，总会推。</small>
          </div>
          <Toggle
            label={options.notifyCompleted ? "已开启" : "已关闭"}
            checked={options.notifyCompleted}
            disabled={locked}
            onChange={(checked) => void patch({ notifyCompleted: checked }, checked ? "完成通知已开启" : "完成通知已关闭")}
          />
        </div>
        <div className="settings-field feishu-inline-field">
          <label htmlFor={urlId}>卡片深链地址</label>
          <span className="feishu-field-body">
            <input
              id={urlId}
              className="mono"
              value={baseUrl}
              readOnly={!canManage}
              disabled={busy}
              placeholder="http://my-mac.tailnet.ts.net:4317"
              aria-invalid={urlInvalid}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <small className={urlInvalid ? "feishu-field-error" : undefined}>
              {urlInvalid
                ? "要以 http:// 或 https:// 开头，中间不能有空格"
                : "卡片上「在 ash 中打开」的地址前缀，为空则卡片不带链接。飞书内置浏览器解析不了 Tailscale 的机器名，http 地址会自动换成它的 100.x IP；https 换不了，请填 http。"}
            </small>
          </span>
          {canManage && (
            <Button
              variant="secondary"
              disabled={busy || !baseUrlDirty || urlInvalid}
              onClick={() => void patch({ publicBaseUrl: normalizedUrl || null }, normalizedUrl ? "卡片深链地址已保存" : "已清空卡片深链地址，卡片不再带链接")}
            >
              保存
            </Button>
          )}
        </div>
        <div className="settings-field feishu-inline-field">
          <label htmlFor={quotaId}>月调用额度</label>
          <span className="feishu-field-body">
            <input
              id={quotaId}
              className="mono feishu-quota-input"
              inputMode="numeric"
              value={quota}
              readOnly={!canManage}
              disabled={busy}
              aria-invalid={quotaInvalid}
              onChange={(event) => setQuota(event.target.value)}
            />
            <small className={quotaInvalid ? "feishu-field-error" : undefined}>
              {quotaInvalid
                ? "填一个正整数"
                : `飞书开放平台给这个应用的月调用次数上限，从开发者后台的用量页抄过来（默认 ${DEFAULT_QUOTA.toLocaleString("zh-CN")}）。ash 按它算水位，接近上限时先少推不要紧的。`}
            </small>
          </span>
          {canManage && (
            <Button
              variant="secondary"
              disabled={busy || !quotaDirty || quotaInvalid}
              onClick={() => void patch({ monthlyQuota: quotaNumber }, "月调用额度已保存")}
            >
              保存
            </Button>
          )}
        </div>
        <div className="settings-row feishu-title-only">
          <div>
            <b>只推标题和链接的项目</b>
            <small>
              勾上的项目，卡片里只有任务标题和链接，不带提问正文、失败原因这些可能含代码或命令输出的内容。
              {!options.publicBaseUrl && "现在没填深链地址，这些卡片就只剩标题了。"}
            </small>
          </div>
          {projects === null ? (
            <span>项目清单这一下没读到，稍后自动重试</span>
          ) : projects.length ? (
            <div className="feishu-project-checks" role="group" aria-label="只推标题和链接的项目">
              {projects.map((project) => (
                <Checkbox
                  key={project.id}
                  label={project.name}
                  checked={titleOnly.has(project.id)}
                  disabled={locked}
                  onChange={(checked) => toggleTitleOnly(project.id, checked)}
                />
              ))}
            </div>
          ) : (
            <span>还没有项目</span>
          )}
        </div>
      </div>
    </section>
  );
}

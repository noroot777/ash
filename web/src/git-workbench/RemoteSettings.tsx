import type { AskAction } from "./ActionDialog.tsx";
import type { Workbench } from "./useWorkbench.ts";

export function RemoteSettings({
  workbench: w,
  ask,
}: {
  workbench: Workbench;
  ask: AskAction;
}) {
  const details = w.data!.remoteDetails;
  return (
    <section className="gwb-ref-section">
      <h3>
        远端配置
        <div className="gwb-inline-actions" style={{ marginLeft: "auto" }}>
          <button
            disabled={w.blocked}
            onClick={() =>
              ask({
                title: "添加远端",
                message:
                  "登记一个远端仓库地址。添加后点击获取，读取它的分支和标签。HTTPS 令牌与 SSH 密钥在项目 Git 设置中配置。",
                fields: [
                  {
                    key: "name",
                    label: "远端名称",
                    initial: "origin",
                    required: true,
                  },
                  {
                    key: "url",
                    label: "仓库地址",
                    placeholder: "git@github.com:owner/repo.git",
                    required: true,
                  },
                ],
                action: (v) => ({
                  kind: "remote-add",
                  name: v.name,
                  url: v.url,
                }),
              })
            }
          >
            添加远端
          </button>
        </div>
      </h3>
      {details.map((remote) => (
        <div className="gwb-ref-row" key={remote.name}>
          <div className="gwb-ref-info">
            <strong>{remote.name}</strong>
            {remote.urls.map((url) => (
              <small key={url}>获取 / 默认推送：{url}</small>
            ))}
            {remote.pushUrls.map((url) => (
              <small key={url}>专用推送：{url}</small>
            ))}
          </div>
          <div className="gwb-row-actions">
            <button
              disabled={w.blocked}
              onClick={() => void w.run({ kind: "fetch", remote: remote.name })}
            >
              获取
            </button>
            <button
              disabled={w.blocked}
              onClick={() =>
                ask({
                  title: "修改远端地址",
                  message: `修改 ${remote.name} 的主要获取地址。已单独配置的推送地址会继续使用。`,
                  fields: [
                    {
                      key: "url",
                      label: "新地址",
                      initial: remote.urls[0]?.includes("***")
                        ? ""
                        : remote.urls[0],
                      required: true,
                    },
                  ],
                  action: (v) => ({
                    kind: "remote-url",
                    name: remote.name,
                    url: v.url,
                    version: remote.version,
                  }),
                })
              }
            >
              修改地址
            </button>
            <button
              className="gwb-danger"
              disabled={w.blocked}
              onClick={() =>
                ask({
                  title: "移除远端配置",
                  message: `移除 ${remote.name} 的本地配置和跟踪引用。不会删除服务器上的仓库或分支；使用该远端的上游配置也会失效。`,
                  danger: true,
                  typed: remote.name,
                  action: () => ({
                    kind: "remote-remove",
                    name: remote.name,
                    version: remote.version,
                  }),
                })
              }
            >
              移除
            </button>
          </div>
        </div>
      ))}
      {!details.length && (
        <p className="gwb-muted-empty">
          尚未配置远端，添加后即可获取和发布分支。
        </p>
      )}
    </section>
  );
}

import { useState } from "react";
import { CopyButton } from "../components/CopyButton.tsx";

// 「怎么开通」和「接进来之后意味着什么」。两段都是给第一次配的人看的，连上之后默认收起。
//
// 顺序本身是约束不是建议：飞书后台保存「使用长连接接收」那一下会当场检查有没有客户端连着，
// 所以必须先在 ash 里存好凭证、等状态变成「已连接」，再回后台订阅事件、发版（方案 §七）。
//
// 边界那一段照方案 §6.1 / §6.5 如实写：能给机器人下指令就等于拿到这台机器的 shell，凭证文件
// 本机 agent 读得到。这些不写出来，用户就会按「一个普通的通知机器人」去评估风险。

const PERMISSIONS: readonly { scope: string; why: string; optional?: string }[] = [
  { scope: "im:message.p2p_msg:readonly", why: "收你发给机器人的单聊消息" },
  { scope: "im:message:send_as_bot", why: "以机器人身份发消息、发卡片、改卡片" },
  { scope: "im:message.group_at_msg:readonly", why: "收群里 @ 机器人的消息", optional: "要用群功能才开" },
  { scope: "im:resource", why: "收你发来的图片和文件", optional: "可选" },
];

function Scope({ value }: { value: string }) {
  return (
    <span className="feishu-scope">
      <code>{value}</code>
      <CopyButton value={value} icon className="feishu-copy-icon" ariaLabel={`复制 ${value}`} />
    </span>
  );
}

export function FeishuSetupGuide({ connected }: { connected: boolean }) {
  // 只在第一次渲染时按连接状态定开合；之后由用户自己点，不跟着轮询来回弹。
  const [open, setOpen] = useState(!connected);
  return (
    <details className="feishu-guide" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>开通顺序与安全边界</summary>
      <ol className="feishu-steps">
        <li>
          <b>建应用。</b>在飞书开放平台（Lark 国际版同理）建一个「企业自建应用」，在「添加应用能力」里开启<b>机器人</b>。
          个人自用建议建在自己当管理员的团队或测试企业下。
        </li>
        <li>
          <b>只开这几项权限：</b>
          <ul className="feishu-scopes">
            {PERMISSIONS.map((item) => (
              <li key={item.scope}>
                <Scope value={item.scope} />
                <span>{item.why}{item.optional && <em>（{item.optional}）</em>}</span>
              </li>
            ))}
          </ul>
          <span className="feishu-warn">
            不要开 <code>im:message.group_msg</code>（会读到群里的全部对话），也不要开通讯录。权限压到最小，
            密钥万一泄露，影响也只到「冒充机器人收发消息」为止。
          </span>
        </li>
        <li>
          <b>在这里填凭证。</b>把应用的 App ID、App Secret 填进下面的「凭证」卡保存，等上面的状态变成「已连接」。
        </li>
        <li>
          <b>订阅事件。</b>回开发者后台「事件与回调」，订阅方式选「使用长连接接收」，
          事件订阅加 <Scope value="im.message.receive_v1" />，回调订阅加 <Scope value="card.action.trigger" />。
          这一步要求 ash 已经连着，所以必须排在第 3 步之后。
        </li>
        <li>
          <b>发布版本。</b>权限和订阅每改一次都要发一次版才生效；部分权限要企业管理员审核。
        </li>
      </ol>
      <div className="feishu-bounds">
        <b>接进来之前要知道的</b>
        <ul>
          <li>能给机器人下指令就能让这台机器上的 agent 干活，而 agent 手里有 shell——<b>飞书账号从此等于这台机器的 shell 凭据</b>。公司租户的企业管理员和应用协作者能改应用配置、轮换密钥。</li>
          <li>凭证存在库文件旁边的 <code>&lt;库文件&gt;.feishu.json</code>（权限 0600），不进设置、不进环境变量。但本机 agent 和 ash 服务是同一个系统用户，<b>它们读得到这个文件</b>，可以冒充机器人发消息。</li>
          <li>Windows 上 0600 这个权限位不生效，文件能被谁读取取决于它所在目录的权限设置。</li>
          <li>一个飞书应用只能连一个 ash 实例：飞书会把事件随机分给连着的客户端之一，两台机器连同一个应用就会各丢一半消息。每台机器各建一个应用；上面的「本机实例指纹」可以用来核对连着的是哪一台。</li>
        </ul>
      </div>
    </details>
  );
}

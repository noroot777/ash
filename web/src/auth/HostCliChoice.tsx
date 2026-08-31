// 「CLI 额度」的二选一(docs/multi-user-plan.md §八之二)。
//
// 三个地方要它,所以只能有一份:首启向导的多人表单、设置页危险区的同一张表单、
// 以及多人模式定下来之后的「实例模式」卡片(那里是改档入口)。文案本体在
// `@ash/shared/multiuser`,两端共用 —— 前端另抄一份的话,服务端拒绝理由里说的
// 「让管理员去改成共用」和这里的选项名迟早对不上。
import { HOST_CLI_ISOLATED_DESC, HOST_CLI_ISOLATED_TITLE, HOST_CLI_SHARED_DESC, HOST_CLI_SHARED_TITLE } from "@ash/shared/multiuser";

export function HostCliChoice({
  value,
  onChange,
  disabled,
  /** 改档(而不是首次选)时多说一句代价 —— 见 InstanceModeCard。 */
  switching,
}: {
  value: boolean;
  onChange: (sharedHostCli: boolean) => void;
  disabled?: boolean;
  switching?: boolean;
}) {
  return (
    <div className="host-cli-choice">
      <HostCliOption
        checked={!value}
        disabled={disabled}
        onSelect={() => onChange(false)}
        title={HOST_CLI_ISOLATED_TITLE}
        desc={HOST_CLI_ISOLATED_DESC}
      />
      <HostCliOption
        checked={value}
        disabled={disabled}
        onSelect={() => onChange(true)}
        title={HOST_CLI_SHARED_TITLE}
        desc={HOST_CLI_SHARED_DESC}
      />
      {switching ? (
        <p className="auth-note">
          换档之后<b>正在进行中的 CLI 会话接不回来</b>：会话文件躺在旧的配置目录里，
          CLI 站在新目录里看不见它。系统会自动另开一条会话并在时间线里说明，任务本身不受影响，
          丢的是那段对话上下文。
        </p>
      ) : null}
    </div>
  );
}

function HostCliOption({
  checked,
  disabled,
  onSelect,
  title,
  desc,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  desc: string;
}) {
  return (
    <label className="host-cli-option" data-checked={checked ? "yes" : "no"}>
      <input
        type="radio"
        name="host-cli-quota"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span>
        <b>{title}</b>
        <small>{desc}</small>
      </span>
    </label>
  );
}

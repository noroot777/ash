import { useState, type ReactNode } from "react";
import { ArrowLeft, DotsThree, QuestionMark } from "@phosphor-icons/react";
import {
  Button,
  Checkbox,
  Menu,
  MenuItem,
  MenuSeparator,
  PillTabs,
  SelectableRow,
  SelectTrigger,
  StatusChip,
  TextInput,
  Toggle,
} from "../components/ui.tsx";

const tabItems = [
  { value: "workers", label: "执行者" },
  { value: "details", label: "详情" },
  { value: "activity", label: "活动" },
] as const;

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="dev-section">
      <div className="dev-section-heading">
        <div>
          <h2>{title}</h2>
          <p>{note}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function StateGrid({ children }: { children: ReactNode }) {
  return <div className="dev-state-grid">{children}</div>;
}

function StateHeader() {
  return (
    <>
      <div className="dev-state-head">类型</div>
      <div className="dev-state-head">静态</div>
      <div className="dev-state-head">悬停</div>
      <div className="dev-state-head">按下</div>
      <div className="dev-state-head">聚焦</div>
      <div className="dev-state-head">禁用</div>
    </>
  );
}

function ButtonStateRow({
  name,
  variant,
  label,
}: {
  name: string;
  variant: "primary" | "secondary" | "ghost" | "danger" | "icon";
  label: string;
}) {
  const content = variant === "icon" ? <DotsThree weight="bold" /> : label;
  const aria = variant === "icon" ? { "aria-label": label } : {};
  return (
    <>
      <div className="dev-state-name">{name}</div>
      <div className="dev-state-cell"><Button variant={variant} {...aria}>{content}</Button></div>
      <div className="dev-state-cell"><Button variant={variant} className="is-hover" {...aria}>{content}</Button></div>
      <div className="dev-state-cell"><Button variant={variant} className="is-active" {...aria}>{content}</Button></div>
      <div className="dev-state-cell"><Button variant={variant} className="is-focus" {...aria}>{content}</Button></div>
      <div className="dev-state-cell"><Button variant={variant} disabled {...aria}>{content}</Button></div>
    </>
  );
}

const scrollRows = [
  "协作任务",
  "自动验证相关",
  "审查者机制",
  "SSE 断线重连",
  "清理 worktree",
  "已完成任务",
  "其他项目",
  "移动端修复",
];

export function ComponentsPage() {
  const [tab, setTab] = useState<(typeof tabItems)[number]["value"]>("workers");
  const [checked, setChecked] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [menuOpen, setMenuOpen] = useState(true);

  return (
    <main className="dev-components-page">
      <header className="dev-header">
        <a className="ui-button ui-button--ghost" href="/">
          <ArrowLeft aria-hidden="true" /> 返回
        </a>
        <span>Harness Next · 开发基座</span>
        <code>/dev/components</code>
      </header>

      <div className="dev-content">
        <div className="dev-intro">
          <p className="dev-eyebrow">Linear 控件回归样板</p>
          <h1>基础控件全状态</h1>
          <p>
            固定展示静态、悬停、按下、聚焦与禁用态。全页共享 LCH 色彩变量、150ms 过渡和 S2 选中规则。
          </p>
        </div>

        <div className="dev-measures">
          <div><b>按钮</b><small>28px · 8px 圆角 · 500</small></div>
          <div><b>输入 / 选择器</b><small>32 / 30px · 单层焦点环</small></div>
          <div><b>菜单</b><small>12px 圆角 · 32px 行</small></div>
          <div><b>选中态</b><small>S2 淡染 · 无左侧指示条</small></div>
        </div>

        <Section title="按钮类型 × 全状态" note="主、次、幽灵、危险与图标按钮共用同一套短促交互节奏。">
          <StateGrid>
            <StateHeader />
            <ButtonStateRow name="主按钮" variant="primary" label="创建并运行" />
            <ButtonStateRow name="次级按钮" variant="secondary" label="编辑" />
            <ButtonStateRow name="幽灵按钮" variant="ghost" label="自定义" />
            <ButtonStateRow name="危险按钮" variant="danger" label="删除任务" />
            <ButtonStateRow name="图标按钮" variant="icon" label="更多操作" />
          </StateGrid>
        </Section>

        <Section title="输入框、选择器与下拉菜单" note="焦点环与边框重合成单层细线；菜单使用三层短阴影。">
          <div className="dev-input-grid">
            <label><span>静态</span><TextInput defaultValue="范小舟" aria-label="静态输入框" /></label>
            <label><span>悬停</span><TextInput className="is-hover" defaultValue="范小舟" aria-label="悬停输入框" /></label>
            <label><span>聚焦</span><TextInput className="is-focus" defaultValue="范小舟" aria-label="聚焦输入框" /></label>
            <label><span>禁用</span><TextInput defaultValue="范小舟" aria-label="禁用输入框" disabled /></label>
          </div>
          <div className="dev-menu-row">
            <div className="dev-select-stack">
              <SelectTrigger open={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
                智能体（默认）
              </SelectTrigger>
              <SelectTrigger className="is-hover">codex@cpa</SelectTrigger>
              <SelectTrigger disabled>不可选择</SelectTrigger>
            </div>
            {menuOpen ? (
              <Menu>
                <MenuItem selected shortcut="↵">智能体（默认）</MenuItem>
                <MenuItem shortcut="G I">收件箱</MenuItem>
                <MenuItem shortcut="G M">我的任务</MenuItem>
                <MenuSeparator />
                <MenuItem shortcut="C">当前周期</MenuItem>
                <MenuItem danger>移除默认视图</MenuItem>
              </Menu>
            ) : (
              <div className="dev-menu-placeholder">再次点击选择器可展开菜单</div>
            )}
          </div>
        </Section>

        <Section title="胶囊 tabs 与 S2 选中态" note="所有列表、菜单和设置导航都用淡染背景表达选中，不画左侧条。">
          <div className="dev-selection-grid">
            <div>
              <PillTabs items={tabItems} value={tab} onChange={setTab} label="详情分区" />
              <p className="dev-current-tab">当前：{tabItems.find((item) => item.value === tab)?.label}</p>
            </div>
            <div className="dev-selectable-list">
              <SelectableRow><StatusChip tone="green">运行中</StatusChip><span>自动验证相关</span><small>12m</small></SelectableRow>
              <SelectableRow selected><StatusChip tone="accent">已选择</StatusChip><span>新版前端地基</span><small>现在</small></SelectableRow>
              <SelectableRow><StatusChip tone="neutral">已完成</StatusChip><span>回复框拖拽修复</span><small>昨天</small></SelectableRow>
            </div>
          </div>
        </Section>

        <Section title="复选框、开关、状态与提示" note="状态色只落在微点和小控件，不给整行铺色。">
          <div className="dev-choice-grid">
            <Checkbox checked={checked} onChange={setChecked} label={checked ? "已选择" : "未选择"} />
            <Checkbox checked onChange={() => undefined} label="禁用选择" disabled />
            <Toggle checked={enabled} onChange={setEnabled} label={enabled ? "自动验证已开启" : "自动验证已关闭"} />
            <Toggle checked onChange={() => undefined} label="禁用开关" disabled />
          </div>
          <div className="dev-status-row">
            <StatusChip tone="green">运行中</StatusChip>
            <StatusChip tone="amber">排队中</StatusChip>
            <StatusChip tone="red">验证失败</StatusChip>
            <StatusChip tone="cyan">等待答复</StatusChip>
            <StatusChip tone="accent">辩论中</StatusChip>
            <div className="dev-tooltip-sample">
              <span className="dev-tip-target"><QuestionMark weight="bold" /></span>
              <span className="dev-tooltip" role="tooltip">打开帮助菜单</span>
            </div>
          </div>
        </Section>

        <Section title="覆盖式细滚动条" note="静止时隐去；移入任一滚动区后，半透明滑块出现并略微加宽。">
          <div className="dev-scroll-grid">
            {["侧栏任务树", "正文活动流", "详情栏", "下拉菜单"].map((name, index) => (
              <div className={`dev-scroll-sample dev-scroll-sample--${index + 1}`} key={name}>
                <h3>{name}</h3>
                {scrollRows.map((row) => <div className="dev-scroll-row" key={row}>{row}</div>)}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </main>
  );
}

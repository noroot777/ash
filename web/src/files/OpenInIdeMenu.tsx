import { useRef, useState } from "react";
import { ArrowsClockwise, CaretDown, Code } from "@phosphor-icons/react";
import { Menu, MenuItem, MenuSeparator } from "../components/ui.tsx";
import { api, type IdeApp, type IdeProbe } from "../lib/api.ts";
import { useDismissable } from "../lib/useDismissable.ts";
import { rememberIde, useLastIde } from "./idePreference.ts";

/** 一次探测的上限。服务端那头全是 stat，正常是十几毫秒；到这个数还没回就是卡住了。 */
const PROBE_TIMEOUT_MS = 15_000;

type ProbeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; probe: IdeProbe }
  | { status: "error"; message: string };

/** 上次选过的那个排最前——一个人常用的 IDE 基本不换，别让他每次都在十几行里找。 */
function ordered(ides: readonly IdeApp[], last: string | null): IdeApp[] {
  if (!last) return [...ides];
  const index = ides.findIndex((ide) => ide.id === last);
  if (index < 0) return [...ides];
  return [ides[index]!, ...ides.slice(0, index), ...ides.slice(index + 1)];
}

/**
 * 「用 IDE 打开这个文件夹」。
 *
 * 跟「打开方式」（`OpenWithMenu`）分开，因为问的不是同一件事：那个问的是系统文件关联，
 * 对一个文件夹问出来的是访达和解压工具；「编程 IDE」系统里没有这个概念，只能由服务端
 * 按一张清单去本机找（server/src/openers/ide-catalog.ts）。
 *
 * 探测同样是**点开菜单时才发起**，理由和 `OpenWithMenu` 顶部那段一模一样：请求由点击
 * 直接发出，不放进 effect（放进去就要拿 state 当守卫，而那个 state 一进依赖数组，
 * `setState(loading)` 自己会触发重跑，在途响应被 cleanup 作废，菜单永远停在「正在查…」）。
 *
 * 「别重复发」分成两件事，不能用一个标记一起管：**在途去重**看 `pending`，**已有结果**
 * 看 state 是不是 `ready`。合在一起的写法（发过就不再发）会把一次临时失败变成永久的
 * ——服务早就恢复了，反复开关菜单却只剩那句报错，只能刷新页面。
 *
 * 在途那一次还必须**能被作废**：探测要 stat 几百个路径，代理或磁盘卡住时请求可能既不
 * 返回也不断开，只靠「等它自己结束」的话菜单就永远停在「正在查…」，关掉重开也被在途
 * 守卫挡回来。所以每次探测都带一个 `AbortController` 和一道自己的期限，「重新探测」在
 * 加载中也点得动——它作废旧的那次再起一次。旧请求的回包一律按身份丢弃，不许盖掉新结果。
 */
export function OpenInIdeMenu({
  taskId,
  path,
  notify,
  variant = "label",
}: {
  taskId: string;
  /** 工作区内的相对路径；空字符串就是工作目录本身。 */
  path: string;
  notify: (message: string) => void;
  /** `icon` 给文件树头部那排 24px 方钮，`label` 给中间栏带文字的工具条。 */
  variant?: "icon" | "label";
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProbeState>({ status: "idle" });
  // 两份菜单（文件树头部、文件夹详情）共享同一个偏好，谁那边选过了另一份也跟着变。
  const last = useLastIde();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // 此刻在飞的那一次。关掉菜单不作废它（重开能直接拿到结果），但「重新探测」可以。
  const pending = useRef<AbortController | null>(null);

  useDismissable({
    enabled: open,
    containerRef: root,
    onClose: () => setOpen(false),
    restoreFocusRef: trigger,
  });

  const probeOnce = (force = false) => {
    if (pending.current && !force) return;
    // 已经探到过就别再打扰服务端；失败那一次不算「探到过」，下次打开菜单会自己重试。
    if (!force && state.status === "ready") return;
    pending.current?.abort(new Error("已被新的一次探测取代"));
    const controller = new AbortController();
    pending.current = controller;
    const expire = setTimeout(
      () => controller.abort(new Error("探测这台机器装了哪些 IDE 超时了，点「重新探测」再试一次")),
      PROBE_TIMEOUT_MS,
    );
    setState({ status: "loading" });
    api.ides(force, controller.signal).then(
      (probe) => { if (pending.current === controller) setState({ status: "ready", probe }); },
      (reason) => {
        // 被新一次探测顶掉的旧回包直接丢：它的结果已经过期，盖上去就是在回退界面。
        if (pending.current !== controller) return;
        setState({
          status: "error",
          message: reason instanceof Error ? reason.message : String(reason),
        });
      },
    ).finally(() => {
      clearTimeout(expire);
      if (pending.current === controller) pending.current = null;
    });
  };

  const launch = async (ide: IdeApp) => {
    setOpen(false);
    try {
      const result = await api.openTaskPathInIde(taskId, path, ide.id);
      // 没被拒绝才记，而且只记成「上次选的」——`launching` 那一档服务端并没有拿到确认，
      // 把它说成「上次真正打开成功的那个」就是在编（见 idePreference.ts）。
      rememberIde(ide.id);
      notify(result.status === "opened"
        ? `已用 ${ide.name} 打开`
        : `已拉起 ${ide.name}，但没等到它的回执——窗口没出现的话就是没启动成功`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const probe = state.status === "ready" ? state.probe : null;
  const ides = probe ? ordered(probe.ides, last) : [];

  return (
    // `is-rail` 让菜单改以整条头部为锚（窄面板里定宽右对齐会被削边，见 files.css）。
    <div className={`file-ide${variant === "icon" ? " is-rail" : ""}`} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={variant === "icon" ? "file-tree__action" : "file-viewer__action"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={variant === "icon" ? "用编程 IDE 打开这个文件夹" : undefined}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) probeOnce();
        }}
      >
        <Code size={13} aria-hidden="true" />
        {variant === "label" && (
          <>
            用 IDE 打开
            <CaretDown size={9} weight="bold" aria-hidden="true" />
          </>
        )}
      </button>
      {open && (
        <Menu className="file-openwith__menu">
          {state.status === "loading" && <p className="file-openwith__hint">正在看本机装了哪些 IDE…</p>}
          {state.status === "error" && <p className="file-openwith__hint is-error">{state.message}</p>}
          {probe?.note && <p className="file-openwith__hint">{probe.note}</p>}
          {ides.map((ide) => (
            <MenuItem key={ide.id} onClick={() => void launch(ide)}>
              <span className="file-openwith__app">
                <b>{ide.name}{ide.id === last && <em>上次选的</em>}</b>
                <small>{ide.detail}</small>
              </span>
            </MenuItem>
          ))}
          {/* 三档都需要这颗按钮，各有各的理由：出错了要能重来（服务恢复了总得有个地方
              点）；**加载中**也要能点，否则一次卡住的请求就把菜单锁死了，它会作废在途
              那次再起一次；探到了的人刚装上新 IDE，由 refresh 作废服务端那半分钟缓存。 */}
          {state.status !== "idle" && (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => probeOnce(true)}>
                <span className="file-openwith__app">
                  <b>
                    <ArrowsClockwise size={11} aria-hidden="true" />
                    {state.status === "error" ? "重试" : state.status === "loading" ? "重新探测" : "重新探测本机 IDE"}
                  </b>
                </span>
              </MenuItem>
            </>
          )}
        </Menu>
      )}
    </div>
  );
}

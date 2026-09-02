// 会话流的「粘底」。轮询把新内容塞进来时自动跟到底，但正在往回翻历史的人不该被抢走
// 阅读位置。
//
// 原来只挂了 onScroll + onContentSizeChange，漏掉两件在手机上天天发生的事：
//
// 1. **容器高度变了，内容尺寸没变** —— 键盘弹出（KeyboardAvoidingView 顶起来）、待发
//    送托盘多一行、输入框敲成三行，可视区都会缩短。ScrollView 缩短时 contentOffset
//    原样不动，于是底部内容被推出视野：用户看到的是「刚发完消息，最后几条不见了」。
//    contentSize 没变，onContentSizeChange 一声不吭，只有 onLayout 知道。
// 2. **程序性滚动自己把粘底关掉** —— scrollToEnd 动画途中 onScroll 照常上报，起手那
//    几帧距底几百 px，阈值判断当场把 stick 置 false。此后再来新内容就不跟了，表现正
//    是「粘底时灵时不灵」。所以程序性滚动期间的滚动事件一律不参与判定。
import { useCallback, useRef, type RefObject } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView, View, LayoutChangeEvent } from "react-native";

// 距底多近算「还粘着」。一行气泡的高度量级，手指轻轻带一下不会脱粘。
const STICK_THRESHOLD = 80;
// 程序性滚动的静默窗口，够 iOS 的滚动动画跑完。
const PROGRAMMATIC_MS = 400;
// 拉进视野时在下缘留的余量。
const REVEAL_PAD = 12;
// 键盘弹完、可视区缩到最终高度所需的时间（iOS 动画约 250ms），之后再校一次位置。
const KEYBOARD_SETTLE_MS = 400;

export type StickyBottom = ReturnType<typeof useStickyBottom>;

export function useStickyBottom(ref: RefObject<ScrollView | null>) {
  const stick = useRef(true);
  const viewport = useRef(0);
  // 当前滚动位置。revealNode 要拿它换算目标偏移 —— measureInWindow 给的是屏幕坐标，
  // 而 scrollTo 吃的是内容坐标，中间差的正是当前偏移。
  const offset = useRef(0);
  const quietUntil = useRef(0);
  // 首屏那一次直接落底，别当着用户面把整段历史滚一遍。
  const settled = useRef(false);
  // 包住 ScrollView 的那层 View，用来量「可视区此刻在屏幕的哪一块」。ScrollView 自己
  // 没有公开 measureInWindow，套一层普通 View 是最省事又跨平台的量法。
  const viewportRef = useRef<View>(null);

  const scrollToEnd = useCallback((animated: boolean) => {
    quietUntil.current = Date.now() + PROGRAMMATIC_MS;
    ref.current?.scrollToEnd({ animated });
  }, [ref]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    // 偏移无条件记：程序性滚动同样会改变它，而 revealNode 要的是「此刻在哪」。
    offset.current = contentOffset.y;
    if (Date.now() < quietUntil.current) return;
    const distanceFromBottom = contentSize.height - (layoutMeasurement.height + contentOffset.y);
    stick.current = distanceFromBottom < STICK_THRESHOLD;
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (!stick.current) return;
    const animated = settled.current;
    settled.current = true;
    scrollToEnd(animated);
  }, [scrollToEnd]);

  // 可视区高度变化（键盘、输入区叠高、旋转）后重新贴底。等一帧再滚：这一帧原生刚量完
  // 自己的新尺寸，JS 侧的内容可能还在同一批更新里，晚一帧两边都是最终值。
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height === viewport.current) return;
    const grew = height > viewport.current;
    viewport.current = height;
    if (!stick.current) return;
    // 变矮（键盘弹出）时不做动画：内容本来就在眼前，动一下反而像被抽走了。
    requestAnimationFrame(() => scrollToEnd(grew && settled.current));
  }, [scrollToEnd]);

  /** 「接下来这次内容更新我要看到」—— 发送、重跑之类由用户自己触发的动作前调一下。 */
  const stickNow = useCallback(() => {
    stick.current = true;
  }, []);

  /**
   * 把某个节点的**下缘**拉进视野 —— 会用到的都在下缘（问题卡的输入框和发送键）。卡片
   * 比一屏还高时照样按下缘对齐，上面的问题正文滚出去无妨：人是点了输入框才触发它的，
   * 此刻要看见的是"往哪打字、按哪发送"。
   *
   * 位置是**当场量**的，不缓存：`onLayout` 只在节点自己的尺寸变化时才回调（RN Web 干
   * 脆是 ResizeObserver，只看大小），上方内容一长它就把节点推走却不再通知，缓存下来的
   * 坐标于是越用越假 —— 实测过一次「点输入框反而从两万八千像素的底部跳回开头」。
   *
   * 量两次：第一次让内容立刻动起来，第二次等键盘弹完（iOS 动画约 250ms）——那时可视区
   * 才缩到最终高度，头一次算出的位置已经不够低了。第二次发现已经露全就自己收手，不抖。
   */
  const revealNode = useCallback((node: View | null) => {
    const pass = () => {
      const container = viewportRef.current;
      if (!node || !container) return;
      container.measureInWindow((_cx, containerY, _cw, containerHeight) => {
        node.measureInWindow((_nx, nodeY, _nw, nodeHeight) => {
          if (!containerHeight) return;
          const overshoot = nodeY - containerY + nodeHeight + REVEAL_PAD - containerHeight;
          if (overshoot <= 0) return; // 下缘已经在视野里，别为滚而滚
          stick.current = false;
          quietUntil.current = Date.now() + PROGRAMMATIC_MS;
          ref.current?.scrollTo({ y: Math.max(0, offset.current + overshoot), animated: true });
        });
      });
    };
    pass();
    setTimeout(pass, KEYBOARD_SETTLE_MS);
  }, [ref]);

  return { onScroll, onContentSizeChange, onLayout, stickNow, scrollToEnd, revealNode, viewportRef };
}

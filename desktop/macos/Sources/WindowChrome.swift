import AppKit
import WebKit

/// 把标题栏那一条还给页面：内容铺到窗口顶，红绿灯直接浮在页面左上角，不再单占一行。
///
/// 页面与壳的约定（页面那一半在 web/index.html 和 web/src/styles/window-shell.css）：
///  · 页面先表态：文档里有 `<meta name="ash-window-chrome" content="overlay">` 才铺上去。没有这一行的
///    文档（旧版本的 ash、同源的 /mobile 之类别的页面）不知道要给红绿灯让位，壳就退回普通标题栏。
///  · 壳在 `<html>` 上写 `data-window-shell="mac"`，外加两个长度：`--window-titlebar-height`
///    （红绿灯那一条多高）、`--window-controls-width`（红绿灯占掉左边多宽）。全屏时红绿灯收起、
///    退回普通标题栏时不压着页面，两个值都是 0。浏览器里没有这两个变量，页面按 0 排，和原来一样。
///  · 这一屏要多大的窗也由页面说：`<html data-window-size="setup">` 是首次配置（壳开成一扇正好装下它的
///    小窗），`"work"` 是工作台（展开成工作窗）。属性一变就转告 `onWindowSize`；不认这套约定的文档
///    （上面那行 meta 都没有的）一律按 work。壳把「报了尺寸」当成这份文档已经画出来了（首启那一屏等到它才撤）。
///  · 页面的 <script> 没载成时报 `broken:<地址>`，壳不再等它表态。
///  · 窗口从哪儿能拖：顶上 `--window-titlebar-height` 那一条里的空白处总是能拖，不用页面逐页配合；
///    页面再用 `--window-drag: drag` 把自己的顶栏整条划进来，`no-drag` 划出去。
///    按钮、链接、输入框、带手型或拉伸光标的东西永远不算空白。
///
/// WKWebView 不认 `-webkit-app-region`，鼠标事件也全被它收走，所以「拖」只能由页面脚本认出来再
/// 交回原生：按下时先不动，移出几个点才 `performDrag` —— 原地点一下仍是一次完整的点击，页面照常收到。
final class WindowChrome: NSObject, WKScriptMessageHandler {
  private static let messageName = "ashWindowChrome"

  private weak var window: NSWindow?
  private weak var webView: WKWebView?
  private var mouseMonitor: Any?
  private var lastMouseDown: NSEvent?
  private var fullScreen = false
  /// 内容是不是铺在红绿灯下面。先按「是」起步（主页面占绝大多数，免得每次载入都跳一下），
  /// 文档读完由页面表态，不认这套约定的再退回去。
  private(set) var overlay = true
  /// 左键此刻是不是真按着。只有原生问得到；探针里没有真鼠标，换成它自己的回答。
  var isPrimaryButtonDown: () -> Bool = { NSEvent.pressedMouseButtons & 1 == 1 }
  /// 页面说这一屏要多大的窗（"setup" / "work"）。
  var onWindowSize: ((String) -> Void)?
  /// 页面的脚本没载成（交出那个脚本的地址）。这时页面多半永远画不出来，也不会再表态。
  var onPageBroken: ((String) -> Void)?
  private var zoomObservation: NSKeyValueObservation?

  init(window: NSWindow, webView: WKWebView) {
    self.window = window
    self.webView = webView
    super.init()

    // 透明标题栏两种排法都用：窗口底色跟页面的 theme-color 走，退回普通标题栏时也和页面连成一片。
    window.titlebarAppearsTransparent = true
    applyOverlay()

    // 弱引用转一道：userContentController 强持有 handler，直接交 self 会连着 webView 成环。
    webView.configuration.userContentController.add(WeakMessageHandler(self), name: Self.messageName)

    // ⌘+ / ⌘- 改的是 CSS 像素的大小，红绿灯却不跟着缩放，换算要重做。
    zoomObservation = webView.observe(\.pageZoom) { [weak self] _, _ in self?.refresh() }
    // performDrag 要的是「这次按下」那个事件；等页面的消息绕回来时 currentEvent 早就换了。
    mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
      self?.lastMouseDown = event
      return event
    }
    refresh()
  }

  deinit {
    if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
  }

  private func applyOverlay() {
    guard let window else { return }
    if overlay {
      window.styleMask.insert(.fullSizeContentView)
    } else {
      window.styleMask.remove(.fullSizeContentView)
    }
    // 铺上去时标题不画在窗口上，但 window.title 照设：「窗口」菜单、调度中心、辅助功能读的都是它。
    window.titleVisibility = overlay ? .hidden : .visible
  }

  /// 全屏时红绿灯收起，页面不用再给它留位置。由窗口的 delegate 转告。
  func setFullScreen(_ value: Bool) {
    fullScreen = value
    refresh()
  }

  // MARK: 量尺寸，交给页面

  /// 红绿灯那一条的高度和它占掉的左侧宽度，单位是页面的 CSS 像素。按真实按钮的位置量，
  /// 不写死：不同版本的 macOS 上红绿灯的位置和标题栏高度并不一样。
  private var metrics: (titlebar: Double, controls: Double) {
    guard let window, let webView, overlay, !fullScreen,
          let close = window.standardWindowButton(.closeButton),
          let zoom = window.standardWindowButton(.zoomButton) else { return (0, 0) }
    let titlebar = window.frame.height - window.contentLayoutRect.maxY
    let leading = close.convert(close.bounds, to: nil).minX
    let trailing = zoom.convert(zoom.bounds, to: nil).maxX
    let scale = max(webView.pageZoom, 0.1)
    // 右边留出和左边一样的边距，红绿灯在它那块留白里左右对称。
    return ((titlebar / scale).rounded(.up), ((trailing + leading) / scale).rounded(.up))
  }

  /// 尺寸变了（全屏、缩放、换了排法）：当前页面立即改，之后新载入的文档从一开始就是对的。
  func refresh() {
    guard let webView else { return }
    let (titlebar, controls) = metrics
    let apply = "window.__ashWindowChrome && window.__ashWindowChrome(\(titlebar), \(controls));"
    let controller = webView.configuration.userContentController
    controller.removeAllUserScripts()
    controller.addUserScript(WKUserScript(
      source: Self.pageScript + apply, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    webView.evaluateJavaScript(apply)
  }

  // MARK: 页面交回来的手势

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let window, message.frameInfo.isMainFrame, let kind = message.body as? String else { return }
    if kind.hasPrefix("size:") { return onWindowSize?(String(kind.dropFirst(5))) ?? () }
    if kind.hasPrefix("broken:") { return onPageBroken?(String(kind.dropFirst(7))) ?? () }
    switch kind {
    case "overlay", "titlebar":
      if kind == "titlebar" { onWindowSize?("work") }
      guard overlay != (kind == "overlay") else { return }
      overlay = kind == "overlay"
      applyOverlay()
      refresh()
    case "drag":
      // 消息到的时候手可能已经松了；这时再开始拖，窗口会粘在指针上直到下一次点击。
      guard isPrimaryButtonDown() else { return }
      if let event = lastMouseDown, event.window === window { window.performDrag(with: event) }
    case "zoom":
      // 双击标题栏做什么是系统设置里的一项，跟着它走。
      switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
      case "None": break
      case "Minimize": window.miniaturize(nil)
      default: window.zoom(nil)
      }
    default:
      break
    }
  }

  /// 文档一开始就跑：立下 `__ashWindowChrome(titlebar, controls)` 这个入口，替页面表态，并接管「拖窗口」的手势。
  private static let pageScript = #"""
  (() => {
    if (window.__ashWindowChrome) return;
    const root = document.documentElement;
    let titlebar = 0;
    window.__ashWindowChrome = (height, controls) => {
      titlebar = height;
      root.dataset.windowShell = "mac";
      root.style.setProperty("--window-titlebar-height", height + "px");
      root.style.setProperty("--window-controls-width", controls + "px");
    };
    const post = (kind) => window.webkit.messageHandlers.ashWindowChrome.postMessage(kind);
    // 这份文档认不认这套约定，读完 <head> 才知道。
    const declare = () => post(document.querySelector("meta[name='ash-window-chrome'][content='overlay']") ? "overlay" : "titlebar");
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", declare, { once: true });
    else declare();
    // 这一屏要多大的窗：页面（AuthGate）写在 <html data-window-size> 上，变一次报一次。
    new MutationObserver(() => {
      if (root.dataset.windowSize) post("size:" + root.dataset.windowSize);
    }).observe(root, { attributes: true, attributeFilter: ["data-window-size"] });
    // 脚本没载成（入口 404/503、断在半路）不会让导航失败，页面却再也画不出来：报回去，壳不必干等。
    window.addEventListener("error", (event) => {
      if (event.target instanceof HTMLScriptElement) post("broken:" + (event.target.src || "inline"));
    }, true);
    const ROLES = [
      "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "switch",
      "checkbox", "radio", "slider", "separator", "scrollbar", "textbox", "searchbox", "combobox", "spinbutton",
    ];
    const INTERACTIVE = [
      "a[href]", "button", "input", "textarea", "select", "summary", "label",
      "[tabindex]:not([tabindex='-1'])", "[contenteditable]:not([contenteditable='false'])", "[draggable='true']",
      ...ROLES.map((role) => `[role='${role}']`),
    ].join(",");
    // 落点算不算标题栏的空白：在顶上那一条里，或页面用 --window-drag 划了进来；且不是能操作的东西。
    const grabs = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || event.button !== 0 || event.ctrlKey || target.closest(INTERACTIVE)) return false;
      const style = getComputedStyle(target);
      const region = style.getPropertyValue("--window-drag").trim();
      if (region === "no-drag" || (region !== "drag" && event.clientY >= titlebar)) return false;
      // 手型、拉伸这类光标说明它自己要响应鼠标（比如侧栏的拖拽分隔条）。
      if (style.cursor !== "auto" && style.cursor !== "default") return false;
      // 落在滚动条上的不算。
      const box = target.getBoundingClientRect();
      return event.clientX <= box.left + target.clientLeft + target.clientWidth
        && event.clientY <= box.top + target.clientTop + target.clientHeight;
    };
    let origin = null;
    window.addEventListener("mousedown", (event) => {
      origin = null;
      if (!grabs(event)) return;
      // 不让这一下开始选字（之后要是真拖起来，松手那一下页面收不到，选区会粘在指针上）；click 照常发生。
      // 默认行为里要留的只有一样：点空白处让正在编辑的输入框失焦 —— 靠失焦提交的改名框指着它。
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      origin = { x: event.screenX, y: event.screenY };
    }, true);
    window.addEventListener("mousemove", (event) => {
      if (!origin) return;
      if (Math.hypot(event.screenX - origin.x, event.screenY - origin.y) < 3) return;
      origin = null;
      // 手是不是还按着由原生那边认（松手那一下可能没送到页面），这里只管报。
      post("drag");
    }, true);
    window.addEventListener("mouseup", () => { origin = null; }, true);
    window.addEventListener("dblclick", (event) => { if (grabs(event)) post("zoom"); }, true);
  })();
  """#
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  private weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

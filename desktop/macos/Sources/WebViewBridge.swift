import AppKit
import WebKit

/// 页面与系统之间的几处接缝：外链、新窗口、文件选择、下载、JS 对话框。
/// WKWebView 对这些默认什么都不做（选文件没反应、下载静默丢弃、confirm 恒返回 false），
/// 每一处不接就是一个「按钮坏了」。
extension BrowserWindowController: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {

  // MARK: 导航

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload {
      decisionHandler(.download)
      return
    }
    // 只管主框架：预览 iframe 指向别的端口是正常的，放它在页内加载。
    guard action.targetFrame?.isMainFrame ?? true, let url = action.request.url else {
      decisionHandler(.allow)
      return
    }
    let scheme = url.scheme?.lowercased() ?? ""
    if ["about", "blob", "data"].contains(scheme) || AshConfig.isSameOrigin(url) {
      decisionHandler(.allow)
      return
    }
    // 外站、预览地址、mailto: 之类一律交给系统默认程序，壳里只留 ash 自己。
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    decisionHandler(response.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    handleLoadFailure(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    handleLoadFailure(error)
  }

  /// web 进程被系统回收后页面会变成一片白，原地重载即可。
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    loadHome()
  }

  private func handleLoadFailure(_ error: Error) {
    let nsError = error as NSError
    // 页面自己发起新导航把上一次顶掉，或改走下载，都不是连不上。
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
    if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
    showOffline(error)
  }

  // MARK: 新窗口 / 对话框 / 选文件

  /// `window.open` 与 `target=_blank`：预览、外链都走系统浏览器；同源的就地打开，不另起窗口。
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    guard let url = action.request.url else { return nil }
    if AshConfig.isSameOrigin(url) {
      webView.load(action.request)
    } else {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    guard let window else { return completionHandler(nil) }
    panel.beginSheetModal(for: window) { result in
      completionHandler(result == .OK ? panel.urls : nil)
    }
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "好")
    present(alert) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "好")
    alert.addButton(withTitle: "取消")
    present(alert) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  private func present(_ alert: NSAlert, _ done: @escaping (NSApplication.ModalResponse) -> Void) {
    if let window { alert.beginSheetModal(for: window, completionHandler: done) } else { done(alert.runModal()) }
  }

  // MARK: 下载

  /// 导出 md / 配置这类 blob 下载：弹保存面板让人自己定位置。
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedFilename
    panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    guard let window else { return completionHandler(nil) }
    panel.beginSheetModal(for: window) { result in
      guard result == .OK, let url = panel.url else { return completionHandler(nil) }
      do {
        let transaction = try DownloadTransaction(destination: url)
        self.downloads[ObjectIdentifier(download)] = transaction
        completionHandler(transaction.temporaryURL)
      } catch {
        completionHandler(nil)
        self.present(NSAlert(error: error)) { _ in }
      }
    }
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let transaction = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
    do {
      try transaction.commit()
    } catch {
      present(NSAlert(error: error)) { _ in }
    }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))?.discard()
    let alert = NSAlert(error: error)
    present(alert) { _ in }
  }
}

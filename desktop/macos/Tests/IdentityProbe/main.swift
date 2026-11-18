import AppKit
import WebKit

// scripts/test-macos-identity.mjs 的 WebKit 探针：一个只带 WKWebView 的空壳 app。旧身份那一份（ProbeMode=write）
// 打开本机页面、往 localStorage 和 cookie 里各存一样就退；新身份那一份（ProbeMode=read）先走真的
// LegacyIdentity.adoptWebData 把旧身份的网站数据复制过来，再打开同一个源，读出来记一行。
// 验的是「换了包标识、复制了 WebKit 数据之后，同一个源的本机数据还在」这件只有真 WebKit 才说得准的事。

let info = Bundle.main.infoDictionary ?? [:]
let logPath = info["ProbeLog"] as? String ?? "/dev/null"
let pageURL = URL(string: info["ProbeURL"] as? String ?? "http://127.0.0.1:9")!
let probeMode = info["ProbeMode"] as? String ?? "read"

func emit(_ line: String) {
  let data = Data("\(line)\n".utf8)
  if let handle = FileHandle(forWritingAtPath: logPath) {
    handle.seekToEndOfFile()
    handle.write(data)
    handle.closeFile()
  } else {
    FileManager.default.createFile(atPath: logPath, contents: data)
  }
}

final class Probe: NSObject, WKNavigationDelegate {
  let webView: WKWebView

  override init() {
    if probeMode == "read", let legacy = info["LegacyID"] as? String, let own = Bundle.main.bundleIdentifier {
      let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
      let copied = (try? LegacyIdentity.adoptWebData(library: library, from: legacy, to: own, defaults: .standard)) ?? []
      emit("COPIED \(copied.count)")
    }
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()
    webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: config)
    super.init()
    webView.navigationDelegate = self
    webView.load(URLRequest(url: pageURL))
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let script = probeMode == "write"
      ? "localStorage.setItem('navi:probe', 'kept'); document.cookie = 'probe=kept; max-age=86400; path=/'; 'written'"
      : "JSON.stringify({ localStorage: localStorage.getItem('navi:probe'), cookie: document.cookie })"
    webView.evaluateJavaScript(script) { result, error in
      emit("\(probeMode.uppercased()) \(error.map { "ERROR \($0.localizedDescription)" } ?? String(describing: result ?? "nil"))")
      // 写完给 WebKit 一点时间落盘（localStorage、cookie 都是异步写的），再正常退出。
      DispatchQueue.main.asyncAfter(deadline: .now() + (probeMode == "write" ? 3 : 0)) { NSApp.terminate(nil) }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    emit("ERROR \(error.localizedDescription)")
    NSApp.terminate(nil)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    emit("ERROR \(error.localizedDescription)")
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let probe = Probe()
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
  emit("ERROR timeout")
  NSApp.terminate(nil)
}
app.run()

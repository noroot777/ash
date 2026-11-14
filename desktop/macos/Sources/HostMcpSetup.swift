import AppKit

/// 首次连上自己那份服务时，替本机 CLI 接好 ash MCP（`POST /api/ash-mcp/host-setup`，逐家补接的
/// 逻辑在 server 的 mcp-registry/host-setup.ts：缺了才写、已有一律不覆盖）。
///
/// 已有登记却**指向别处**的（最常见的是指向仓库里的 `mcp/dist`）不替用户改：那条可能是他自己
/// 写的、也可能正连着开发实例。这里把「现在指向哪、指向这个 app 该改成什么」摆出来，改不改由他。
/// 每个数据根自动跑一次；菜单「检查 ash MCP 登记」随时再查。
enum HostMcpSetup {
  struct Host: Decodable {
    let agentType: String
    let file: String?
    let state: String
    let current: String?
    let wanted: String?
    let detail: String?
  }

  private struct Reply: Decodable { let hosts: [Host] }

  private static let doneKey = "HostMcpSetupDone"

  /// 这个数据根还没自动查过就查一次；一切正常时不出声。
  static func runOnceIfNeeded(window: NSWindow?) {
    let key = AshConfig.dataURL.path
    var done = UserDefaults.standard.stringArray(forKey: doneKey) ?? []
    guard AshConfig.isLocal, !done.contains(key) else { return }
    request { result in
      guard case .success(let hosts) = result else { return }
      done.append(key)
      UserDefaults.standard.set(done, forKey: doneKey)
      present(hosts, window: window, quietWhenFine: true)
    }
  }

  /// 菜单里那一下：结果无论好坏都说。
  static func check(window: NSWindow?) {
    request { result in
      switch result {
      case .success(let hosts): present(hosts, window: window, quietWhenFine: false)
      case .failure(let error):
        let alert = NSAlert()
        alert.messageText = "查不了 ash MCP 登记"
        alert.informativeText = error.localizedDescription
        show(alert, in: window)
      }
    }
  }

  /// 补接要写本机 CLI 的配置，只交给认过的自己那份去做：走窗口专用端口、带上它的实例号，中间换了人
  /// 就连不上或者被拒（server/src/window-port.ts、instance-binding.ts）。
  private static func request(_ completion: @escaping (Result<[Host], Error>) -> Void) {
    AshHealth.probe(AshConfig.windowHealthURL) { probe in
      guard let id = AshHealth.ours(probe)?.id else {
        return DispatchQueue.main.async { completion(.failure(DataImport.Failure("端口上不是这个 app 的 ash 服务，没有去改 CLI 的登记。"))) }
      }
      send(instance: id, completion)
    }
  }

  private static func send(instance: String, _ completion: @escaping (Result<[Host], Error>) -> Void) {
    var request = URLRequest(url: AshConfig.windowURL.appendingPathComponent("api/ash-mcp/host-setup"), timeoutInterval: 60)
    request.httpMethod = "POST"
    request.setValue(instance, forHTTPHeaderField: "x-ash-instance")
    URLSession.shared.dataTask(with: request) { data, response, error in
      let result: Result<[Host], Error>
      if let error {
        result = .failure(error)
      } else if (response as? HTTPURLResponse)?.statusCode == 200, let data, let reply = try? JSONDecoder().decode(Reply.self, from: data) {
        result = .success(reply.hosts)
      } else {
        let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        result = .failure(DataImport.Failure("服务答复不对（HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)）：\(body.prefix(400))"))
      }
      DispatchQueue.main.async { completion(result) }
    }.resume()
  }

  private static func present(_ hosts: [Host], window: NSWindow?, quietWhenFine: Bool) {
    let elsewhere = hosts.filter { $0.state == "elsewhere" }
    let failed = hosts.filter { $0.state == "failed" }
    if quietWhenFine && elsewhere.isEmpty && failed.isEmpty { return }
    let alert = NSAlert()
    var sections: [String] = []
    for host in elsewhere {
      sections.append("\(host.agentType)（\(host.file ?? "配置文件")）现在指向：\n\(host.current ?? "")\n\n要指向这个 app，把这条登记改成：\n\(host.wanted ?? "")")
    }
    for host in failed {
      sections.append("\(host.agentType) 没接上：\(host.detail ?? "")")
    }
    if elsewhere.isEmpty && failed.isEmpty {
      alert.messageText = "本机 CLI 的 ash MCP 都接好了"
      let names = hosts.map { "\($0.agentType)\($0.state == "added" ? "（刚补上）" : "")" }
      alert.informativeText = names.isEmpty ? "这台机器上没找到能接 ash MCP 的 CLI。" : names.joined(separator: "、")
    } else {
      alert.messageText = elsewhere.isEmpty ? "有 CLI 没接上 ash MCP" : "有 CLI 的 ash MCP 指向别处，没有替你改"
      alert.informativeText = elsewhere.isEmpty
        ? "没接上的 CLI 跑完任务交不了卷，照下面的说法补上。"
        : "没接上或没指向这里的 CLI，跑完任务交不了卷。已有的登记 app 不会自动改，改不改你来定。"
      alert.accessoryView = textBlock(sections.joined(separator: "\n\n────────\n\n"))
      alert.addButton(withTitle: "好")
      alert.addButton(withTitle: "拷贝以上内容")
    }
    show(alert, in: window) { response in
      guard response == .alertSecondButtonReturn else { return }
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(sections.joined(separator: "\n\n"), forType: .string)
    }
  }

  private static func textBlock(_ text: String) -> NSView {
    let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 520, height: 220))
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    let view = NSTextView(frame: scroll.bounds)
    view.isEditable = false
    view.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    view.string = text
    view.autoresizingMask = [.width]
    scroll.documentView = view
    return scroll
  }

  private static func show(_ alert: NSAlert, in window: NSWindow?, then: ((NSApplication.ModalResponse) -> Void)? = nil) {
    if let window, window.isVisible {
      alert.beginSheetModal(for: window) { then?($0) }
    } else {
      then?(alert.runModal())
    }
  }
}

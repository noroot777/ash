import AppKit
import ScreenCaptureKit
import CoreImage

struct ComputerCaptureTarget: Decodable, Equatable {
  let application: String
  let name: String
  let windowTitle: String?
}

protocol ComputerPreviewCapturing: AnyObject {
  var onFrame: ((Data) -> Void)? { get set }
  var onFailure: ((String) -> Void)? { get set }
  @MainActor func start(_ target: ComputerCaptureTarget) async throws
  func stop()
}

final class ComputerPreviewStream: NSObject, SCStreamOutput, SCStreamDelegate, ComputerPreviewCapturing {
  var onFrame: ((Data) -> Void)?
  var onFailure: ((String) -> Void)?
  private var capture: SCStream?
  private let queue = DispatchQueue(label: "dev.navi.computer-preview")
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let lock = NSLock()
  private var stopped = false

  @MainActor
  func start(_ target: ComputerCaptureTarget) async throws {
    let applications = NSWorkspace.shared.runningApplications.filter { app in
      app.bundleIdentifier == target.application || app.localizedName == target.application
        || app.bundleURL?.standardizedFileURL.path == target.application
    }
    guard applications.count == 1, let application = applications.first else {
      throw failure("无法确定正在操作的应用，未采集其他画面")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    let windows = content.windows.filter { $0.owningApplication?.processID == application.processIdentifier
      && $0.windowLayer == 0 && $0.frame.width > 1 && $0.frame.height > 1 }
    let titled = target.windowTitle.map { title in windows.filter { $0.title == title } } ?? []
    let candidates = target.windowTitle?.isEmpty == false ? titled : windows
    let order = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    let orderedIDs = order.compactMap { $0[kCGWindowNumber as String] as? CGWindowID }
    let window = candidates.min { left, right in
      (orderedIDs.firstIndex(of: left.windowID) ?? Int.max) < (orderedIDs.firstIndex(of: right.windowID) ?? Int.max)
    }
    guard let window else { throw failure("目标应用没有可采集的窗口") }
    let scale = min(640 / window.frame.width, 480 / window.frame.height, 1)
    let configuration = SCStreamConfiguration()
    configuration.width = max(2, Int(window.frame.width * scale))
    configuration.height = max(2, Int(window.frame.height * scale))
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 12)
    configuration.queueDepth = 3
    configuration.showsCursor = true
    configuration.capturesAudio = false
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    guard !isStopped else { return }
    capture = stream
    try await stream.startCapture()
    if isStopped { try? await stream.stopCapture() }
  }

  func stop() {
    lock.lock(); stopped = true; lock.unlock()
    capture?.stopCapture(completionHandler: nil)
    capture = nil
  }

  private var isStopped: Bool {
    lock.lock(); defer { lock.unlock() }
    return stopped
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard !isStopped, type == .screen, CMSampleBufferIsValid(sampleBuffer),
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
          let buffer = CMSampleBufferGetImageBuffer(sampleBuffer),
          let image = context.createCGImage(CIImage(cvPixelBuffer: buffer), from: CIImage(cvPixelBuffer: buffer).extent),
          let data = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else { return }
    onFrame?(data)
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    if !isStopped { onFailure?(error.localizedDescription) }
  }

  private func failure(_ message: String) -> NSError {
    NSError(domain: "NaviComputerPreview", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

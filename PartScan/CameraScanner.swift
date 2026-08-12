import AVFoundation
import Vision
import SwiftUI

extension Notification.Name {
    static let partScanTextRecognized = Notification.Name("partScanTextRecognized")
    static let partScanPageCaptured = Notification.Name("partScanPageCaptured")
    static let partScanPageCaptureFailed = Notification.Name("partScanPageCaptureFailed")
}

/// AVFoundation delegates invoke their callbacks on `queue`; all mutable capture state is
/// confined to that serial queue, so the reference can safely cross AVFoundation callbacks.
final class CameraScanner: NSObject, ObservableObject, @unchecked Sendable {
    let session = AVCaptureSession()
    @Published var authorizationDenied = false
    @Published var recognizedText = "正在寻找说明书页面…"
    private let queue = DispatchQueue(label: "partscan.camera")
    private let imageProcessingQueue = DispatchQueue(label: "partscan.image-processing", qos: .userInitiated)
    private let photoOutput = AVCapturePhotoOutput()
    private var isConfigured = false
    private var lastRecognition = Date.distantPast
    private let candidateLock = NSLock()
    private var latestCandidates: [OCRHint] = []
    private var pendingCapturePage: Int?
    private var pendingCaptureCandidates: [OCRHint] = []
    private var pendingCaptureHint: ManualPageCaptureHint = .assemblySteps

    func start() {
        print("[PartScan] 请求启动相机")
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: configureAndRun()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async { granted ? self?.configureAndRun() : (self?.authorizationDenied = true) }
            }
        default: authorizationDenied = true
        }
    }

    func stop() {
        print("[PartScan] 请求停止相机")
        queue.async {
            if self.session.isRunning {
                self.session.stopRunning()
                print("[PartScan] 相机已停止")
            }
        }
    }

    /// Takes one deliberate, user-confirmed capture. OCR candidates are stamped with
    /// the same manual page number before they ever leave the device.
    func captureCurrentPage(page: Int, captureHint: ManualPageCaptureHint) {
        partScanLog("[采集] 请求保存第 \(page) 页")
        queue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.candidateLock.lock()
            let candidates = self.latestCandidates.map {
                OCRHint(page: page, text: $0.text, confidence: $0.confidence, boundingBox: $0.boundingBox)
            }
            self.pendingCapturePage = page
            self.pendingCaptureCandidates = candidates
            self.pendingCaptureHint = captureHint
            self.candidateLock.unlock()
            let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            self.photoOutput.capturePhoto(with: settings, delegate: self)
        }
    }

    /// Prevents OCR from the previous manual page being attached after a user turns a page.
    func clearRecognizedCandidates() {
        candidateLock.lock()
        latestCandidates = []
        candidateLock.unlock()
    }

    func resetForNewScan() {
        candidateLock.lock()
        latestCandidates = []
        pendingCapturePage = nil
        pendingCaptureCandidates = []
        candidateLock.unlock()
        DispatchQueue.main.async { self.recognizedText = "正在寻找说明书页面…" }
        print("[PartScan] 已重置为新产品扫描")
    }

    private func configureAndRun() {
        queue.async { [weak self] in
            guard let self else { return }
            if !self.isConfigured {
                self.session.beginConfiguration()
                self.session.sessionPreset = .high
                guard let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), self.session.canAddInput(input) else { self.session.commitConfiguration(); return }
                self.session.addInput(input)
                let output = AVCaptureVideoDataOutput()
                output.setSampleBufferDelegate(self, queue: self.queue)
                guard self.session.canAddOutput(output) else { self.session.commitConfiguration(); return }
                self.session.addOutput(output)
                guard self.session.canAddOutput(self.photoOutput) else { self.session.commitConfiguration(); return }
                self.session.addOutput(self.photoOutput)
                // The preview, live OCR and high-resolution still must use the same
                // portrait coordinate system. Otherwise a visually correct guide
                // maps to a shifted crop in the photo output.
                if let videoConnection = output.connection(with: .video), videoConnection.isVideoOrientationSupported {
                    videoConnection.videoOrientation = .portrait
                }
                if let photoConnection = self.photoOutput.connection(with: .video), photoConnection.isVideoOrientationSupported {
                    photoConnection.videoOrientation = .portrait
                }
                self.session.commitConfiguration()
                self.isConfigured = true
                print("[PartScan] 相机输出已统一为竖屏坐标")
            }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }
}

extension CameraScanner: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard Date().timeIntervalSince(lastRecognition) > 1.1, let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastRecognition = Date()
        let request = VNRecognizeTextRequest { [weak self] request, _ in
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            let candidates = observations.compactMap { observation -> OCRHint? in
                guard let result = observation.topCandidates(1).first else { return nil }
                let box = observation.boundingBox
                return OCRHint(page: 0, text: result.string, confidence: Double(result.confidence), boundingBox: OCRBoundingBox(x: Double(box.origin.x), y: Double(box.origin.y), width: Double(box.width), height: Double(box.height)))
            }
            self?.candidateLock.lock(); self?.latestCandidates = candidates; self?.candidateLock.unlock()
            let text = self?.displayText(from: candidates) ?? ""
            guard !text.isEmpty else { return }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .partScanTextRecognized, object: text)
            }
        }
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US", "ja-JP"]
        request.usesLanguageCorrection = true
        request.minimumTextHeight = 0.018
        try? VNImageRequestHandler(cvPixelBuffer: image, orientation: .up).perform([request])
    }
}

private extension CameraScanner {
    /// Keep the live label useful as a framing indicator rather than showing every
    /// low-confidence symbol found in a desk/background.
    func displayText(from candidates: [OCRHint]) -> String {
        let plate = try? NSRegularExpression(pattern: "^[A-Z]\\d{1,3}$")
        let step = try? NSRegularExpression(pattern: "^\\d{1,2}\\.\\d{1,2}$")
        let useful = candidates.filter { candidate in
            guard candidate.confidence >= 0.55 else { return false }
            let text = candidate.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let range = NSRange(text.startIndex..., in: text)
            let hasChinese = text.range(of: "[\\u{4E00}-\\u{9FFF}]", options: .regularExpression) != nil
            return hasChinese || plate?.firstMatch(in: text, range: range) != nil || step?.firstMatch(in: text, range: range) != nil
        }
        return useful.prefix(4).map(\.text).joined(separator: " · ")
    }
}

extension CameraScanner: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        candidateLock.lock()
        let capturedPage = pendingCapturePage
        let candidates = pendingCaptureCandidates
        let captureHint = pendingCaptureHint
        pendingCapturePage = nil
        pendingCaptureCandidates = []
        candidateLock.unlock()
        guard let capturedPage else { return }
        guard error == nil, let data = photo.fileDataRepresentation() else {
            let reason = error?.localizedDescription ?? "未知错误"
            print("[PartScan] 第 \(capturedPage) 页保存失败：\(reason)")
            DispatchQueue.main.async { NotificationCenter.default.post(name: .partScanPageCaptureFailed, object: capturedPage) }
            return
        }
        partScanLog("[图片] 第 \(capturedPage) 页相机 JPEG 已收到，原始 \(data.count / 1_024) KB，OCR 候选 \(candidates.count) 条")
        imageProcessingQueue.async {
            let startedAt = Date()
            partScanLog("[图片] 第 \(capturedPage) 页开始：解码、文档检测、透视矫正、增强、JPEG 编码")
            let processed = DocumentImageProcessor.shared.process(data)
            ManualImageCache.shared.storeJPEG(processed.data, candidates: candidates, captureHint: captureHint)
            partScanLog("[图片] 第 \(capturedPage) 页处理完成：透视矫正=\(processed.perspectiveCorrected)，增强=\(processed.enhanced)，尺寸=\(processed.pixelWidth)x\(processed.pixelHeight)，输出 \(processed.data.count / 1_024) KB，耗时 \(partScanMilliseconds(since: startedAt))")
            DispatchQueue.main.async { NotificationCenter.default.post(name: .partScanPageCaptured, object: capturedPage) }
        }
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession
    var fillsBounds = false
    func makeUIView(context: Context) -> PreviewView { let view = PreviewView(); view.previewLayer.session = session; view.fillsBounds = fillsBounds; return view }
    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.previewLayer.session = session
        uiView.fillsBounds = fillsBounds
    }
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    var fillsBounds = false { didSet { setNeedsLayout() } }
    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer.videoGravity = fillsBounds ? .resizeAspectFill : .resizeAspect
        if let connection = previewLayer.connection, connection.isVideoOrientationSupported {
            connection.videoOrientation = .portrait
        }
    }
}

private struct ProcessedDocumentImage {
    let data: Data
    let perspectiveCorrected: Bool
    let enhanced: Bool
    let pixelWidth: Int
    let pixelHeight: Int
}

/// Conservative, VLM-safe document enhancement. It flattens perspective and
/// improves text edges without binarizing away assembly lines, arrows or color.
private final class DocumentImageProcessor: @unchecked Sendable {
    static let shared = DocumentImageProcessor()
    private let context = CIContext(options: [.useSoftwareRenderer: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    private init() {}

    func process(_ originalData: Data) -> ProcessedDocumentImage {
        autoreleasepool {
            guard let original = CIImage(
                data: originalData,
                options: [.applyOrientationProperty: true]
            ) else {
                return fallback(originalData)
            }

            let correction = perspectiveCorrect(original)
            let rectified = correction ?? original
            let wasCorrected = correction != nil
            let enhanced = enhance(rectified)

            guard let cgImage = context.createCGImage(enhanced, from: enhanced.extent),
                  let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.92) else {
                return fallback(originalData)
            }

            return ProcessedDocumentImage(
                data: jpeg,
                perspectiveCorrected: wasCorrected,
                enhanced: true,
                pixelWidth: cgImage.width,
                pixelHeight: cgImage.height
            )
        }
    }

    private func perspectiveCorrect(_ image: CIImage) -> CIImage? {
        let startedAt = Date()
        let request = VNDetectDocumentSegmentationRequest()
        let handler = VNImageRequestHandler(ciImage: image, orientation: .up)
        guard (try? handler.perform([request])) != nil,
              let document = request.results?.first else {
            partScanLog("[图片] 文档边缘未识别，保留原始画面，检测耗时 \(partScanMilliseconds(since: startedAt))")
            return nil
        }
        let area = document.boundingBox.width * document.boundingBox.height
        guard area >= 0.35 else {
            partScanLog("[图片] 文档区域过小（\(String(format: "%.2f", area))），保留原始画面，检测耗时 \(partScanMilliseconds(since: startedAt))")
            return nil
        }
        partScanLog("[图片] 检测到文档区域 x=\(String(format: "%.2f", document.boundingBox.origin.x)) y=\(String(format: "%.2f", document.boundingBox.origin.y)) w=\(String(format: "%.2f", document.boundingBox.width)) h=\(String(format: "%.2f", document.boundingBox.height))，检测耗时 \(partScanMilliseconds(since: startedAt))")

        let extent = image.extent
        func point(_ normalized: CGPoint) -> CGPoint {
            CGPoint(
                x: extent.minX + normalized.x * extent.width,
                y: extent.minY + normalized.y * extent.height
            )
        }

        let corrected = image.applyingFilter("CIPerspectiveCorrection", parameters: [
            "inputTopLeft": CIVector(cgPoint: point(document.topLeft)),
            "inputTopRight": CIVector(cgPoint: point(document.topRight)),
            "inputBottomLeft": CIVector(cgPoint: point(document.bottomLeft)),
            "inputBottomRight": CIVector(cgPoint: point(document.bottomRight))
        ])
        guard corrected.extent.width >= 800, corrected.extent.height >= 800 else {
            partScanLog("[图片] 透视校正结果过小，保留原始画面")
            return nil
        }
        return corrected.transformed(by: CGAffineTransform(
            translationX: -corrected.extent.minX,
            y: -corrected.extent.minY
        ))
    }

    private func enhance(_ image: CIImage) -> CIImage {
        image
            .applyingFilter("CIHighlightShadowAdjust", parameters: [
                "inputHighlightAmount": 0.92,
                "inputShadowAmount": 0.22
            ])
            .applyingFilter("CIColorControls", parameters: [
                kCIInputSaturationKey: 0.94,
                kCIInputBrightnessKey: 0.01,
                kCIInputContrastKey: 1.08
            ])
            .applyingFilter("CINoiseReduction", parameters: [
                "inputNoiseLevel": 0.01,
                "inputSharpness": 0.25
            ])
            .applyingFilter("CISharpenLuminance", parameters: [
                kCIInputSharpnessKey: 0.35
            ])
    }

    private func fallback(_ data: Data) -> ProcessedDocumentImage {
        let image = UIImage(data: data)
        return ProcessedDocumentImage(
            data: data,
            perspectiveCorrected: false,
            enhanced: false,
            pixelWidth: image.map { Int($0.size.width * $0.scale) } ?? 0,
            pixelHeight: image.map { Int($0.size.height * $0.scale) } ?? 0
        )
    }
}

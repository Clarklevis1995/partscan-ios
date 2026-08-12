import SwiftUI

private enum ManualCaptureStage: Equatable {
    case plateCatalog, assemblySteps

    var hint: ManualPageCaptureHint { self == .plateCatalog ? .plateCatalog : .assemblySteps }
    var title: String { self == .plateCatalog ? "板件图" : "拼装流程" }
    var step: String { self == .plateCatalog ? "步骤 1/2" : "步骤 2/2" }
    var instruction: String {
        self == .plateCatalog
            ? "先拍板件总览，让模型建立板件与零件编号字典"
            : "再拍具体拼装步骤，模型会按部位生成取件表"
    }
}

struct ScanView: View {
    @EnvironmentObject private var store: PartsStore
    @StateObject private var scanner = CameraScanner()
    @State private var capturedPages = 0
    @State private var currentPage = 1
    @State private var currentPageReady = false
    @State private var isCapturing = false
    @State private var activeRecordingProductID: UUID?
    @State private var captureStage: ManualCaptureStage = .plateCatalog
    @State private var capturingStage: ManualCaptureStage?
    @State private var platePageCount = 0
    @State private var assemblyPageCount = 0

    var body: some View {
        Group {
            if store.pendingProduct == nil {
                ProductSetupView()
            } else {
                recorder
            }
        }
    }

    private var recorder: some View {
        ZStack {
            CameraPreview(session: scanner.session, fillsBounds: true)
                .ignoresSafeArea()
                .blur(radius: 26)
                .scaleEffect(1.12)
                .overlay(LinearGradient(colors: [.black.opacity(0.60), PremiumPalette.ink.opacity(0.58), .black.opacity(0.78)], startPoint: .top, endPoint: .bottom))
                .allowsHitTesting(false)
            VStack(spacing: 0) {
                ZStack {
                    CameraPreview(session: scanner.session, fillsBounds: true)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .overlay(LinearGradient(colors: [.black.opacity(0.17), .clear, .black.opacity(0.20)], startPoint: .top, endPoint: .bottom))
                    VStack(spacing: 0) {
                        scannerHeader
                        scanStatusPill
                            .padding(.top, 14)
                            .padding(.horizontal, 74)
                        Spacer()
                    }
                    .padding(.top, 12)
                }
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(PremiumPalette.champagne.opacity(0.72), lineWidth: 1.5))
                .shadow(color: .black.opacity(0.32), radius: 22, y: 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 16)
                GlassCard(inset: 11) {
                    VStack(spacing: 8) {
                        HStack(spacing: 8) {
                            Text(captureStage.step).font(.caption.weight(.bold))
                            Text(captureStage.title).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text("板件 \(platePageCount) · 拼装 \(assemblyPageCount)").font(.caption).foregroundStyle(.secondary)
                        }
                        HStack {
                            Label("已记录 \(capturedPages) 页", systemImage: "doc.text.fill").font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(currentPageReady ? "等待翻页" : isCapturing ? "正在采集" : "等待扫描").font(.caption).foregroundStyle(PremiumPalette.champagne)
                        }
                        Divider().overlay(.white.opacity(0.25))
                        Button { currentPageReady ? nextPage() : capturePage() } label: {
                            Label(currentPageReady ? "已翻页，扫描下一页" : isCapturing ? "正在保存当前页" : "扫描当前页", systemImage: currentPageReady ? "arrow.right.circle.fill" : "viewfinder.circle.fill")
                                .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 9)
                        }
                        .buttonStyle(.bordered)
                        .disabled(isCapturing)
                        if captureStage == .plateCatalog {
                            Button { switchToAssemblySteps() } label: {
                                Text(platePageCount > 0 ? "板件图拍完了，开始拍拼装流程" : "没有板件图，直接拍拼装流程")
                                    .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 9)
                            }
                            .buttonStyle(.borderedProminent).tint(PremiumPalette.champagne).foregroundStyle(.black).clipShape(Capsule())
                            .disabled(isCapturing)
                        } else {
                            Button { finish() } label: { Text("结束识别").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 9) }
                                .buttonStyle(.borderedProminent).tint(PremiumPalette.champagne).foregroundStyle(.black).clipShape(Capsule())
                                .disabled(isCapturing || assemblyPageCount == 0)
                        }
                    }
                }.padding(.horizontal).padding(.bottom, 8)
            }
            if scanner.authorizationDenied { Color.black.opacity(0.72).ignoresSafeArea(); ContentUnavailableView("需要相机权限", systemImage: "camera.fill", description: Text("请在系统设置中允许相机访问，以扫描模型说明书。 ")).foregroundStyle(.white) }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .tabBar)
        .onAppear { prepareRecordingForCurrentProduct() }
        .onChange(of: store.pendingProduct?.id) { _ in
            if store.pendingProduct == nil { activeRecordingProductID = nil }
            else { prepareRecordingForCurrentProduct() }
        }
        .onDisappear { scanner.stop() }
        .onReceive(NotificationCenter.default.publisher(for: .partScanTextRecognized)) { notification in
            if let text = notification.object as? String { scanner.recognizedText = "已识别：\(text)" }
        }
        .onReceive(NotificationCenter.default.publisher(for: .partScanPageCaptured)) { notification in
            guard let page = notification.object as? Int, page == currentPage else { return }
            isCapturing = false
            currentPageReady = true
            capturedPages += 1
            if capturingStage == .plateCatalog { platePageCount += 1 } else { assemblyPageCount += 1 }
            capturingStage = nil
        }
        .onReceive(NotificationCenter.default.publisher(for: .partScanPageCaptureFailed)) { notification in
            guard let page = notification.object as? Int, page == currentPage else { return }
            isCapturing = false
            capturingStage = nil
            scanner.recognizedText = "保存失败，请重新扫描当前页"
        }
    }

    private func capturePage() {
        guard !isCapturing, !currentPageReady else { return }
        isCapturing = true
        capturingStage = captureStage
        scanner.captureCurrentPage(page: currentPage, captureHint: captureStage.hint)
    }

    private var scanStatusPill: some View {
        HStack(spacing: 7) {
            Image(systemName: currentPageReady ? "checkmark.circle.fill" : isCapturing ? "camera.aperture" : "viewfinder")
                .foregroundStyle(PremiumPalette.champagne)
            Text("\(captureStage.step) · \(captureStage.title)").font(.caption.weight(.bold))
            Text("·").opacity(0.45)
            Text(currentPageReady ? "请翻页" : isCapturing ? "保持稳定" : "第 \(currentPage) 页")
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(.white)
        .fixedSize(horizontal: true, vertical: false)
        .padding(.horizontal, 13).padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(Capsule().stroke(.white.opacity(0.20), lineWidth: 0.8))
        .shadow(color: .black.opacity(0.22), radius: 10, y: 5)
    }

    private var scannerHeader: some View {
        HStack {
            Button { cancel() } label: {
                Image(systemName: "xmark")
                    .font(.headline)
                    .frame(width: 42, height: 42)
                    .background(.thinMaterial, in: Circle())
            }
            Spacer()
            Text("扫描说明书").font(.headline).foregroundStyle(.white)
            Spacer()
            Image(systemName: "bolt.fill")
                .frame(width: 42, height: 42)
                .background(.thinMaterial, in: Circle())
        }
        .padding(.horizontal, 14)
    }

    private func nextPage() {
        guard currentPageReady else { return }
        currentPage += 1
        currentPageReady = false
        // The tap means the user has physically turned the page and confirmed
        // it is ready to record; no second scan button tap is required.
        scanner.clearRecognizedCandidates()
        capturePage()
    }

    private func switchToAssemblySteps() {
        guard !isCapturing else { return }
        if currentPageReady {
            currentPage += 1
            currentPageReady = false
        }
        captureStage = .assemblySteps
        scanner.clearRecognizedCandidates()
        scanner.recognizedText = "请对准第一张拼装流程图"
        partScanLog("[采集] 进入拼装流程阶段，板件参考页=\(platePageCount)")
    }

    private func finish() {
        partScanLog("[交互] 用户点击结束识别，已录入 \(capturedPages) 页")
        activeRecordingProductID = nil
        store.beginBackgroundAnalysis()
        // Switch away from the camera while it is still rendering. Stopping it first
        // turns AVFoundation's preview layer black before SwiftUI can transition.
        NotificationCenter.default.post(name: .partScanAnalysisQueued, object: nil)
        scanner.stop()
    }

    private func cancel() {
        guard !isCapturing else { return }
        print("[PartScan] 用户取消扫描，已录入 \(capturedPages) 页")
        scanner.stop()
        activeRecordingProductID = nil
        store.cancelPendingScan()
    }

    private func prepareRecordingForCurrentProduct() {
        guard let productID = store.pendingProduct?.id, productID != activeRecordingProductID else { return }
        activeRecordingProductID = productID
        capturedPages = 0
        platePageCount = 0
        assemblyPageCount = 0
        captureStage = .plateCatalog
        capturingStage = nil
        currentPage = 1
        currentPageReady = false
        isCapturing = false
        scanner.resetForNewScan()
        scanner.start()
        print("[PartScan] 新产品录制状态已初始化 product=\(productID)")
    }
}

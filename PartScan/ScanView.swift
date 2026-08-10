import SwiftUI

struct ScanView: View {
    @EnvironmentObject private var store: PartsStore
    @StateObject private var scanner = CameraScanner()
    @State private var capturedPages = 0
    @State private var currentPage = 1
    @State private var currentPageReady = false
    @State private var isCapturing = false
    @State private var activeRecordingProductID: UUID?

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
                            .padding(.top, 24)
                            .padding(.horizontal, 30)
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
                        Button { finish() } label: { Text("结束识别").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 9) }
                            .buttonStyle(.borderedProminent).tint(PremiumPalette.champagne).foregroundStyle(.black).clipShape(Capsule())
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
        }
        .onReceive(NotificationCenter.default.publisher(for: .partScanPageCaptureFailed)) { notification in
            guard let page = notification.object as? Int, page == currentPage else { return }
            isCapturing = false
            scanner.recognizedText = "保存失败，请重新扫描当前页"
        }
    }

    private func capturePage() {
        guard !isCapturing, !currentPageReady else { return }
        isCapturing = true
        scanner.captureCurrentPage(page: currentPage)
    }

    private var scanStatusPill: some View {
        VStack(spacing: 7) {
            Text(currentPageReady ? "第 \(currentPage) 页已录入，请翻页后点击下一页" : isCapturing ? "正在录入第 \(currentPage) 页，请保持画面稳定" : "对准第 \(currentPage) 页后，点击扫描当前页")
                .font(.subheadline.weight(.semibold))
            Text(scanner.recognizedText).lineLimit(1).font(.caption).opacity(0.76)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 18).padding(.vertical, 13)
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
        currentPage = 1
        currentPageReady = false
        isCapturing = false
        scanner.resetForNewScan()
        scanner.start()
        print("[PartScan] 新产品录制状态已初始化 product=\(productID)")
    }
}

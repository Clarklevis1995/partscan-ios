import SwiftUI

struct RootView: View {
    enum Tab { case library, scan, account }
    @State private var tab: Tab = .library

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { HomeView(onScan: { tab = .scan }) }
                .tabItem { Label("取件表", systemImage: "square.grid.2x2") }.tag(Tab.library)
            NavigationStack { ScanView() }
                .tabItem { Label("扫描", systemImage: "viewfinder") }.tag(Tab.scan)
            NavigationStack { ProfileView() }
                .tabItem { Label("我的", systemImage: "person.crop.circle") }.tag(Tab.account)
        }
        .preferredColorScheme(.dark)
        .tint(PremiumPalette.champagne)
        .onReceive(NotificationCenter.default.publisher(for: .partScanAnalysisQueued)) { _ in
            tab = .library
        }
    }
}

extension Notification.Name {
    static let partScanAnalysisQueued = Notification.Name("partScanAnalysisQueued")
}

enum PremiumPalette {
    static let champagne = Color(red: 0.84, green: 0.73, blue: 0.52)
    static let mist = Color(red: 0.72, green: 0.80, blue: 0.83)
    static let ink = Color(red: 0.045, green: 0.055, blue: 0.065)
}

struct GlassCard<Content: View>: View {
    var content: Content
    private let inset: CGFloat
    init(inset: CGFloat = 16, @ViewBuilder content: () -> Content) { self.inset = inset; self.content = content() }
    var body: some View {
        content
            .padding(inset)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.white.opacity(0.16), lineWidth: 0.8))
            .shadow(color: .black.opacity(0.22), radius: 18, y: 9)
    }
}

struct HomeView: View {
    @EnvironmentObject private var store: PartsStore
    let onScan: () -> Void
    var body: some View {
        ZStack {
            LinearGradient(colors: [PremiumPalette.ink, Color(red: 0.09, green: 0.11, blue: 0.13), Color(red: 0.12, green: 0.10, blue: 0.11)], startPoint: .topLeading, endPoint: .bottomTrailing).ignoresSafeArea()
            Circle().fill(PremiumPalette.champagne.opacity(0.12)).blur(radius: 90).frame(width: 280).offset(x: 150, y: -360)
            Circle().fill(PremiumPalette.mist.opacity(0.08)).blur(radius: 90).frame(width: 300).offset(x: -180, y: 290)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack { VStack(alignment: .leading, spacing: 5) { Text("我的取件表").font(.largeTitle.bold()); Text("模型说明书 · 智能归档").font(.subheadline).foregroundStyle(PremiumPalette.mist) }; Spacer(); Image(systemName: "bell").font(.title3).padding(12).background(.thinMaterial, in: Circle()).overlay(Circle().stroke(.white.opacity(0.14))) }
                    if let current = store.activeProject, current.status != .ready {
                        AnalysisStatusCard(project: current, errorMessage: store.latestAnalysisError)
                    }
                    Button(action: onScan) { Label("新建产品并扫描说明书", systemImage: "viewfinder.circle.fill").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 15) }
                        .buttonStyle(.borderedProminent).tint(PremiumPalette.champagne).foregroundStyle(.black).clipShape(Capsule())
                    Text("最近提取").font(.title3.bold()).padding(.top, 5)
                    ForEach(store.projects) { project in NavigationLink { PartsDetailView(project: project) } label: { ProjectRow(project: project) }.buttonStyle(.plain) }
                }.padding()
            }
        }.navigationBarHidden(true)
    }
}

struct AnalysisStatusCard: View {
    let project: ScanProject
    let errorMessage: String?
    var body: some View {
        GlassCard {
            HStack(spacing: 14) {
                if project.status == .failed {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                } else {
                    ProgressView().tint(PremiumPalette.champagne)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(project.status.rawValue).font(.headline)
                    Text(project.status == .failed
                         ? (errorMessage ?? "取件表生成失败，请重新扫描后再试")
                         : "可以离开此页面，完成后会自动生成取件表")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(project.status == .failed ? "需要处理" : "后台运行")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(project.status == .failed ? .red : PremiumPalette.champagne)
            }
        }
    }
}

struct ProjectRow: View {
    let project: ScanProject
    var body: some View { GlassCard { HStack(spacing: 14) { ProductThumbnail(data: project.coverData); VStack(alignment: .leading, spacing: 4) { Text(project.name).font(.headline).foregroundStyle(.primary); Text("\(project.date) · \(project.sections.count) 个部位 · \(project.totalParts) 件").font(.caption).foregroundStyle(.secondary); Text(project.status.rawValue).font(.caption.weight(.medium)).foregroundStyle(project.status == .ready ? PremiumPalette.champagne : PremiumPalette.mist) }; Spacer(); Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(.tertiary) } } }
}

private struct ProductThumbnail: View {
    let data: Data?
    var body: some View {
        Group {
            if let data, let image = UIImage(data: data) { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: "shippingbox.fill").font(.title3).foregroundStyle(PremiumPalette.champagne) }
        }
        .frame(width: 46, height: 46).background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 15)).clipShape(RoundedRectangle(cornerRadius: 15)).overlay(RoundedRectangle(cornerRadius: 15).stroke(PremiumPalette.champagne.opacity(0.32)))
    }
}

struct ProfileView: View {
    var body: some View {
        List {
            Section("账户") {
                Label("本机资料库", systemImage: "externaldrive")
                NavigationLink { ModelSettingsView() } label: { Label("识别偏好", systemImage: "slider.horizontal.3") }
                NavigationLink { PurchaseView() } label: { Label("购买与用量", systemImage: "creditcard") }
            }
            Section("帮助") {
                Label("识别说明书的技巧", systemImage: "questionmark.circle")
            }
        }
        .navigationTitle("我的")
    }
}

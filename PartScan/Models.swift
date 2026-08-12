import Foundation

struct Part: Identifiable, Hashable {
    let id = UUID()
    var number: String
    var name: String
    var quantity: Int
    let sourcePages: [Int]

    init(number: String, name: String, quantity: Int, sourcePages: [Int] = []) {
        self.number = number; self.name = name; self.quantity = quantity; self.sourcePages = sourcePages
    }
}

struct Plate: Identifiable, Hashable {
    let id = UUID()
    let code: String
    var parts: [Part]
}

struct AssemblySection: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let symbol: String
    var plates: [Plate]
    let sourcePages: [Int]
    init(name: String, symbol: String, plates: [Plate], sourcePages: [Int] = []) {
        self.name = name; self.symbol = symbol; self.plates = plates; self.sourcePages = sourcePages
    }
    var count: Int { plates.flatMap(\.parts).reduce(0) { $0 + $1.quantity } }
}

struct ScanProject: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let date: String
    var status: ProjectStatus
    var sections: [AssemblySection]
    let coverData: Data?
    var uncertainItems: [RemoteUncertainItem]
    var analysisProgress: Int = 0
    var analysisMessage: String = ""
    var totalParts: Int { sections.reduce(0) { $0 + $1.count } }
}

enum CloudModel: String, CaseIterable, Identifiable {
    case flash = "qwen3.7-flash"
    case plus = "qwen3.7-plus"
    case max = "qwen3.7-max"
    case max38 = "qwen3.8-max"
    case gpt56Sol = "gpt-5.6-sol"
    case gpt56Terra = "gpt-5.6-terra"
    case gpt56Luna = "gpt-5.6-luna"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .flash: "Qwen 3.7 Flash"
        case .plus: "Qwen 3.7 Plus"
        case .max: "Qwen 3.7 Max"
        case .max38: "Qwen 3.8 Max（预览）"
        case .gpt56Sol: "GPT-5.6 Sol"
        case .gpt56Terra: "GPT-5.6 Terra"
        case .gpt56Luna: "GPT-5.6 Luna"
        }
    }
    var detail: String {
        switch self {
        case .flash: "速度更快、成本更低，适合大多数说明书"
        case .plus: "视觉理解与成本更均衡，适合通用提取"
        case .max: "复杂图纸理解能力更强，耗时和成本更高"
        case .max38: "Token Plan 专属，视觉精度优先，会启用思考模式"
        case .gpt56Sol: "OpenAI 旗舰视觉模型，精度优先"
        case .gpt56Terra: "OpenAI 视觉能力与成本更均衡"
        case .gpt56Luna: "OpenAI 高吞吐低成本视觉模型"
        }
    }
}

enum ReasoningEffort: String, CaseIterable, Identifiable {
    case none, low, medium, high, xhigh, max
    var id: String { rawValue }
    var title: String {
        switch self {
        case .none: "关闭"
        case .low: "低"
        case .medium: "中"
        case .high: "高"
        case .xhigh: "极高"
        case .max: "最高"
        }
    }
}

struct ProductDraft: Identifiable {
    let id = UUID()
    let name: String
    let coverData: Data?
    let serverID: String
}

enum ProjectStatus: String, Hashable {
    case ready = "取件表已生成"
    case analyzing = "说明书分析中"
    case generating = "取件表生成中"
    case failed = "分析失败"
}

@MainActor
final class PartsStore: ObservableObject {
    @Published var projects: [ScanProject] = [
        ScanProject(name: "P-51D 野马战斗机", date: "今天 09:42", status: .ready, sections: DemoData.sections, coverData: nil, uncertainItems: []),
        ScanProject(name: "F4U 海盗战斗机", date: "昨天 18:20", status: .ready, sections: DemoData.sections, coverData: nil, uncertainItems: []),
        ScanProject(name: "T-34 教练机", date: "7月28日", status: .ready, sections: DemoData.sections, coverData: nil, uncertainItems: [])
    ]
    @Published var activeProject: ScanProject?
    @Published var pendingProduct: ProductDraft?
    @Published var resumableProduct: ProductDraft?
    @Published var selectedModel: CloudModel {
        didSet { UserDefaults.standard.set(selectedModel.rawValue, forKey: "partscan.cloudModel") }
    }
    @Published var useOCR: Bool {
        didSet { UserDefaults.standard.set(useOCR, forKey: "partscan.useOCR") }
    }
    @Published var reasoningEffort: ReasoningEffort {
        didSet { UserDefaults.standard.set(reasoningEffort.rawValue, forKey: "partscan.reasoningEffort") }
    }
    @Published var vlmBatchSize: Int {
        didSet { UserDefaults.standard.set(vlmBatchSize, forKey: "partscan.vlmBatchSize") }
    }
    @Published var multiScaleEnabled: Bool {
        didSet { UserDefaults.standard.set(multiScaleEnabled, forKey: "partscan.multiScaleEnabled") }
    }
    @Published var isCreatingProduct = false
    @Published var productCreationError: String?
    @Published var latestAnalysisError: String?
    private let api = PartScanAPI()

    init() {
        let savedModel = UserDefaults.standard.string(forKey: "partscan.cloudModel")
        selectedModel = CloudModel(rawValue: savedModel ?? "") ?? .flash
        useOCR = UserDefaults.standard.object(forKey: "partscan.useOCR") as? Bool ?? true
        reasoningEffort = ReasoningEffort(rawValue: UserDefaults.standard.string(forKey: "partscan.reasoningEffort") ?? "") ?? .medium
        let savedBatchSize = UserDefaults.standard.integer(forKey: "partscan.vlmBatchSize")
        vlmBatchSize = savedBatchSize == 0 ? 3 : min(8, max(1, savedBatchSize))
        multiScaleEnabled = UserDefaults.standard.object(forKey: "partscan.multiScaleEnabled") as? Bool ?? true
    }

    func createProduct(name: String, coverData: Data?) async {
        if let resumableProduct,
           resumableProduct.name == name,
           resumableProduct.coverData == coverData {
            self.resumableProduct = nil
            pendingProduct = resumableProduct
            print("[PartScan] 继续扫描已有产品草稿")
            return
        }
        isCreatingProduct = true
        productCreationError = nil
        defer { isCreatingProduct = false }
        do {
            let product = try await api.createProduct(name: name, coverData: coverData)
            pendingProduct = ProductDraft(name: product.name, coverData: coverData, serverID: product.id)
            resumableProduct = nil
        } catch {
            productCreationError = error.localizedDescription
        }
    }

    func beginBackgroundAnalysis() {
        guard let draft = pendingProduct else { return }
        let analysisModel = selectedModel
        let analysisUsesOCR = useOCR
        let analysisReasoningEffort = reasoningEffort
        let analysisBatchSize = vlmBatchSize
        let analysisUsesMultiScale = multiScaleEnabled
        let startedAt = Date()
        partScanLog("[分析] 结束识别：创建产品 \(draft.name) 的后台分析任务")
        let project = ScanProject(name: draft.name, date: "刚刚", status: .analyzing, sections: [], coverData: draft.coverData, uncertainItems: [])
        activeProject = project
        projects.insert(project, at: 0)
        pendingProduct = nil
        Task {
            do {
                let pages = ManualImageCache.shared.pages()
                guard !pages.isEmpty else { throw PartScanAPIError.server("尚未保存可上传的说明书页面") }
                partScanLog("[分析] 已进入后台流程：准备读取 \(pages.count) 页说明书（总耗时 \(partScanMilliseconds(since: startedAt))）")
                // Disk I/O and cache cleanup must not run on MainActor: several high
                // resolution pages otherwise freeze the transition away from ScanView.
                let imageData = try await Task.detached(priority: .userInitiated) { () throws -> [(data: Data, hint: ManualPageCaptureHint)] in
                    let readingStartedAt = Date()
                    var result: [(data: Data, hint: ManualPageCaptureHint)] = []
                    result.reserveCapacity(pages.count)
                    for (index, page) in pages.enumerated() {
                        let pageStartedAt = Date()
                        let data = try Data(contentsOf: page.url)
                        partScanLog("[图片] 读取待上传第 \(index + 1) 页：\(data.count / 1_024) KB，\(partScanMilliseconds(since: pageStartedAt))")
                        result.append((data: data, hint: page.captureHint))
                    }
                    ManualImageCache.shared.clear()
                    partScanLog("[图片] 全部页面已读入内存并清理缓存，\(partScanMilliseconds(since: readingStartedAt))")
                    return result
                }.value
                partScanLog("[分析] 开始上传 \(imageData.count) 页说明书（总耗时 \(partScanMilliseconds(since: startedAt))）")
                _ = try await api.uploadManualPages(productID: draft.serverID, pages: imageData)
                partScanLog("[分析] 上传完成，提交 \(analysisModel.rawValue) 分析任务，OCR辅助=\(analysisUsesOCR)，批大小=\(analysisBatchSize)，多尺度=\(analysisUsesMultiScale)，推理强度=\(analysisReasoningEffort.rawValue)（总耗时 \(partScanMilliseconds(since: startedAt))）")
                let job = try await api.startAnalysis(
                    productID: draft.serverID,
                    model: analysisModel,
                    useOCR: analysisUsesOCR,
                    reasoningEffort: analysisReasoningEffort,
                    vlmBatchSize: analysisBatchSize,
                    multiScaleEnabled: analysisUsesMultiScale
                )
                partScanLog("[分析] 任务已创建：\(job.id)（总耗时 \(partScanMilliseconds(since: startedAt))）")
                try await pollAnalysis(job: job, productID: draft.serverID)
            } catch {
                partScanLog("[分析] 后台分析失败（\(partScanMilliseconds(since: startedAt))）：\(error.localizedDescription)")
                updateProjectStatus(.failed)
                latestAnalysisError = error.localizedDescription
                ManualImageCache.shared.clear()
            }
        }
    }

    func cancelPendingScan() {
        resumableProduct = pendingProduct
        pendingProduct = nil
        ManualImageCache.shared.clear()
        print("[PartScan] 已取消扫描，已清理本地说明书缓存并保留产品草稿")
    }

    func saveEditedProject(_ project: ScanProject) {
        guard let index = projects.firstIndex(where: { $0.id == project.id }) else { return }
        projects[index] = project
        if activeProject?.id == project.id { activeProject = project }
    }

    private func pollAnalysis(job: RemoteAnalysis, productID: String) async throws {
        var current = job
        while true {
            updateAnalysisProgress(current.progress, message: current.message)
            switch current.status {
            case "queued", "analyzing": updateProjectStatus(.analyzing)
            case "generating": updateProjectStatus(.generating)
            case "completed":
                let remote = try await api.partsList(productID: productID)
                print("[PartScan] 已取得取件表：\(remote.sections.count) 个部位")
                updateProjectStatus(.ready, sections: remote.sections.map { section in
                    AssemblySection(name: section.name, symbol: "shippingbox", plates: section.plates.map { plate in
                        Plate(code: plate.code, parts: plate.parts.map { Part(number: $0.number, name: $0.name ?? "零件 \($0.number)", quantity: $0.quantity, sourcePages: $0.sourcePages ?? []) })
                    }, sourcePages: section.sourcePages ?? [])
                }, uncertainItems: remote.uncertainItems)
                return
            case "failed": throw PartScanAPIError.server(current.error ?? current.message)
            default: throw PartScanAPIError.server("未知分析状态：\(current.status)")
            }
            try await Task.sleep(for: .seconds(1.5))
            current = try await api.analysis(id: current.id)
        }
    }

    private func updateProjectStatus(_ status: ProjectStatus, sections: [AssemblySection]? = nil, uncertainItems: [RemoteUncertainItem]? = nil) {
        guard var project = activeProject, let index = projects.firstIndex(where: { $0.id == project.id }) else { return }
        project.status = status
        if let sections { project.sections = sections }
        if let uncertainItems { project.uncertainItems = uncertainItems }
        activeProject = project
        projects[index] = project
    }

    private func updateAnalysisProgress(_ progress: Int, message: String) {
        guard var project = activeProject, let index = projects.firstIndex(where: { $0.id == project.id }) else { return }
        project.analysisProgress = min(100, max(0, progress))
        project.analysisMessage = message
        activeProject = project
        projects[index] = project
    }
}

enum DemoData {
    static let sections: [AssemblySection] = [
        AssemblySection(name: "机翼", symbol: "airplane", plates: [
            Plate(code: "A12", parts: [Part(number: "304", name: "机翼上表面", quantity: 2), Part(number: "305", name: "前缘连接件", quantity: 2), Part(number: "312", name: "翼尖小部件", quantity: 2)]),
            Plate(code: "B04", parts: [Part(number: "118", name: "襟翼支架", quantity: 2), Part(number: "119", name: "副翼连杆", quantity: 1)])
        ]),
        AssemblySection(name: "机身", symbol: "rectangle.3.group", plates: [
            Plate(code: "A15", parts: [Part(number: "101", name: "机身左侧板", quantity: 1), Part(number: "102", name: "机身右侧板", quantity: 1), Part(number: "103", name: "座舱框架", quantity: 2)])
        ]),
        AssemblySection(name: "尾翼", symbol: "arrowtriangle.up.fill", plates: [
            Plate(code: "A18", parts: [Part(number: "201", name: "垂直尾翼", quantity: 2), Part(number: "202", name: "水平尾翼", quantity: 2), Part(number: "203", name: "尾翼连接件", quantity: 2)])
        ])
    ]
}

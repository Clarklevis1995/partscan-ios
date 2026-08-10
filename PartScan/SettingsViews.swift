import SwiftUI

struct ModelSettingsView: View {
    @EnvironmentObject private var store: PartsStore
    @AppStorage("partscan.serverURL") private var serverURL = "http://127.0.0.1:3000/v1"
    @State private var connectionState = "未检测"
    private let api = PartScanAPI()
    var body: some View {
        Form {
            Section("服务端") {
                TextField("https://api.example.com/v1", text: $serverURL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("检测连接") {
                    Task {
                        do { try await api.health(); connectionState = "服务正常" }
                        catch { connectionState = "连接失败：\(error.localizedDescription)" }
                    }
                }
                Text(connectionState).font(.caption).foregroundStyle(connectionState == "服务正常" ? .green : .secondary)
            }
            Section("云端分析模型") {
                Picker("默认模型", selection: $store.selectedModel) {
                    ForEach(CloudModel.allCases) { model in
                        Text(model.title).tag(model)
                    }
                }
                .pickerStyle(.navigationLink)
                Text(store.selectedModel.detail).font(.caption).foregroundStyle(.secondary)
                Text("新的分析任务会使用所选模型；正在运行的任务不会被切换。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("OCR 辅助") {
                Toggle("开启 OCR 辅助识别", isOn: $store.useOCR)
                Label(
                    store.useOCR ? "OCR 与 VLM 独立识别，仅将差异加入待核对项，不改写取件表" : "仅使用所选 VLM 分析原图",
                    systemImage: store.useOCR ? "text.viewfinder" : "eye"
                )
                .font(.caption).foregroundStyle(.secondary)
                Text("开关会在创建任务时锁定；不会影响正在运行的分析。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("分析参数") {
                Picker("OpenAI 推理强度", selection: $store.reasoningEffort) {
                    ForEach(ReasoningEffort.allCases) { effort in
                        Text(effort.title).tag(effort)
                    }
                }
                Stepper("每批 \(store.vlmBatchSize) 页", value: $store.vlmBatchSize, in: 1...8)
                Toggle("多尺度高清切片", isOn: $store.multiScaleEnabled)
                Text("推理强度仅对 OpenAI 模型生效。批大小越大，请求次数越少，但单次上下文和图片负载越高；多尺度会增加图像 Token，但通常能改善小号零件编号识别。")
                    .font(.caption).foregroundStyle(.secondary)
                Text("这些参数会随新建分析任务发送并锁定，不会影响正在运行的任务。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("接入方式") {
                Label("图片先上传到你的服务端", systemImage: "server.rack")
                Label("服务端持有百炼 API Key", systemImage: "key.horizontal")
                Label("App 只接收任务状态与结构化取件表", systemImage: "lock.shield")
            }
        }.navigationTitle("识别偏好")
    }
}

struct PurchaseView: View {
    @State private var showNotice = false
    var body: some View {
        List {
            Section("按量 API 成本") {
                LabeledContent("Qwen 3.7 Flash", value: "以控制台实时价格为准")
                LabeledContent("Qwen 3.7 Plus", value: "以控制台实时价格为准")
                LabeledContent("Qwen 3.7 Max", value: "以控制台实时价格为准")
                LabeledContent("Qwen 3.8 Max（预览）", value: "Token Plan 专属")
                LabeledContent("GPT-5.6 Sol / Terra / Luna", value: "OpenAI API 按量计费")
                Text("图片会换算为输入 Token；实际单本成本取决于所选模型、页数、分辨率和输出长度。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("应用服务") {
                PlanRow(title: "按量使用", detail: "仅按实际说明书分析次数计费", selected: true)
                PlanRow(title: "专业版", detail: "批量导入、导出和优先队列 · 上线前配置 StoreKit", selected: false)
                Button("查看百炼实时计费") { showNotice = true }
            }
        }
        .navigationTitle("购买与用量")
        .alert("接入前提示", isPresented: $showNotice) { Button("知道了", role: .cancel) {} } message: { Text("此页面展示产品内的成本与购买入口。实际价格、余额与订阅状态应由你的服务端或 StoreKit 返回。") }
    }
}

private struct PlanRow: View {
    let title: String; let detail: String; let selected: Bool
    var body: some View { HStack { Image(systemName: selected ? "checkmark.seal.fill" : "circle").foregroundStyle(selected ? PremiumPalette.champagne : .secondary); VStack(alignment: .leading) { Text(title); Text(detail).font(.caption).foregroundStyle(.secondary) } } }
}

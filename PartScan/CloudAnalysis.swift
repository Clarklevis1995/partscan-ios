import Foundation

/// Debug traces deliberately contain only timing, endpoint and byte counts. They
/// never print API keys, request bodies or captured manual images.
func partScanLog(_ message: String) {
    let uptime = ProcessInfo.processInfo.systemUptime
    let queue = Thread.isMainThread ? "main" : "background"
    print(String(format: "[PartScan][+%.3fs][%@] %@", uptime, queue, message))
}

func partScanMilliseconds(since start: Date) -> String {
    String(format: "%.0fms", Date().timeIntervalSince(start) * 1_000)
}

enum APIConfiguration {
    /// Simulator can access a locally running NestJS server at this address.
    static var baseURL: URL {
        URL(string: UserDefaults.standard.string(forKey: "partscan.serverURL") ?? "http://127.0.0.1:3000/v1")!
    }
}

struct RemoteProduct: Decodable {
    let id: String
    let name: String
    let manualPageCount: Int
}

struct RemoteModel: Decodable, Identifiable {
    let id: String
    let title: String
    let recommended: Bool
    let usage: String
}

struct RemoteAnalysis: Decodable {
    let id: String
    let productId: String
    let model: String
    let useOcr: Bool?
    let status: String
    let stage: String?
    let progress: Int
    let message: String
    let error: String?
}

struct RemotePartsList: Decodable {
    let productId: String
    let analysisId: String?
    let sections: [RemoteSection]
    let uncertainItems: [RemoteUncertainItem]
}
struct RemoteSection: Decodable { let name: String; let plates: [RemotePlate]; let sourcePages: [Int]? }
struct RemotePlate: Decodable { let code: String; let parts: [RemotePart] }
struct RemotePart: Decodable { let number: String; let name: String?; let quantity: Int; let sourcePages: [Int]? }

struct OCRBoundingBox: Codable, Sendable { let x: Double; let y: Double; let width: Double; let height: Double }
struct OCRHint: Codable, Sendable { let page: Int; let text: String; let confidence: Double; let boundingBox: OCRBoundingBox }
enum ManualPageCaptureHint: String, Codable, Sendable {
    case plateCatalog = "plate_catalog"
    case assemblySteps = "assembly_steps"
}
private struct StartAnalysisRequest: Encodable {
    let model: String
    let useOcr: Bool
    let reasoningEffort: String
    let vlmBatchSize: Int
    let multiScaleEnabled: Bool
}

struct RemoteUncertainItem: Decodable, Hashable {
    let description: String
    let suggestedAction: String?

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let text = try? container.decode(String.self) {
            description = text
            suggestedAction = nil
            return
        }
        let object = try container.decode(Object.self)
        description = object.description
        suggestedAction = object.suggestedAction
    }

    private struct Object: Decodable {
        let description: String
        let suggestedAction: String?
    }
}

enum PartScanAPIError: LocalizedError {
    case invalidResponse, server(String)
    var errorDescription: String? {
        switch self { case .invalidResponse: "服务器返回格式无效"; case .server(let message): message }
    }
}

struct PartScanAPI {
    private let session = URLSession.shared

    func createProduct(name: String, coverData: Data?) async throws -> RemoteProduct {
        let body = MultipartFormData()
        body.addText(name, named: "name")
        if let coverData { body.addFile(coverData, named: "cover", filename: "cover.jpg", mimeType: "image/jpeg") }
        return try await sendMultipart(path: "products", body: body, response: RemoteProduct.self)
    }

    func health() async throws {
        struct Health: Decodable { let status: String }
        _ = try await send(path: "health", response: Health.self)
    }

    func models() async throws -> [RemoteModel] { try await send(path: "analysis/models", response: [RemoteModel].self) }

    func uploadManualPages(productID: String, pages: [(data: Data, hint: ManualPageCaptureHint)]) async throws -> RemoteProduct {
        let body = MultipartFormData()
        for (index, page) in pages.enumerated() {
            body.addFile(page.data, named: "pages", filename: "page-\(index + 1).jpg", mimeType: "image/jpeg")
        }
        let hints = pages.map(\.hint.rawValue)
        let encodedHints = try JSONEncoder().encode(hints)
        body.addText(String(decoding: encodedHints, as: UTF8.self), named: "captureHints")
        return try await sendMultipart(path: "products/\(productID)/manual-pages", body: body, response: RemoteProduct.self)
    }

    func startAnalysis(productID: String, model: CloudModel, useOCR: Bool, reasoningEffort: ReasoningEffort, vlmBatchSize: Int, multiScaleEnabled: Bool) async throws -> RemoteAnalysis {
        let body = StartAnalysisRequest(
            model: model.rawValue,
            useOcr: useOCR,
            reasoningEffort: reasoningEffort.rawValue,
            vlmBatchSize: vlmBatchSize,
            multiScaleEnabled: multiScaleEnabled
        )
        return try await sendJSON(path: "products/\(productID)/analysis", method: "POST", body: body, response: RemoteAnalysis.self)
    }

    func analysis(id: String) async throws -> RemoteAnalysis {
        try await send(path: "analysis/\(id)", response: RemoteAnalysis.self)
    }

    func partsList(productID: String) async throws -> RemotePartsList {
        try await send(path: "products/\(productID)/parts-list", response: RemotePartsList.self)
    }

    func clearManualCache(productID: String) async throws {
        var request = URLRequest(url: APIConfiguration.baseURL.appending(path: "products/\(productID)/manual-cache"))
        request.httpMethod = "DELETE"
        let startedAt = Date()
        partScanLog("[API] -> DELETE \(request.url?.path ?? "unknown")")
        let (_, response) = try await session.data(for: request)
        partScanLog("[API] <- DELETE \(request.url?.path ?? "unknown") \((response as? HTTPURLResponse)?.statusCode ?? -1), \(partScanMilliseconds(since: startedAt))")
        guard (response as? HTTPURLResponse)?.statusCode ?? 500 < 300 else { throw PartScanAPIError.server("清理说明书缓存失败") }
    }

    private func send<T: Decodable>(path: String, response: T.Type) async throws -> T {
        try await decode(URLRequest(url: APIConfiguration.baseURL.appending(path: path)), as: T.self)
    }

    private func sendJSON<T: Decodable, Body: Encodable>(path: String, method: String, body: Body, response: T.Type) async throws -> T {
        var request = URLRequest(url: APIConfiguration.baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return try await decode(request, as: T.self)
    }

    private func sendMultipart<T: Decodable>(path: String, body: MultipartFormData, response: T.Type) async throws -> T {
        var request = URLRequest(url: APIConfiguration.baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(body.boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body.encodedData
        return try await decode(request, as: T.self)
    }

    private func decode<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let startedAt = Date()
        let method = request.httpMethod ?? "GET"
        let path = request.url?.path ?? "unknown"
        let isAnalysisPoll = method == "GET" && path.range(of: #"/analysis/[0-9a-f-]{36}$"#, options: .regularExpression) != nil
        let requestBytes = request.httpBody?.count ?? 0
        if !isAnalysisPoll { partScanLog("[API] -> \(method) \(path), body \(requestBytes / 1_024) KB") }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            partScanLog("[API] xx \(method) \(path), \(partScanMilliseconds(since: startedAt)): \(error.localizedDescription)")
            throw error
        }
        guard let http = response as? HTTPURLResponse else { throw PartScanAPIError.invalidResponse }
        if !isAnalysisPoll { partScanLog("[API] <- \(method) \(path), HTTP \(http.statusCode), response \(data.count / 1_024) KB, \(partScanMilliseconds(since: startedAt))") }
        guard 200..<300 ~= http.statusCode else {
            let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data).message) ?? "服务器请求失败（\(http.statusCode)）"
            throw PartScanAPIError.server(message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct APIErrorBody: Decodable { let message: String }

private final class MultipartFormData {
    let boundary = "PartScan-\(UUID().uuidString)"
    private(set) var data = Data()
    func addText(_ text: String, named name: String) {
        data.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(text)\r\n".data(using: .utf8)!)
    }
    func addFile(_ file: Data, named name: String, filename: String, mimeType: String) {
        data.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\nContent-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        data.append(file); data.append("\r\n".data(using: .utf8)!)
    }
    var encodedData: Data { data + "--\(boundary)--\r\n".data(using: .utf8)! }
}

/// Temporary local storage for captured manual pages. The workflow deletes it after successful upload.
final class ManualImageCache: @unchecked Sendable {
    static let shared = ManualImageCache()
    private let directory: URL
    private let lock = NSLock()
    private var capturedPages: [CapturedManualPage] = []
    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        directory = support.appendingPathComponent("PartScan/ManualCaptureCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    func storeJPEG(_ data: Data, candidates: [OCRHint], captureHint: ManualPageCaptureHint) {
        let url = directory.appendingPathComponent("page-\(UUID().uuidString).jpg")
        let startedAt = Date()
        guard (try? data.write(to: url, options: .atomic)) != nil else {
            partScanLog("[缓存] 说明书页面写入失败")
            return
        }
        lock.lock(); capturedPages.append(CapturedManualPage(url: url, candidates: candidates, captureHint: captureHint)); lock.unlock()
        partScanLog("[缓存] 页面已写入 \(data.count / 1_024) KB，\(partScanMilliseconds(since: startedAt))")
    }
    func pageURLs() -> [URL] { (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil))?.sorted { $0.lastPathComponent < $1.lastPathComponent } ?? [] }
    func pages() -> [CapturedManualPage] { lock.lock(); defer { lock.unlock() }; return capturedPages.filter { FileManager.default.fileExists(atPath: $0.url.path) } }
    func clear() {
        let startedAt = Date()
        lock.lock(); capturedPages = []; lock.unlock()
        try? FileManager.default.removeItem(at: directory)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        partScanLog("[缓存] 临时说明书缓存已清理，\(partScanMilliseconds(since: startedAt))")
    }
}

struct CapturedManualPage: Sendable { let url: URL; let candidates: [OCRHint]; let captureHint: ManualPageCaptureHint }

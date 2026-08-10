import SwiftUI
import PhotosUI

struct ProductSetupView: View {
    @EnvironmentObject private var store: PartsStore
    @State private var name = ""
    @State private var selectedCover: PhotosPickerItem?
    @State private var coverData: Data?

    var body: some View {
        let cover = coverData
        ZStack {
            LinearGradient(colors: [PremiumPalette.ink, Color(red: 0.10, green: 0.09, blue: 0.11)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("新建产品").font(.largeTitle.bold())
                    Text("先建立产品资料，再录入它的装配说明书。扫描完成后会在后台生成取件表。")
                        .foregroundStyle(PremiumPalette.mist)
                    GlassCard {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("产品名称").font(.headline)
                            TextField("例如：RG Hi-ν 高达", text: $name)
                                .textInputAutocapitalization(.words)
                                .padding(13).background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 14))
                            Text("模型封面（可选）").font(.headline).padding(.top, 4)
                            PhotosPicker(selection: $selectedCover, matching: .images) {
                                HStack(spacing: 14) {
                                    if let cover, let image = UIImage(data: cover) {
                                        Image(uiImage: image).resizable().scaledToFill().frame(width: 70, height: 70).clipShape(RoundedRectangle(cornerRadius: 14))
                                    } else {
                                        Image(systemName: "photo.on.rectangle.angled").font(.title2).foregroundStyle(PremiumPalette.champagne).frame(width: 70, height: 70).background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                                    }
                                    VStack(alignment: .leading, spacing: 4) { Text(cover == nil ? "选择产品封面" : "已添加产品封面").font(.subheadline.weight(.semibold)); Text("支持相册中的产品盒照或封面图").font(.caption).foregroundStyle(.secondary) }
                                    Spacer(); Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                }
                            }.buttonStyle(.plain)
                            HStack(alignment: .top, spacing: 7) {
                                Image(systemName: "lock.fill").font(.caption2).foregroundStyle(PremiumPalette.champagne)
                                Text("说明书图片仅在分析期间临时缓存，上传完成后会自动删除。")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(.leading, 2)
                        }
                    }
                    if let error = store.productCreationError { Text(error).font(.caption).foregroundStyle(.red) }
                    Button { Task { await store.createProduct(name: name.trimmingCharacters(in: .whitespacesAndNewlines), coverData: coverData) } } label: {
                        Group { if store.isCreatingProduct { ProgressView().tint(.black) } else { Label("创建产品并开始扫描", systemImage: "viewfinder") } }
                            .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 15)
                    }
                    .buttonStyle(.borderedProminent).tint(PremiumPalette.champagne).foregroundStyle(.black).clipShape(Capsule())
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isCreatingProduct)
                }.padding()
            }
        }
        .onChange(of: selectedCover) {
            Task { coverData = try? await selectedCover?.loadTransferable(type: Data.self) }
        }
        .onAppear {
            guard name.isEmpty, let draft = store.resumableProduct else { return }
            name = draft.name
            coverData = draft.coverData
        }
    }
}

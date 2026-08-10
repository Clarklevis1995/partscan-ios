import SwiftUI

struct PartsDetailView: View {
    @EnvironmentObject private var store: PartsStore
    @State private var project: ScanProject
    @State private var expanded: Set<UUID>

    init(project: ScanProject) {
        _project = State(initialValue: project)
        _expanded = State(initialValue: Set(project.sections.first.map { [$0.id] } ?? []))
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: [PremiumPalette.ink, Color(red: 0.10, green: 0.09, blue: 0.10)], startPoint: .topLeading, endPoint: .bottom).ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 15) {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(project.name).font(.title2.bold())
                            HStack {
                                Label("已识别 \(project.sections.count) 个部位", systemImage: "checkmark.seal.fill")
                                Spacer()
                                Text("\(project.totalParts) 件零件")
                            }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        }
                    }
                    if !project.uncertainItems.isEmpty {
                        GlassCard {
                            VStack(alignment: .leading, spacing: 8) {
                                Label("需要确认", systemImage: "exclamationmark.triangle.fill").font(.headline).foregroundStyle(PremiumPalette.champagne)
                                ForEach(project.uncertainItems, id: \.description) { item in
                                    Text(item.description).font(.subheadline)
                                    if let action = item.suggestedAction { Text(action).font(.caption).foregroundStyle(.secondary) }
                                }
                            }
                        }
                    }
                    ForEach($project.sections) { $section in
                        SectionDisclosure(section: $section, expanded: expanded.contains(section.id), toggle: {
                            withAnimation(.spring) {
                                if expanded.contains(section.id) { expanded.remove(section.id) }
                                else { expanded.insert(section.id) }
                            }
                        }, onChange: persist)
                    }
                    Button {} label: {
                        Label("导出取件表", systemImage: "square.and.arrow.up")
                            .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .clipShape(Capsule())
                    .padding(.top, 5)
                }
                .padding()
            }
        }
        .navigationTitle("取件表")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func persist() {
        store.saveEditedProject(project)
    }
}

private struct SectionDisclosure: View {
    @Binding var section: AssemblySection
    let expanded: Bool
    let toggle: () -> Void
    let onChange: () -> Void
    @State private var addingToPlateID: UUID?
    @State private var newNumber = ""
    @State private var newName = ""
    @State private var newQuantity = 1

    var body: some View {
        GlassCard {
            VStack(spacing: 0) {
                Button(action: toggle) {
                    HStack(spacing: 12) {
                        Image(systemName: section.symbol).font(.title3).frame(width: 39, height: 39)
                            .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
                            .foregroundStyle(PremiumPalette.champagne)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(section.name).font(.headline)
                            Text("\(section.plates.count) 块板件 · \(section.count) 个零件")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.down").rotationEffect(.degrees(expanded ? 180 : 0)).foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)

                if expanded {
                    Divider().padding(.vertical, 13)
                    ForEach($section.plates) { $plate in
                        VStack(spacing: 0) {
                            HStack {
                                Text("板件 \(plate.code)").font(.subheadline.bold())
                                Spacer()
                                Text("\(plate.parts.reduce(0) { $0 + $1.quantity }) 件")
                                    .font(.caption.weight(.semibold)).foregroundStyle(PremiumPalette.champagne)
                            }
                            ForEach($plate.parts) { $part in
                                EditablePartRow(part: $part, onDelete: {
                                    plate.parts.removeAll { $0.id == part.id }
                                    onChange()
                                }, onChange: onChange)
                            }
                            Button {
                                newNumber = ""
                                newName = ""
                                newQuantity = 1
                                addingToPlateID = plate.id
                            } label: {
                                Image(systemName: "plus")
                                    .font(.headline.weight(.semibold))
                                    .foregroundStyle(PremiumPalette.champagne)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("向板件 \(plate.code) 新增零件")
                        }
                        .padding(.top, 10)
                        if plate.id != section.plates.last?.id { Divider().padding(.top, 2) }
                    }
                }
            }
        }
        .sheet(isPresented: Binding(get: { addingToPlateID != nil }, set: { if !$0 { addingToPlateID = nil } })) {
            NavigationStack {
                Form {
                    TextField("零件编号", text: $newNumber)
                    TextField("零件说明（可选）", text: $newName)
                    Stepper("数量：\(newQuantity)", value: $newQuantity, in: 1...99)
                }
                .navigationTitle("新增零件")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("取消") { addingToPlateID = nil } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("添加") { addPart() }.disabled(newNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }

    private func addPart() {
        guard let plateID = addingToPlateID,
              let index = section.plates.firstIndex(where: { $0.id == plateID }) else { return }
        let number = newNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        section.plates[index].parts.append(Part(number: number, name: name.isEmpty ? "零件 \(number)" : name, quantity: newQuantity))
        addingToPlateID = nil
        onChange()
    }
}

private struct EditablePartRow: View {
    @Binding var part: Part
    let onDelete: () -> Void
    let onChange: () -> Void
    @State private var showingEditor = false
    @State private var draftNumber = ""
    @State private var draftName = ""
    @State private var draftQuantity = 1

    var body: some View {
        partContent
        .contentShape(Rectangle())
        .onLongPressGesture(minimumDuration: 0.45) {
            openEditor()
        }
        .accessibilityAction(named: "编辑零件") { openEditor() }
        .sheet(isPresented: $showingEditor) {
            NavigationStack {
                Form {
                    Section("零件信息") {
                        TextField("零件编号", text: $draftNumber)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                        TextField("零件说明", text: $draftName)
                        Stepper(value: $draftQuantity, in: 1...99) {
                            LabeledContent("数量", value: "×\(draftQuantity)")
                        }
                    }
                    Section {
                        Button("删除这个零件", systemImage: "trash", role: .destructive) {
                            showingEditor = false
                            onDelete()
                        }
                    }
                }
                .navigationTitle("编辑零件")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { showingEditor = false }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") { save() }
                            .disabled(draftNumber.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }

    private var partContent: some View {
        HStack {
            Text(part.number).font(.subheadline.monospacedDigit()).frame(width: 42, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(part.name).font(.subheadline).foregroundStyle(.secondary)
                if !part.sourcePages.isEmpty {
                    Text(part.sourcePages.map { "第\($0)页" }.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(Color.secondary)
                }
            }
            Spacer()
            Text("×\(part.quantity)").font(.subheadline.weight(.medium))
        }
        .padding(.vertical, 10)
    }

    private func save() {
        let number = draftNumber.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        part.number = number
        part.name = name.isEmpty ? "零件 \(number)" : name
        part.quantity = draftQuantity
        showingEditor = false
        onChange()
    }

    private func openEditor() {
        draftNumber = part.number
        draftName = part.name
        draftQuantity = part.quantity
        showingEditor = true
    }
}

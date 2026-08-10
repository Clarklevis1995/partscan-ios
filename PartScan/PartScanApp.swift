import SwiftUI

@main
struct PartScanApp: App {
    @StateObject private var store = PartsStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .tint(.cyan)
        }
    }
}

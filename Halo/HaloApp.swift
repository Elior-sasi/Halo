import SwiftUI
import WebKit

@main
struct HaloApp: App {
    var body: some Scene {
        WindowGroup {
            WebView()
                .ignoresSafeArea()
                .background(Color.black)
        }
    }
}

/// Hosts the Halo web UI (bundled in /web) and connects it to the native bridge.
struct WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let ucc = cfg.userContentController

        // Values the page saved earlier (nicknames, schedules...) are handed back before it loads.
        let saved = Store.all()
        let json = (try? JSONSerialization.data(withJSONObject: saved)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        ucc.addUserScript(WKUserScript(source: "window.__haloStore = \(json);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(Bridge(), contentWorld: .page, name: "halo")

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.isOpaque = false
        wv.backgroundColor = .black
        wv.scrollView.backgroundColor = .black
        wv.scrollView.contentInsetAdjustmentBehavior = .never
        wv.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { wv.isInspectable = true }

        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            wv.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Small key-value store for page settings, kept in UserDefaults.
enum Store {
    private static let key = "halo.store"
    static func all() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]
    }
    static func set(_ k: String, _ v: String) {
        var d = all()
        d[k] = v
        UserDefaults.standard.set(d, forKey: key)
    }
}

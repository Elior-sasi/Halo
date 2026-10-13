import Foundation
import WebKit

/// Receives requests from the page (window.webkit.messageHandlers.halo.postMessage) and answers with a JSON string.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            replyHandler(nil, "bad request")
            return
        }
        Task {
            do {
                let out = try await handle(action, body)
                await MainActor.run { replyHandler(out, nil) }
            } catch {
                let msg = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                await MainActor.run { replyHandler(nil, msg) }
            }
        }
    }

    private func handle(_ action: String, _ body: [String: Any]) async throws -> String {
        let router = RouterClient.shared
        switch action {
        case "hasPassword":
            return #"{"has":\#(Keychain.load() != nil)}"#

        case "login":
            let pw = body["password"] as? String ?? ""
            try await router.login(password: pw)
            Keychain.save(pw)
            return #"{"ok":true}"#

        case "logout":
            Keychain.delete()
            await router.reset()
            return #"{"ok":true}"#

        case "api":
            let path = body["path"] as? String ?? ""
            let method = body["method"] as? String ?? "GET"
            var params: [String: String] = [:]
            (body["params"] as? [String: Any] ?? [:]).forEach { params[$0.key] = "\($0.value)" }
            return try await router.call(path: path, params: params, method: method)

        case "speed":
            let phase = body["phase"] as? String ?? "down"
            let v = try await SpeedTest.run(phase)
            return phase == "ping" ? #"{"ms":\#(v)}"# : #"{"mbps":\#(v)}"#

        case "kvSet":
            if let k = body["key"] as? String, let v = body["value"] as? String { Store.set(k, v) }
            return #"{"ok":true}"#

        default:
            throw RouterError.bad("unknown action \(action)")
        }
    }
}

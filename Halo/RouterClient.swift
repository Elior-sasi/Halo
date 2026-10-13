import Foundation
import CryptoKit
import Security

enum RouterError: LocalizedError {
    case offline, badPassword, noPassword, timeout
    case http(Int)
    case bad(String)

    var errorDescription: String? {
        switch self {
        case .offline: return "offline"
        case .badPassword: return "badPassword"
        case .noPassword: return "noPassword"
        case .timeout: return "timeout"
        case .http(let c): return "http \(c)"
        case .bad(let m): return m
        }
    }
}

/// Talks to the Xiaomi router's local web API (the same one its admin page at 192.168.31.1 uses).
actor RouterClient {
    static let shared = RouterClient()

    private let base = "http://192.168.31.1/cgi-bin/luci"
    /// Public constant used by Xiaomi's admin page when hashing the password.
    private let key = "a2ffa5c9be07488bbb04a3a47d3c5f6a"
    private var token: String?
    private var useSHA256: Bool?

    private let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 8
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    func reset() { token = nil }

    // MARK: login

    func login(password: String) async throws {
        let sha = await encryptMode()
        let nonce = "0_e2:00:00:00:00:01_\(Int(Date().timeIntervalSince1970))_\(Int.random(in: 1000..<10000))"
        let hashed = Self.hash(nonce + Self.hash(password + key, sha), sha)

        var req = URLRequest(url: URL(string: base + "/api/xqsystem/login")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Self.form(["username": "admin", "password": hashed, "logtype": "2", "nonce": nonce]).data(using: .utf8)

        let data = try await fetch(req)
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RouterError.bad("unexpected login reply")
        }
        if let t = j["token"] as? String, !t.isEmpty {
            token = t
            return
        }
        throw RouterError.badPassword
    }

    /// newEncryptMode = 1 means SHA-256 (newer firmware), otherwise SHA-1.
    private func encryptMode() async -> Bool {
        if let m = useSHA256 { return m }
        if let d = try? await fetch(URLRequest(url: URL(string: base + "/api/xqsystem/init_info")!)),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            let m = "\(j["newEncryptMode"] ?? 0)" == "1"
            useSHA256 = m
            return m
        }
        return true
    }

    // MARK: API calls

    func call(path: String, params: [String: String], method: String) async throws -> String {
        try await ensureToken()
        do {
            let out = try await raw(path, params, method)
            if Self.isAuthFailure(out) {
                token = nil
                try await ensureToken()
                return try await raw(path, params, method)
            }
            return out
        } catch RouterError.http(let c) where c == 401 || c == 403 {
            token = nil
            try await ensureToken()
            return try await raw(path, params, method)
        }
    }

    private func ensureToken() async throws {
        if token != nil { return }
        guard let pw = Keychain.load() else { throw RouterError.noPassword }
        try await login(password: pw)
    }

    private func raw(_ path: String, _ params: [String: String], _ method: String) async throws -> String {
        guard let t = token else { throw RouterError.noPassword }
        let clean = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard var comps = URLComponents(string: "\(base)/;stok=\(t)/api/\(clean)") else { throw RouterError.bad("bad path") }
        var req: URLRequest
        if method.uppercased() == "POST" {
            req = URLRequest(url: comps.url!)
            req.httpMethod = "POST"
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            req.httpBody = Self.form(params).data(using: .utf8)
        } else {
            if !params.isEmpty { comps.queryItems = params.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
            req = URLRequest(url: comps.url!)
        }
        let data = try await fetch(req)
        let text = String(data: data, encoding: .utf8) ?? ""
        // Always hand the page valid JSON.
        if (try? JSONSerialization.jsonObject(with: data)) == nil {
            let snippet = String(text.prefix(200)).replacingOccurrences(of: "\"", with: "'")
            return #"{"code":-1,"msg":"not json: \#(snippet)"}"#
        }
        return text
    }

    private func fetch(_ req: URLRequest) async throws -> Data {
        do {
            let (d, r) = try await session.data(for: req)
            if let h = r as? HTTPURLResponse, h.statusCode >= 400 { throw RouterError.http(h.statusCode) }
            return d
        } catch let e as URLError {
            throw e.code == .timedOut ? RouterError.timeout : RouterError.offline
        }
    }

    // MARK: helpers

    private static func isAuthFailure(_ s: String) -> Bool {
        guard let d = s.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return false }
        return "\(j["code"] ?? "")" == "401"
    }

    static func hash(_ s: String, _ sha256: Bool) -> String {
        let data = Data(s.utf8)
        if sha256 { return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
        return Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func form(_ p: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return p.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
    }
}

/// Router admin password, kept only in this phone's Keychain.
enum Keychain {
    private static let base: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.elior.halo.router",
        kSecAttrAccount as String: "admin"
    ]

    static func save(_ v: String) {
        SecItemDelete(base as CFDictionary)
        var q = base
        q[kSecValueData as String] = Data(v.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }

    static func load() -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func delete() { SecItemDelete(base as CFDictionary) }
}

/// Measures the phone's own internet speed through the Wi-Fi, against Cloudflare's speed test endpoints.
enum SpeedTest {
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.urlCache = nil
        return URLSession(configuration: c)
    }()

    static func run(_ phase: String) async throws -> Double {
        switch phase {
        case "ping":
            var best = Double.infinity
            for _ in 0..<4 {
                let t = Date()
                _ = try? await session.data(from: URL(string: "https://speed.cloudflare.com/__down?bytes=0")!)
                best = min(best, Date().timeIntervalSince(t) * 1000)
            }
            guard best.isFinite else { throw RouterError.offline }
            return (best * 10).rounded() / 10

        case "up":
            let chunk = Data(count: 8_000_000)
            let t = Date()
            let total = try await withThrowingTaskGroup(of: Int.self) { g -> Int in
                for _ in 0..<3 {
                    g.addTask {
                        var r = URLRequest(url: URL(string: "https://speed.cloudflare.com/__up")!)
                        r.httpMethod = "POST"
                        _ = try await session.upload(for: r, from: chunk)
                        return chunk.count
                    }
                }
                return try await g.reduce(0, +)
            }
            return mbps(total, Date().timeIntervalSince(t))

        default:
            let t = Date()
            let total = try await withThrowingTaskGroup(of: Int.self) { g -> Int in
                for _ in 0..<4 {
                    g.addTask {
                        let (d, _) = try await session.data(from: URL(string: "https://speed.cloudflare.com/__down?bytes=25000000")!)
                        return d.count
                    }
                }
                return try await g.reduce(0, +)
            }
            return mbps(total, Date().timeIntervalSince(t))
        }
    }

    private static func mbps(_ bytes: Int, _ secs: TimeInterval) -> Double {
        guard secs > 0 else { return 0 }
        return (Double(bytes) * 8 / secs / 1_000_000 * 10).rounded() / 10
    }
}

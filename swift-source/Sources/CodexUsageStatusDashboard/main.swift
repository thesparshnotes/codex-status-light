import AppKit
import Foundation
import SwiftUI
import UserNotifications

private let localTimeZone = TimeZone.current

struct UsageSnapshot {
    let fetchedAt: Date
    let providers: [UsageProviderViewData]
    let strategy: UsageStrategyViewData?

    var codex: UsageProviderViewData? {
        provider("codex")
    }

    var claude: UsageProviderViewData? {
        provider("claude")
    }

    private func provider(_ key: String) -> UsageProviderViewData? {
        providers.first { $0.key == key }
    }
}

struct UsageWindowViewData {
    let key: String
    let label: String
    let usedPercent: Double?
    let resetAt: Date?
    let projection: UsageProjectionViewData?

    var displayPercent: String {
        guard let usedPercent else { return "Unavailable" }
        return "\(formatPercent(usedPercent))%"
    }

    var progressValue: Double {
        guard let usedPercent else { return 0 }
        return min(max(usedPercent / 100.0, 0), 1)
    }
}

struct UsageProviderViewData: Identifiable {
    let id: String
    let key: String
    let name: String
    let ok: Bool?
    let error: String?
    let fetchedAt: Date?
    let plan: String?
    let windows: [UsageWindowViewData]
    let resetCreditsAvailable: Int?
    let resetCredits: [ResetCreditViewData]
    let projection: UsageProjectionViewData?
    let extraUsageEnabled: Bool?

    var isAvailable: Bool {
        ok != false && !windows.isEmpty
    }

    func window(named key: String) -> UsageWindowViewData? {
        windows.first { $0.key == key }
    }

    var primaryWindow: UsageWindowViewData? {
        window(named: "session") ?? windows.first
    }

    var weeklyWindow: UsageWindowViewData? {
        window(named: "weekly") ?? windows.first { $0.key.hasPrefix("weekly") }
    }
}

struct UsageProjectionViewData {
    let windowKey: String
    let status: String
    let summary: String

    var tint: Color {
        switch status {
        case "safe":
            return .green
        case "warning":
            return .orange
        case "critical":
            return .red
        default:
            return .secondary
        }
    }
}

struct UsageStrategyViewData {
    let advice: String
    let urgency: String?
    let secondary: UsageStrategySecondaryViewData?

    var tint: Color {
        urgency == "act" ? .orange : .secondary
    }
}

struct UsageStrategySecondaryViewData {
    let state: String
    let advice: String
    let urgency: String?

    var tint: Color {
        urgency == "act" ? .orange : .secondary
    }
}

struct ResetCreditViewData: Identifiable {
    let id: String
    let title: String
    let status: String
    let grantedAt: Date?
    let expiresAt: Date?
}

enum StatusLightState: String, Codable {
    case idle
    case running
    case waiting
    case done
    case error
    case stale
    case offline

    var title: String {
        switch self {
        case .idle:
            return "Idle"
        case .running:
            return "Running"
        case .waiting:
            return "Needs attention"
        case .done:
            return "Done"
        case .error:
            return "Error"
        case .stale:
            return "Stale"
        case .offline:
            return "Source offline"
        }
    }

    var menuTitle: String {
        switch self {
        case .idle, .done:
            return "Ready"
        case .running:
            return "Working"
        case .waiting:
            return "Attention"
        case .error:
            return "Error"
        case .stale:
            return "Ready"
        case .offline:
            return "Offline"
        }
    }

    var color: Color {
        switch self {
        case .waiting, .error:
            return .red
        case .running:
            return .yellow
        case .idle, .done:
            return .green
        case .stale, .offline:
            return .gray
        }
    }

    var nsColor: NSColor {
        switch self {
        case .waiting, .error:
            return .systemRed
        case .running:
            return .systemYellow
        case .idle, .done:
            return .systemGreen
        case .stale, .offline:
            return .systemGray
        }
    }
}

struct StatusLightSnapshot {
    let state: StatusLightState
    let sessions: [StatusLightSession]
    let updatedAt: Date?
    let fileURL: URL
    let source: String
    let daemon: DaemonViewData?
    let incidents: [String: ProviderIncidentViewData]

    var waitingCount: Int { count(.waiting) + count(.error) }
    var runningCount: Int { count(.running) }
    var doneCount: Int { count(.done) + count(.idle) }
    var staleCount: Int { count(.stale) }

    var summary: String {
        if sessions.isEmpty {
            return "No tracked sessions reporting"
        }
        var parts = [
            "\(waitingCount) waiting",
            "\(runningCount) running",
            "\(doneCount) done"
        ]
        if staleCount > 0 {
            parts.append("\(staleCount) stale")
        }
        return parts.joined(separator: " · ")
    }

    static func empty(fileURL: URL) -> StatusLightSnapshot {
        StatusLightSnapshot(state: .offline, sessions: [], updatedAt: nil, fileURL: fileURL, source: "Source offline", daemon: nil, incidents: [:])
    }

    func incident(for providerKey: String) -> ProviderIncidentViewData? {
        incidents[providerKey]
    }

    private func count(_ state: StatusLightState) -> Int {
        sessions.filter { $0.state == state }.count
    }
}

struct StatusLightSession: Identifiable {
    let id: String
    let title: String
    let state: StatusLightState
    let source: String
    let updatedAt: Date?
}

struct DaemonViewData {
    let version: String?
    let pid: Int?
    let startedAt: Date?
    let sourceMtime: Date?
    let staleCode: Bool
}

struct ProviderIncidentViewData {
    let providerKey: String
    let updatedAt: Date?
    let ok: Bool?
    let indicator: String?
    let description: String?
    let statusURL: URL?
    let incidents: [ProviderIncidentItemViewData]

    var isActive: Bool {
        guard let indicator = indicator?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !indicator.isEmpty
        else {
            return false
        }
        return indicator != "none"
    }

    var isCritical: Bool {
        indicator?.lowercased() == "critical"
    }

    var providerDisplayName: String {
        switch providerKey {
        case "codex":
            return "OpenAI"
        case "claude":
            return "Anthropic"
        default:
            return providerKey
                .split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }
}

struct ProviderIncidentItemViewData: Identifiable {
    let id: String
    let name: String
    let impact: String?
    let url: URL?
    let startedAt: Date?
}

private struct StatusLightFile: Decodable {
    let sessions: [StatusLightFileSession]
    let updatedAt: String?
    let generatedAt: String?
    let summary: StatusLightFileSummary?
    let daemon: DaemonResponse?
    let incidents: IncidentsResponse?

    enum CodingKeys: String, CodingKey {
        case sessions
        case updatedAt
        case generatedAt
        case summary
        case daemon
        case incidents
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try container.decodeIfPresent([StatusLightFileSession].self, forKey: .sessions) ?? []
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        generatedAt = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        summary = try container.decodeIfPresent(StatusLightFileSummary.self, forKey: .summary)
        daemon = try container.decodeIfPresent(DaemonResponse.self, forKey: .daemon)
        incidents = try container.decodeIfPresent(IncidentsResponse.self, forKey: .incidents)
    }
}

private struct StatusLightFileSummary: Decodable {
    let status: StatusLightState
}

private struct StatusLightFileSession: Decodable {
    let id: String
    let title: String?
    let status: StatusLightState
    let source: String?
    let updatedAt: String?
}

private struct DaemonResponse: Decodable {
    let version: String?
    let pid: Int?
    let startedAt: String?
    let sourceMtime: String?
    let staleCode: Bool?
}

private struct IncidentsResponse: Decodable {
    let updatedAt: String?
    let providers: [String: ProviderIncidentResponse]

    enum CodingKeys: String, CodingKey {
        case updatedAt
        case providers
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        providers = try container.decodeIfPresent([String: ProviderIncidentResponse].self, forKey: .providers) ?? [:]
    }
}

private struct ProviderIncidentResponse: Decodable {
    let ok: Bool?
    let indicator: String?
    let description: String?
    let statusUrl: String?
    let incidents: [ProviderIncidentItemResponse]

    enum CodingKeys: String, CodingKey {
        case ok
        case indicator
        case description
        case statusUrl
        case incidents
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
        indicator = try container.decodeIfPresent(String.self, forKey: .indicator)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        statusUrl = try container.decodeIfPresent(String.self, forKey: .statusUrl)
        incidents = try container.decodeIfPresent([ProviderIncidentItemResponse].self, forKey: .incidents) ?? []
    }
}

private struct ProviderIncidentItemResponse: Decodable {
    let name: String?
    let impact: String?
    let url: String?
    let startedAt: String?
}

@MainActor
final class StatusLightViewModel: ObservableObject {
    private static let refreshInterval: TimeInterval = 1

    @Published var snapshot: StatusLightSnapshot
    @Published var errorMessage: String?

    var onStatusChanged: ((StatusLightSnapshot) -> Void)?

    private let fileURL: URL
    private var refreshTimer: Timer?

    init(fileURL: URL = StatusLightClient.defaultStatusFileURL()) {
        self.fileURL = fileURL
        snapshot = .empty(fileURL: fileURL)
    }

    deinit {
        refreshTimer?.invalidate()
    }

    func startAutoRefresh() {
        refreshTimer?.invalidate()
        refresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: Self.refreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    func refresh() {
        Task {
            do {
                let latest = try await StatusLightClient.readSnapshot(from: fileURL)
                snapshot = latest
                errorMessage = nil
                onStatusChanged?(latest)
            } catch {
                snapshot = .empty(fileURL: fileURL)
                errorMessage = error.localizedDescription
                onStatusChanged?(snapshot)
            }
        }
    }
}

enum StatusLightClient {
    static func defaultStatusFileURL() -> URL {
        if let override = ProcessInfo.processInfo.environment["CODEX_LIGHT_FILE"], !override.isEmpty {
            return URL(fileURLWithPath: override).standardizedFileURL
        }

        let fileManager = FileManager.default
        let currentDirectory = URL(fileURLWithPath: fileManager.currentDirectoryPath)
        let homeStatusFile = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex-light")
            .appendingPathComponent("status.json")
        let executableRoot = Bundle.main.executableURL?
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()

        let candidates = [
            homeStatusFile,
            currentDirectory.appendingPathComponent("../codex-status-light/data/status.json"),
            currentDirectory.appendingPathComponent("data/status.json"),
            executableRoot?.appendingPathComponent("../codex-status-light/data/status.json"),
            executableRoot?.appendingPathComponent("data/status.json")
        ].compactMap { $0?.standardizedFileURL }

        return candidates.first { fileManager.fileExists(atPath: $0.path) }
            ?? homeStatusFile.standardizedFileURL
    }

    static func readSnapshot(from fileURL: URL) async throws -> StatusLightSnapshot {
        do {
            return try await readSnapshotFromServer(fileURL: fileURL)
        } catch {
            return try readSnapshotFromFile(fileURL, offline: true)
        }
    }

    private static func readSnapshotFromServer(fileURL: URL) async throws -> StatusLightSnapshot {
        let url = URL(string: ProcessInfo.processInfo.environment["CODEX_LIGHT_URL"] ?? "http://127.0.0.1:4173/api/status")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 0.7
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw DashboardError.requestFailed(http.statusCode)
        }

        return try decodeSnapshot(data: data, fileURL: fileURL, source: url.absoluteString)
    }

    private static func readSnapshotFromFile(_ fileURL: URL, offline: Bool) throws -> StatusLightSnapshot {
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return .empty(fileURL: fileURL)
        }

        let data = try Data(contentsOf: fileURL)
        return try decodeSnapshot(
            data: data,
            fileURL: fileURL,
            source: offline ? "Source offline · \(fileURL.path)" : fileURL.path,
            forceOffline: offline
        )
    }

    private static func decodeSnapshot(
        data: Data,
        fileURL: URL,
        source: String,
        forceOffline: Bool = false
    ) throws -> StatusLightSnapshot {
        let file = try JSONDecoder().decode(StatusLightFile.self, from: data)
        let sessions = file.sessions.map {
            StatusLightSession(
                id: $0.id,
                title: $0.title ?? $0.id,
                state: $0.status,
                source: $0.source ?? "unknown",
                updatedAt: parseDate($0.updatedAt)
            )
        }
        let generatedAt = parseDate(file.generatedAt) ?? Date()
        let incidentUpdatedAt = parseDate(file.incidents?.updatedAt)
        let incidents = file.incidents?.providers.mapValues { provider in
            ProviderIncidentViewData(
                providerKey: "",
                updatedAt: incidentUpdatedAt,
                ok: provider.ok,
                indicator: provider.indicator,
                description: provider.description,
                statusURL: provider.statusUrl.flatMap(URL.init(string:)),
                incidents: provider.incidents.enumerated().compactMap { index, incident in
                    guard let name = incident.name, !name.isEmpty else { return nil }
                    return ProviderIncidentItemViewData(
                        id: "\(index)-\(name)",
                        name: name,
                        impact: incident.impact,
                        url: incident.url.flatMap(URL.init(string:)),
                        startedAt: parseDate(incident.startedAt)
                    )
                }
            )
        } ?? [:]
        let incidentsWithProviderKeys = Dictionary(uniqueKeysWithValues: incidents.map { key, incident in
            (
                key,
                ProviderIncidentViewData(
                    providerKey: key,
                    updatedAt: incident.updatedAt,
                    ok: incident.ok,
                    indicator: incident.indicator,
                    description: incident.description,
                    statusURL: incident.statusURL,
                    incidents: incident.incidents
                )
            )
        })

        return StatusLightSnapshot(
            state: forceOffline ? .offline : (file.summary?.status ?? fallbackState(for: sessions, now: generatedAt)),
            sessions: sessions,
            updatedAt: parseDate(file.updatedAt),
            fileURL: fileURL,
            source: source,
            daemon: file.daemon.map {
                DaemonViewData(
                    version: $0.version,
                    pid: $0.pid,
                    startedAt: parseDate($0.startedAt),
                    sourceMtime: parseDate($0.sourceMtime),
                    staleCode: $0.staleCode ?? false
                )
            },
            incidents: forceOffline ? [:] : incidentsWithProviderKeys
        )
    }

    private static func fallbackState(for sessions: [StatusLightSession], now: Date) -> StatusLightState {
        let effectiveSessions = sessions.map { session -> StatusLightSession in
            guard (session.state == .running || session.state == .waiting),
                  let updatedAt = session.updatedAt,
                  now.timeIntervalSince(updatedAt) > 120
            else {
                return session
            }
            return StatusLightSession(
                id: session.id,
                title: session.title,
                state: .idle,
                source: session.source,
                updatedAt: session.updatedAt
            )
        }

        if effectiveSessions.contains(where: { $0.state == .waiting || $0.state == .error }) {
            return .waiting
        }
        if effectiveSessions.contains(where: { $0.state == .running }) {
            return .running
        }
        if effectiveSessions.contains(where: { $0.state == .done || $0.state == .idle }) {
            return .done
        }
        return .idle
    }

    private static func parseDate(_ rawValue: String?) -> Date? {
        guard let rawValue else { return nil }

        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: rawValue) {
            return date
        }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: rawValue)
    }
}

@MainActor
final class DashboardViewModel: ObservableObject {
    private static let autoRefreshInterval: TimeInterval = 5 * 60

    @Published var snapshot: UsageSnapshot?
    @Published var isLoading = false
    @Published var errorMessage: String?

    var onSnapshotChanged: ((UsageSnapshot?) -> Void)?

    private let client = CodexUsageClient()
    private var autoRefreshTimer: Timer?

    deinit {
        autoRefreshTimer?.invalidate()
    }

    func startAutoRefresh() {
        autoRefreshTimer?.invalidate()
        autoRefreshTimer = Timer.scheduledTimer(withTimeInterval: Self.autoRefreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.refresh()
            }
        }
    }

    func refresh() {
        guard !isLoading else { return }

        isLoading = true
        errorMessage = nil

        Task {
            do {
                let latest = try await client.fetchSnapshot()
                snapshot = latest
                onSnapshotChanged?(latest)
            } catch {
                errorMessage = error.localizedDescription
                onSnapshotChanged?(snapshot)
            }
            isLoading = false
        }
    }
}

final class CodexUsageClient {
    private let usageURL = URL(string: ProcessInfo.processInfo.environment["CODEX_USAGE_URL"] ?? "http://127.0.0.1:4173/api/usage")!
    private let decoder: JSONDecoder

    init() {
        decoder = JSONDecoder()
    }

    func fetchSnapshot() async throws -> UsageSnapshot {
        var request = URLRequest(url: usageURL)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("CodexUsageDashboard/0.1", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            if http.statusCode == 404 {
                throw DashboardError.daemonNeedsUpdate
            }
            if !(200..<300).contains(http.statusCode) {
                throw DashboardError.requestFailed(http.statusCode)
            }
        }

        let usageResponse = try decoder.decode(UsageDaemonResponse.self, from: data)
        let providers = usageResponse.providers
            .map { key, provider in Self.providerViewData(key: key, provider: provider) }
            .sorted { lhs, rhs in
                let order = ["codex": 0, "claude": 1]
                return (order[lhs.key] ?? 100, lhs.name) < (order[rhs.key] ?? 100, rhs.name)
            }

        return UsageSnapshot(
            fetchedAt: Self.parseDate(usageResponse.updatedAt) ?? Date(),
            providers: providers,
            strategy: usageResponse.strategy.flatMap { strategy in
                guard let advice = Self.nonEmpty(strategy.advice) else { return nil }
                let secondary = strategy.secondary.flatMap { secondary -> UsageStrategySecondaryViewData? in
                    guard let state = Self.nonEmpty(secondary.state),
                          let advice = Self.nonEmpty(secondary.advice)
                    else {
                        return nil
                    }
                    return UsageStrategySecondaryViewData(
                        state: state,
                        advice: advice,
                        urgency: secondary.urgency
                    )
                }
                return UsageStrategyViewData(advice: advice, urgency: strategy.urgency, secondary: secondary)
            }
        )
    }

    private static func providerViewData(key: String, provider: UsageProviderResponse) -> UsageProviderViewData {
        let providerProjection = projectionViewData(provider.projection, defaultWindowKey: "weekly")
        let windows = provider.windows.map {
            let key = $0.key ?? UUID().uuidString
            let windowProjection = projectionViewData($0.projection, defaultWindowKey: key)
            let effectiveProjection: UsageProjectionViewData?
            if $0.hasProjectionKey {
                effectiveProjection = windowProjection
            } else if key == "weekly" {
                effectiveProjection = providerProjection
            } else {
                effectiveProjection = nil
            }

            return UsageWindowViewData(
                key: key,
                label: $0.label ?? "Usage",
                usedPercent: $0.usedPercent,
                resetAt: parseDate($0.resetsAt),
                projection: effectiveProjection
            )
        }

        return UsageProviderViewData(
            id: key,
            key: key,
            name: providerName(for: key),
            ok: provider.ok,
            error: provider.error,
            fetchedAt: parseDate(provider.fetchedAt),
            plan: provider.plan,
            windows: windows,
            resetCreditsAvailable: provider.resetCredits?.available,
            resetCredits: provider.resetCredits?.credits.enumerated().map { index, credit in
                ResetCreditViewData(
                    id: "\(index)-\(credit.title)-\(credit.status)",
                    title: credit.title,
                    status: credit.status,
                    grantedAt: credit.grantedAt,
                    expiresAt: credit.expiresAt
                )
            } ?? [],
            projection: providerProjection,
            extraUsageEnabled: provider.extraUsage?.isEnabled
        )
    }

    private static func projectionViewData(
        _ projection: UsageProjectionResponse?,
        defaultWindowKey: String
    ) -> UsageProjectionViewData? {
        guard let projection, let summary = nonEmpty(projection.summary) else { return nil }
        return UsageProjectionViewData(
            windowKey: projection.windowKey ?? defaultWindowKey,
            status: projection.status ?? "collecting",
            summary: summary
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func providerName(for key: String) -> String {
        switch key {
        case "codex":
            return "Codex"
        case "claude":
            return "Claude"
        default:
            return key
                .split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    private static func parseDate(_ rawValue: String?) -> Date? {
        guard let rawValue else { return nil }

        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: rawValue) {
            return date
        }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: rawValue)
    }
}

final class WeeklyLimitNotifier: NSObject, UNUserNotificationCenterDelegate {
    private enum Threshold: String {
        case warning
        case critical
    }

    private let warningThreshold = 80
    private let criticalThreshold = 95
    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard

    override init() {
        super.init()
        center.delegate = self
    }

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func evaluate(_ snapshot: UsageSnapshot) {
        guard let weekly = snapshot.codex?.weeklyWindow, let usedPercent = weekly.usedPercent else {
            return
        }

        let threshold: Threshold
        if usedPercent >= Double(criticalThreshold) {
            threshold = .critical
        } else if usedPercent >= Double(warningThreshold) {
            threshold = .warning
        } else {
            return
        }

        let resetKey = weekly.resetAt.map { String(Int($0.timeIntervalSince1970)) } ?? "unknown-reset"
        let sentKey = "weeklyLimitNotification.\(threshold.rawValue).\(resetKey)"
        guard !defaults.bool(forKey: sentKey) else {
            return
        }

        let identifier = "codex-weekly-limit-\(threshold.rawValue)-\(resetKey)"
        let roundedPercent = Int(usedPercent.rounded())
        let content = UNMutableNotificationContent()
        content.title = title(for: threshold, usedPercent: roundedPercent)
        content.body = body(for: threshold, usedPercent: usedPercent, weekly: weekly, snapshot: snapshot)
        content.sound = .default

        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { [defaults] error in
            if error == nil {
                defaults.set(true, forKey: sentKey)
            }
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    private func title(for threshold: Threshold, usedPercent: Int) -> String {
        switch threshold {
        case .warning:
            return "Codex weekly usage is at \(usedPercent)%"
        case .critical:
            return "Codex weekly limit is almost used"
        }
    }

    private func body(
        for threshold: Threshold,
        usedPercent: Double,
        weekly: UsageWindowViewData,
        snapshot: UsageSnapshot
    ) -> String {
        let remainingPercent = max(0, 100 - Int(usedPercent.rounded()))
        let resetText = weekly.resetAt.map { formatLocal($0) } ?? "the next weekly reset"
        let creditCount = snapshot.codex?.resetCreditsAvailable ?? 0
        let resetCreditText = resetCreditSummary(creditCount)

        switch threshold {
        case .warning:
            return "You have about \(remainingPercent)% weekly usage left. \(resetCreditText) Weekly usage resets \(resetText)."
        case .critical:
            return "Only about \(remainingPercent)% weekly usage remains. \(resetCreditText) Weekly usage resets \(resetText)."
        }
    }

    private func resetCreditSummary(_ count: Int) -> String {
        if count == 1 {
            return "You also have 1 reset credit available."
        }

        if count > 1 {
            return "You also have \(count) reset credits available."
        }

        return "No reset credits are available."
    }
}

enum DashboardError: LocalizedError {
    case daemonNeedsUpdate
    case requestFailed(Int)

    var errorDescription: String? {
        switch self {
        case .daemonNeedsUpdate:
            return "Daemon needs update — restart it with the new code."
        case .requestFailed(let statusCode):
            return "The usage endpoint returned HTTP \(statusCode)."
        }
    }
}

struct UsageDaemonResponse: Decodable {
    let updatedAt: String?
    let providers: [String: UsageProviderResponse]
    let strategy: UsageStrategyResponse?

    enum CodingKeys: String, CodingKey {
        case updatedAt
        case providers
        case strategy
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        providers = try container.decodeIfPresent([String: UsageProviderResponse].self, forKey: .providers) ?? [:]
        strategy = try container.decodeIfPresent(UsageStrategyResponse.self, forKey: .strategy)
    }
}

struct UsageStrategyResponse: Decodable {
    let state: String?
    let urgency: String?
    let advice: String?
    let source: String?
    let generatedAt: String?
    let secondary: UsageStrategySecondaryResponse?

    enum CodingKeys: String, CodingKey {
        case state
        case urgency
        case advice
        case source
        case generatedAt
        case secondary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decodeIfPresent(String.self, forKey: .state)
        urgency = try container.decodeIfPresent(String.self, forKey: .urgency)
        advice = try container.decodeIfPresent(String.self, forKey: .advice)
        source = try container.decodeIfPresent(String.self, forKey: .source)
        generatedAt = try container.decodeIfPresent(String.self, forKey: .generatedAt)
        secondary = try container.decodeIfPresent(UsageStrategySecondaryResponse.self, forKey: .secondary)
    }
}

struct UsageStrategySecondaryResponse: Decodable {
    let state: String?
    let urgency: String?
    let advice: String?
    let source: String?

    enum CodingKeys: String, CodingKey {
        case state
        case urgency
        case advice
        case source
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        state = try container.decodeIfPresent(String.self, forKey: .state)
        urgency = try container.decodeIfPresent(String.self, forKey: .urgency)
        advice = try container.decodeIfPresent(String.self, forKey: .advice)
        source = try container.decodeIfPresent(String.self, forKey: .source)
    }
}

struct UsageProviderResponse: Decodable {
    let ok: Bool?
    let error: String?
    let fetchedAt: String?
    let plan: String?
    let windows: [UsageWindowResponse]
    let resetCredits: ResetCreditsSummary?
    let projection: UsageProjectionResponse?
    let extraUsage: ExtraUsageSummary?

    enum CodingKeys: String, CodingKey {
        case ok
        case error
        case fetchedAt
        case plan
        case windows
        case resetCredits
        case projection
        case extraUsage
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
        error = try container.decodeIfPresent(String.self, forKey: .error)
        fetchedAt = try container.decodeIfPresent(String.self, forKey: .fetchedAt)
        plan = try container.decodeIfPresent(String.self, forKey: .plan)
        windows = try container.decodeIfPresent([UsageWindowResponse].self, forKey: .windows) ?? []
        resetCredits = try container.decodeIfPresent(ResetCreditsSummary.self, forKey: .resetCredits)
        projection = try container.decodeIfPresent(UsageProjectionResponse.self, forKey: .projection)
        extraUsage = try container.decodeIfPresent(ExtraUsageSummary.self, forKey: .extraUsage)
    }
}

struct UsageWindowResponse: Decodable {
    let key: String?
    let label: String?
    let usedPercent: Double?
    let resetsAt: String?
    let projection: UsageProjectionResponse?
    let hasProjectionKey: Bool

    enum CodingKeys: String, CodingKey {
        case key
        case label
        case usedPercent
        case resetsAt
        case projection
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decodeIfPresent(String.self, forKey: .key)
        label = try container.decodeIfPresent(String.self, forKey: .label)
        usedPercent = try container.decodeIfPresent(Double.self, forKey: .usedPercent)
        resetsAt = try container.decodeIfPresent(String.self, forKey: .resetsAt)
        projection = try container.decodeIfPresent(UsageProjectionResponse.self, forKey: .projection)
        hasProjectionKey = container.contains(.projection)
    }
}

struct ResetCreditsSummary: Decodable {
    let available: Int?
    let credits: [ResetCreditSummary]
    let advice: String?
    let adviceKind: String?

    enum CodingKeys: String, CodingKey {
        case available
        case credits
        case advice
        case adviceKind
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        available = try container.decodeIfPresent(Int.self, forKey: .available)
        credits = try container.decodeIfPresent([ResetCreditSummary].self, forKey: .credits) ?? []
        advice = try container.decodeIfPresent(String.self, forKey: .advice)
        adviceKind = try container.decodeIfPresent(String.self, forKey: .adviceKind)
    }
}

struct UsageProjectionResponse: Decodable {
    let windowKey: String?
    let status: String?
    let weekPace: UsageProjectionPaceResponse?
    let recentPace: UsageProjectionPaceResponse?
    let summary: String?

    enum CodingKeys: String, CodingKey {
        case windowKey
        case status
        case weekPace
        case recentPace
        case summary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        windowKey = try container.decodeIfPresent(String.self, forKey: .windowKey)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        weekPace = try container.decodeIfPresent(UsageProjectionPaceResponse.self, forKey: .weekPace)
        recentPace = try container.decodeIfPresent(UsageProjectionPaceResponse.self, forKey: .recentPace)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
    }
}

struct UsageProjectionPaceResponse: Decodable {
    let percentPerDay: Double?
    let runsOutAt: String?
    let capsBeforeReset: Bool?

    enum CodingKeys: String, CodingKey {
        case percentPerDay
        case runsOutAt
        case capsBeforeReset
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        percentPerDay = try container.decodeIfPresent(Double.self, forKey: .percentPerDay)
        runsOutAt = try container.decodeIfPresent(String.self, forKey: .runsOutAt)
        capsBeforeReset = try container.decodeIfPresent(Bool.self, forKey: .capsBeforeReset)
    }
}

struct ResetCreditSummary: Decodable {
    let title: String
    let status: String
    let grantedAt: Date?
    let expiresAt: Date?

    enum CodingKeys: String, CodingKey {
        case title
        case status
        case grantedAt
        case expiresAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Reset credit"
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        grantedAt = Self.parseDate(try container.decodeIfPresent(String.self, forKey: .grantedAt))
        expiresAt = Self.parseDate(try container.decodeIfPresent(String.self, forKey: .expiresAt))
    }

    private static func parseDate(_ rawValue: String?) -> Date? {
        guard let rawValue else { return nil }

        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: rawValue) {
            return date
        }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: rawValue)
    }
}

struct ExtraUsageSummary: Decodable {
    let isEnabled: Bool?

    enum CodingKeys: String, CodingKey {
        case isEnabled = "is_enabled"
    }
}

struct DashboardView: View {
    @ObservedObject var viewModel: DashboardViewModel
    @ObservedObject var statusViewModel: StatusLightViewModel

    var body: some View {
        ZStack {
            statusViewModel.snapshot.state.color
                .opacity(0.12)
                .ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    StatusLightCard(viewModel: statusViewModel)

                    if let errorMessage = viewModel.errorMessage {
                        Text(errorMessage)
                            .font(.callout)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let snapshot = viewModel.snapshot {
                        ForEach(snapshot.providers.indices, id: \.self) { index in
                            let provider = snapshot.providers[index]
                            UsageProviderSection(
                                provider: provider,
                                incident: statusViewModel.snapshot.incident(for: provider.key),
                                strategy: index == 0 ? snapshot.strategy : nil
                            )
                        }

                        Text("Usage updated \(formatLocal(snapshot.fetchedAt))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if viewModel.isLoading {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Loading usage")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Text("Open the refresh menu to load your Codex usage.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(18)
            }
        }
        .frame(width: 380)
        .frame(maxHeight: 620)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Codex Usage Status")
                    .font(.title3.weight(.semibold))
                Text("\(statusViewModel.snapshot.state.title) · \(localTimeZone.identifier)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button {
                viewModel.refresh()
            } label: {
                if viewModel.isLoading {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .buttonStyle(.borderless)
            .help("Refresh usage")

            Button {
                NSApp.terminate(nil)
            } label: {
                Image(systemName: "power")
            }
            .buttonStyle(.borderless)
            .help("Quit")
        }
    }
}

struct UsageProviderSection: View {
    let provider: UsageProviderViewData
    let incident: ProviderIncidentViewData?
    let strategy: UsageStrategyViewData?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let incident, incident.isActive {
                ProviderIncidentBanner(incident: incident)
            }

            if let strategy {
                StrategyRow(strategy: strategy)
            }

            HStack(alignment: .firstTextBaseline) {
                Text(provider.name)
                    .font(.headline)
                if let plan = provider.plan, !plan.isEmpty {
                    Text(plan.uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let fetchedAt = provider.fetchedAt {
                    Text(formatLocal(fetchedAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            if provider.ok == false {
                Text(provider.error ?? "Provider usage unavailable.")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if provider.windows.isEmpty {
                Text("No usage windows returned.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(provider.windows, id: \.key) { window in
                    UsageWindowCard(
                        title: window.label,
                        window: window,
                        projection: window.key == "weekly" || window.key.hasPrefix("weekly_scoped:") ? window.projection : nil
                    )
                }
            }

            if let resetCredits = provider.resetCreditsAvailable {
                ResetCreditsCard(
                    available: resetCredits,
                    credits: provider.resetCredits
                )
            }
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}

struct StrategyRow: View {
    let strategy: UsageStrategyViewData

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "lightbulb")
                .font(.caption.weight(.semibold))
                .foregroundStyle(strategy.tint)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text("Strategy")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(strategy.tint)
                Text(strategy.advice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let secondary = strategy.secondary {
                    Text(secondary.advice)
                        .font(.caption2)
                        .foregroundStyle(secondary.tint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(strategy.tint.opacity(strategy.urgency == "act" ? 0.12 : 0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct ProviderIncidentBanner: View {
    let incident: ProviderIncidentViewData

    var body: some View {
        Button {
            if let statusURL = incident.statusURL {
                NSWorkspace.shared.open(statusURL)
            }
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("⚠")
                    Text("\(incident.providerDisplayName) incident: \(incident.description ?? "Status incident reported.")")
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .font(.caption.weight(.semibold))

                if !incident.incidents.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(incident.incidents) { item in
                            Text(item.name)
                                .lineLimit(2)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(foregroundColor)
            .padding(9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(backgroundColor, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help(incident.statusURL?.absoluteString ?? "")
    }

    private var backgroundColor: Color {
        incident.isCritical ? Color.red.opacity(0.16) : Color.orange.opacity(0.18)
    }

    private var foregroundColor: Color {
        incident.isCritical ? .red : .orange
    }
}

struct StatusLightCard: View {
    @ObservedObject var viewModel: StatusLightViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Circle()
                    .fill(viewModel.snapshot.state.color)
                    .frame(width: 18, height: 18)
                    .shadow(color: viewModel.snapshot.state.color.opacity(0.55), radius: 8)

                VStack(alignment: .leading, spacing: 2) {
                    Text(viewModel.snapshot.state.title)
                        .font(.headline)
                    Text(viewModel.snapshot.summary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }

            if let errorMessage = viewModel.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if viewModel.snapshot.daemon?.staleCode == true {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text("⚠ Daemon is running outdated code — restart it")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.orange)
                }
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }

            if viewModel.snapshot.sessions.isEmpty {
                Text("No tracked sessions are reporting yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(viewModel.snapshot.sessions.prefix(4)) { session in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(session.state.color)
                            .frame(width: 8, height: 8)
                        Text(session.title)
                            .font(.caption.weight(.medium))
                            .lineLimit(1)
                        Spacer()
                        Text(session.state.title)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Text(statusFooter)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .truncationMode(.middle)
        }
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }

    private var statusFooter: String {
        let updated = viewModel.snapshot.updatedAt.map { "Status updated \(formatLocal($0))" } ?? "Waiting for status updates"
        return "\(updated) · \(viewModel.snapshot.source)"
    }
}

struct UsageWindowCard: View {
    let title: String
    let window: UsageWindowViewData?
    let projection: UsageProjectionViewData?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(.headline)
                Spacer()
                Text(window?.displayPercent ?? "Unavailable")
                    .font(.headline.monospacedDigit())
                    .foregroundStyle(percentColor)
            }

            ProgressView(value: window?.progressValue ?? 0)
                .tint(percentColor)

            TimelineView(.periodic(from: Date(), by: 60)) { context in
                Text(resetText(now: context.date))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let projection {
                Text(projection.summary)
                    .font(.caption)
                    .foregroundStyle(projection.tint)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    private func resetText(now: Date) -> String {
        guard let resetAt = window?.resetAt else {
            return "Reset time unavailable"
        }
        return "Resets \(formatLocal(resetAt)) \(formatRelativeReset(from: now, to: resetAt))"
    }

    private var percentColor: Color {
        guard let used = window?.usedPercent else { return .secondary }
        switch used {
        case 80...:
            return .red
        case 60..<80:
            return .orange
        default:
            return .green
        }
    }
}

struct ResetCreditsCard: View {
    let available: Int
    let credits: [ResetCreditViewData]
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if credits.isEmpty {
                countRow
            } else {
                DisclosureGroup(isExpanded: $isExpanded) {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(credits) { credit in
                            ResetCreditRow(credit: credit)
                        }
                    }
                    .padding(.top, 4)
                } label: {
                    countRow
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation {
                                isExpanded.toggle()
                            }
                        }
                }
            }

            Text(available == 1 ? "1 reset credit available." : "\(available) reset credits available.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    private var countRow: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Reset credits")
                .font(.headline)
            Spacer()
            Text("\(available)")
                .font(.headline.monospacedDigit())
        }
        .contentShape(Rectangle())
    }
}

struct ResetCreditRow: View {
    let credit: ResetCreditViewData

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(credit.title)
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(credit.status)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Text("Granted \(formatLocalOptional(credit.grantedAt)) · Expires \(formatLocalOptional(credit.expiresAt))")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.leading, 2)
    }
}

func formatLocalOptional(_ date: Date?) -> String {
    guard let date else { return "unavailable" }
    return formatLocal(date)
}

func formatPercent(_ value: Double) -> String {
    let rounded = value.rounded()
    if abs(value - rounded) < 0.05 {
        return "\(Int(rounded))"
    }
    return String(format: "%.1f", value)
}

func formatLocal(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.timeZone = localTimeZone
    formatter.dateStyle = .medium
    formatter.timeStyle = .medium
    return formatter.string(from: date)
}

func formatRelativeReset(from now: Date, to resetAt: Date) -> String {
    let remainingSeconds = resetAt.timeIntervalSince(now)
    guard remainingSeconds > 0 else {
        return "(now)"
    }

    let totalMinutes = max(0, Int(ceil(remainingSeconds / 60)))
    let days = totalMinutes / (24 * 60)
    let hours = (totalMinutes % (24 * 60)) / 60
    let minutes = totalMinutes % 60

    if days >= 1 {
        return "(in \(days)d \(hours)h)"
    }
    if hours >= 1 {
        return "(in \(hours)h \(minutes)m)"
    }
    return "(in \(minutes)m)"
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private struct StatusPillProviderItem {
        let key: String
        let logo: NSImage
        let text: String
        let incidentIndicator: String?
    }

    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private let viewModel = DashboardViewModel()
    private let statusViewModel = StatusLightViewModel()
    private let weeklyLimitNotifier = WeeklyLimitNotifier()
    private lazy var providerLogos: [String: NSImage] = Self.loadProviderLogos()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        weeklyLimitNotifier.requestAuthorization()

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.imagePosition = .imageOnly
        item.button?.title = ""
        item.button?.target = self
        item.button?.action = #selector(togglePopover(_:))
        statusItem = item

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appearanceDidChange(_:)),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        DistributedNotificationCenter.default().addObserver(
            self,
            selector: #selector(appearanceDidChange(_:)),
            name: NSNotification.Name("AppleInterfaceThemeChangedNotification"),
            object: nil
        )

        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 380, height: 520)
        popover.contentViewController = NSHostingController(
            rootView: DashboardView(viewModel: viewModel, statusViewModel: statusViewModel)
        )
        self.popover = popover

        viewModel.onSnapshotChanged = { [weak self] snapshot in
            self?.updateStatusItem()
            if let snapshot {
                self?.weeklyLimitNotifier.evaluate(snapshot)
            }
        }
        statusViewModel.onStatusChanged = { [weak self] _ in
            self?.updateStatusItem()
        }
        statusViewModel.startAutoRefresh()
        viewModel.startAutoRefresh()
        viewModel.refresh()
        updateStatusItem()
    }

    @objc private func togglePopover(_ sender: AnyObject?) {
        guard let button = statusItem?.button, let popover else { return }

        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc private func appearanceDidChange(_ notification: Notification) {
        updateStatusItem()
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        let state = statusViewModel.snapshot.state
        button.image = Self.statusPillImage(
            state: state,
            providers: statusPillProviders(),
            appearance: button.effectiveAppearance
        )
        button.imagePosition = .imageOnly
        button.title = ""
        button.toolTip = "\(state.menuTitle) · \(statusViewModel.snapshot.summary)"
    }

    private func statusPillProviders() -> [StatusPillProviderItem] {
        guard let snapshot = viewModel.snapshot else { return [] }
        return ["codex", "claude"].compactMap { key in
            let provider: UsageProviderViewData?
            switch key {
            case "codex":
                provider = snapshot.codex
            case "claude":
                provider = snapshot.claude
            default:
                provider = nil
            }

            guard let provider, provider.isAvailable, let logo = providerLogos[key] else {
                return nil
            }

            let incident = statusViewModel.snapshot.incident(for: key)
            return StatusPillProviderItem(
                key: key,
                logo: logo,
                text: Self.compactUsagePair(provider: provider),
                incidentIndicator: incident?.isActive == true ? incident?.indicator?.lowercased() : nil
            )
        }
    }

    private static func compactUsagePair(provider: UsageProviderViewData) -> String {
        guard !provider.windows.isEmpty else { return "-" }

        let compactWindows: [UsageWindowViewData]
        if provider.windows.count == 1 {
            compactWindows = provider.windows
        } else {
            var includedSession = false
            var includedWeekly = false
            compactWindows = provider.windows.filter { window in
                if window.key == "session", !includedSession {
                    includedSession = true
                    return true
                }
                if window.key.hasPrefix("weekly"), !includedWeekly {
                    includedWeekly = true
                    return true
                }
                return false
            }
        }

        guard !compactWindows.isEmpty else { return "-" }
        return compactWindows
            .map { $0.usedPercent.map(formatPercent) ?? "-" }
            .joined(separator: "/")
    }

    private static func statusPillImage(
        state: StatusLightState,
        providers: [StatusPillProviderItem],
        appearance: NSAppearance
    ) -> NSImage {
        let height: CGFloat = 18
        let logoSize: CGFloat = 13
        let horizontalPadding: CGFloat = 7
        let logoTextSpacing: CGFloat = 4.5
        let providerSpacing: CGFloat = 7
        let font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        let textColor = adaptiveMenuBarTextColor(for: appearance)
        let textAttributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: textColor
        ]

        let textSizes = providers.map { provider in
            (provider.text as NSString).size(withAttributes: textAttributes)
        }
        let contentWidth = zip(providers, textSizes).reduce(CGFloat(0)) { width, pair in
            let providerWidth = logoSize + logoTextSpacing + ceil(pair.1.width)
            return width + providerWidth
        } + CGFloat(max(0, providers.count - 1)) * providerSpacing
        let width = max(26, horizontalPadding * 2 + contentWidth)
        let size = NSSize(width: width, height: height)

        let image = NSImage(size: size, flipped: false) { rect in
            let pillRect = rect.insetBy(dx: 0.5, dy: 0.5)
            let pillPath = NSBezierPath(roundedRect: pillRect, xRadius: height / 2, yRadius: height / 2)
            state.nsColor.withAlphaComponent(0.28).setFill()
            pillPath.fill()
            textColor.withAlphaComponent(0.10).setStroke()
            pillPath.lineWidth = 1
            pillPath.stroke()

            var x = horizontalPadding
            for (index, provider) in providers.enumerated() {
                let logoRect = NSRect(x: x, y: (height - logoSize) / 2, width: logoSize, height: logoSize)
                drawTintedLogo(provider.logo, in: logoRect, color: textColor)
                if let indicator = provider.incidentIndicator {
                    drawIncidentBadge(indicator: indicator, logoRect: logoRect)
                }

                x += logoSize + logoTextSpacing
                let textSize = textSizes[index]
                let textRect = NSRect(
                    x: x,
                    y: (height - textSize.height) / 2 - 0.3,
                    width: ceil(textSize.width),
                    height: textSize.height
                )
                (provider.text as NSString).draw(in: textRect, withAttributes: textAttributes)
                x += ceil(textSize.width) + providerSpacing
            }

            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "Codex usage status: \(state.title)"
        return image
    }

    private static func loadProviderLogos() -> [String: NSImage] {
        ["codex", "claude"].reduce(into: [:]) { result, key in
            guard let url = Bundle.module.url(forResource: "ProviderIcon-\(key)", withExtension: "svg"),
                  let image = NSImage(contentsOf: url)
            else {
                return
            }
            image.isTemplate = false
            result[key] = image
        }
    }

    private static func adaptiveMenuBarTextColor(for appearance: NSAppearance) -> NSColor {
        let darkAppearances: [NSAppearance.Name] = [
            .darkAqua,
            .vibrantDark,
            .accessibilityHighContrastDarkAqua,
            .accessibilityHighContrastVibrantDark
        ]
        let lightAppearances: [NSAppearance.Name] = [
            .aqua,
            .vibrantLight,
            .accessibilityHighContrastAqua,
            .accessibilityHighContrastVibrantLight
        ]
        let match = appearance.bestMatch(from: darkAppearances + lightAppearances)
        return darkAppearances.contains(match ?? .aqua) ? .white : .black
    }

    private static func drawTintedLogo(_ logo: NSImage, in rect: NSRect, color: NSColor) {
        NSGraphicsContext.saveGraphicsState()
        logo.draw(
            in: rect,
            from: .zero,
            operation: .sourceOver,
            fraction: 1,
            respectFlipped: true,
            hints: [.interpolation: NSImageInterpolation.high]
        )
        color.setFill()
        rect.fill(using: .sourceAtop)
        NSGraphicsContext.restoreGraphicsState()
    }

    private static func drawIncidentBadge(indicator: String, logoRect: NSRect) {
        let badgeSize: CGFloat = 6.8
        let badgeRect = NSRect(
            x: logoRect.maxX - badgeSize + 1.4,
            y: logoRect.minY - 1.3,
            width: badgeSize,
            height: badgeSize
        )
        let badgeColor: NSColor = indicator == "critical" ? .systemRed : .systemOrange
        badgeColor.setFill()
        NSBezierPath(ovalIn: badgeRect).fill()

        NSColor.white.setFill()
        let font = NSFont.systemFont(ofSize: 5.4, weight: .black)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.white
        ]
        let mark = "!" as NSString
        let size = mark.size(withAttributes: attributes)
        mark.draw(
            at: NSPoint(
                x: badgeRect.midX - size.width / 2,
                y: badgeRect.midY - size.height / 2 - 0.2
            ),
            withAttributes: attributes
        )
    }
}

private var retainedAppDelegate: AppDelegate?

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let appDelegate = AppDelegate()
    retainedAppDelegate = appDelegate
    app.delegate = appDelegate
    app.run()
}

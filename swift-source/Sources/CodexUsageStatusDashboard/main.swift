import AppKit
import Foundation
import SwiftUI
import UserNotifications

private let localTimeZone = TimeZone.current

struct UsageSnapshot {
    let fetchedAt: Date
    let resetCreditsAvailable: Int?
    let credits: [ResetCreditViewData]
    let fiveHour: UsageWindowViewData?
    let weekly: UsageWindowViewData?
}

struct UsageWindowViewData {
    let usedPercent: Int?
    let resetAt: Date?
    let windowSeconds: Int?

    var displayPercent: String {
        guard let usedPercent else { return "Unavailable" }
        return "\(usedPercent)%"
    }

    var progressValue: Double {
        guard let usedPercent else { return 0 }
        return min(max(Double(usedPercent) / 100.0, 0), 1)
    }
}

struct ResetCreditViewData: Identifiable {
    let id = UUID()
    let title: String
    let status: String
    let grantedAt: Date?
    let expiresAt: Date?
    let rawGrantedAt: String?
    let rawExpiresAt: String?
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
        StatusLightSnapshot(state: .offline, sessions: [], updatedAt: nil, fileURL: fileURL, source: "Source offline")
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

private struct StatusLightFile: Decodable {
    let sessions: [StatusLightFileSession]
    let updatedAt: String?
    let generatedAt: String?
    let summary: StatusLightFileSummary?
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

        return StatusLightSnapshot(
            state: forceOffline ? .offline : (file.summary?.status ?? fallbackState(for: sessions, now: generatedAt)),
            sessions: sessions,
            updatedAt: parseDate(file.updatedAt),
            fileURL: fileURL,
            source: source
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
    private let baseURL = URL(string: "https://chatgpt.com/backend-api/wham")!
    private let decoder: JSONDecoder

    init() {
        decoder = JSONDecoder()
    }

    func fetchSnapshot() async throws -> UsageSnapshot {
        async let usage: UsageResponse = fetch("usage")
        async let credits: ResetCreditsResponse = fetch("rate-limit-reset-credits")

        let usageResponse = try await usage
        let creditsResponse = try await credits

        return UsageSnapshot(
            fetchedAt: Date(),
            resetCreditsAvailable: creditsResponse.availableCount ?? usageResponse.rateLimitResetCredits?.availableCount,
            credits: creditsResponse.credits.map {
                ResetCreditViewData(
                    title: $0.title ?? "Untitled reset credit",
                    status: $0.status ?? "unknown",
                    grantedAt: Self.parseDate($0.grantedAt),
                    expiresAt: Self.parseDate($0.expiresAt),
                    rawGrantedAt: $0.grantedAt,
                    rawExpiresAt: $0.expiresAt
                )
            },
            fiveHour: usageResponse.rateLimit?.primaryWindow.map(Self.windowViewData),
            weekly: usageResponse.rateLimit?.secondaryWindow.map(Self.windowViewData)
        )
    }

    private func fetch<T: Decodable>(_ path: String) async throws -> T {
        let token = try Self.loadAccessToken()
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("CodexUsageDashboard/0.1", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw DashboardError.requestFailed(http.statusCode)
        }
        return try decoder.decode(T.self, from: data)
    }

    private static func loadAccessToken() throws -> String {
        let authURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codex")
            .appendingPathComponent("auth.json")

        let data = try Data(contentsOf: authURL)
        let auth = try JSONDecoder().decode(AuthFile.self, from: data)

        guard let token = auth.tokens?.accessToken, !token.isEmpty else {
            throw DashboardError.missingToken
        }
        return token
    }

    private static func windowViewData(_ window: RateLimitWindow) -> UsageWindowViewData {
        UsageWindowViewData(
            usedPercent: window.usedPercent,
            resetAt: window.resetAt.map { Date(timeIntervalSince1970: TimeInterval($0)) },
            windowSeconds: window.limitWindowSeconds
        )
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
        guard let weekly = snapshot.weekly, let usedPercent = weekly.usedPercent else {
            return
        }

        let threshold: Threshold
        if usedPercent >= criticalThreshold {
            threshold = .critical
        } else if usedPercent >= warningThreshold {
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
        let content = UNMutableNotificationContent()
        content.title = title(for: threshold, usedPercent: usedPercent)
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
        usedPercent: Int,
        weekly: UsageWindowViewData,
        snapshot: UsageSnapshot
    ) -> String {
        let remainingPercent = max(0, 100 - usedPercent)
        let resetText = weekly.resetAt.map { formatLocal($0) } ?? "the next weekly reset"
        let creditCount = snapshot.resetCreditsAvailable ?? snapshot.credits.count
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
    case missingToken
    case requestFailed(Int)

    var errorDescription: String? {
        switch self {
        case .missingToken:
            return "No Codex access token was found in ~/.codex/auth.json."
        case .requestFailed(let statusCode):
            return "The usage endpoint returned HTTP \(statusCode)."
        }
    }
}

struct AuthFile: Decodable {
    let tokens: AuthTokens?
}

struct AuthTokens: Decodable {
    let accessToken: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
    }
}

struct UsageResponse: Decodable {
    let rateLimit: RateLimit?
    let rateLimitResetCredits: ResetCreditCount?

    enum CodingKeys: String, CodingKey {
        case rateLimit = "rate_limit"
        case rateLimitResetCredits = "rate_limit_reset_credits"
    }
}

struct RateLimit: Decodable {
    let primaryWindow: RateLimitWindow?
    let secondaryWindow: RateLimitWindow?

    enum CodingKeys: String, CodingKey {
        case primaryWindow = "primary_window"
        case secondaryWindow = "secondary_window"
    }
}

struct RateLimitWindow: Decodable {
    let limitWindowSeconds: Int?
    let resetAt: Int?
    let usedPercent: Int?

    enum CodingKeys: String, CodingKey {
        case limitWindowSeconds = "limit_window_seconds"
        case resetAt = "reset_at"
        case usedPercent = "used_percent"
    }
}

struct ResetCreditCount: Decodable {
    let availableCount: Int?

    enum CodingKeys: String, CodingKey {
        case availableCount = "available_count"
    }
}

struct ResetCreditsResponse: Decodable {
    let availableCount: Int?
    let credits: [ResetCreditResponse]

    enum CodingKeys: String, CodingKey {
        case availableCount = "available_count"
        case credits
    }
}

struct ResetCreditResponse: Decodable {
    let title: String?
    let status: String?
    let grantedAt: String?
    let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case title
        case status
        case grantedAt = "granted_at"
        case expiresAt = "expires_at"
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
                        UsageWindowCard(title: "5-hour usage", window: snapshot.fiveHour)
                        UsageWindowCard(title: "Weekly usage", window: snapshot.weekly)
                        ResetCreditsCard(snapshot: snapshot)

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

            Text(resetText)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    private var resetText: String {
        guard let resetAt = window?.resetAt else {
            return "Reset time unavailable"
        }
        return "Resets \(formatLocal(resetAt))"
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
    let snapshot: UsageSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Reset credits")
                    .font(.headline)
                Spacer()
                Text("\(snapshot.resetCreditsAvailable ?? snapshot.credits.count)")
                    .font(.headline.monospacedDigit())
            }

            if snapshot.credits.isEmpty {
                Text("No available reset credits returned.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(snapshot.credits) { credit in
                    ResetCreditRow(credit: credit)
                }
            }
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct ResetCreditRow: View {
    let credit: ResetCreditViewData

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(credit.title)
                    .font(.subheadline.weight(.medium))
                Spacer()
                Text(credit.status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text("Granted \(formatLocalOptional(credit.grantedAt))")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("Expires \(formatLocalOptional(credit.expiresAt))")
                .font(.caption2)
                .foregroundStyle(.secondary)

            Text("UTC \(credit.rawGrantedAt ?? "unavailable") -> \(credit.rawExpiresAt ?? "unavailable")")
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .padding(.top, 2)
    }
}

func formatLocalOptional(_ date: Date?) -> String {
    guard let date else { return "unavailable" }
    return formatLocal(date)
}

func formatLocal(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.timeZone = localTimeZone
    formatter.dateStyle = .medium
    formatter.timeStyle = .medium
    return formatter.string(from: date)
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private let viewModel = DashboardViewModel()
    private let statusViewModel = StatusLightViewModel()
    private let weeklyLimitNotifier = WeeklyLimitNotifier()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        weeklyLimitNotifier.requestAuthorization()

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = statusIcon(for: .idle)
        item.button?.imagePosition = .imageLeft
        item.button?.title = " Codex"
        item.button?.target = self
        item.button?.action = #selector(togglePopover(_:))
        statusItem = item

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

    private func updateStatusItem() {
        let usageText: String
        if let snapshot = viewModel.snapshot {
            let fiveHour = snapshot.fiveHour?.usedPercent.map { "\($0)%" } ?? "-"
            let weekly = snapshot.weekly?.usedPercent.map { "\($0)%" } ?? "-"
            usageText = "\(fiveHour)/\(weekly)"
        } else {
            usageText = "Codex"
        }

        let state = statusViewModel.snapshot.state
        statusItem?.button?.image = statusIcon(for: state)
        statusItem?.button?.title = " \(usageText)"
        statusItem?.button?.toolTip = "\(state.menuTitle) · \(statusViewModel.snapshot.summary)"
    }

    private func statusIcon(for state: StatusLightState) -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size)
        image.lockFocus()

        let rect = NSRect(x: 2, y: 2, width: 14, height: 14)
        state.nsColor.setFill()
        NSBezierPath(ovalIn: rect).fill()

        NSColor.black.withAlphaComponent(0.18).setStroke()
        let outline = NSBezierPath(ovalIn: rect)
        outline.lineWidth = 1
        outline.stroke()

        image.unlockFocus()
        image.isTemplate = false
        image.accessibilityDescription = "Codex status: \(state.title)"
        return image
    }
}

@main
struct CodexUsageStatusDashboardApp {
    @MainActor private static var delegate: AppDelegate?

    @MainActor
    static func main() {
        let app = NSApplication.shared
        let appDelegate = AppDelegate()
        delegate = appDelegate
        app.delegate = appDelegate
        app.run()
    }
}

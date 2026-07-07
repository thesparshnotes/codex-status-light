// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "CodexUsageStatusDashboard",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "CodexUsageStatusDashboard", targets: ["CodexUsageStatusDashboard"])
    ],
    targets: [
        .executableTarget(
            name: "CodexUsageStatusDashboard",
            resources: [
                .process("Resources")
            ]
        )
    ]
)

// Verify that the packaged app reaches an onscreen window, not merely a live process.
// https://developer.apple.com/documentation/coregraphics/cgwindowlistcopywindowinfo(_:_:)
import Foundation
import CoreGraphics

guard CommandLine.arguments.count == 2,
      let ownerPID = Int32(CommandLine.arguments[1]), ownerPID > 0 else {
    fputs("Usage: swift qa-macos-visible.swift <app-pid>\n", stderr)
    exit(2)
}

let deadline = Date().addingTimeInterval(15)
repeat {
    guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
        fputs("No GUI window server is available for the visibility check.\n", stderr)
        exit(1)
    }
    for window in windows {
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == ownerPID,
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any],
              let width = (bounds["Width"] as? NSNumber)?.doubleValue,
              let height = (bounds["Height"] as? NSNumber)?.doubleValue,
              width >= 640, height >= 400,
              ((window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0 else { continue }
        print("PASS packaged app PID \(ownerPID) has an onscreen window (\(width) × \(height)).")
        exit(0)
    }
    Thread.sleep(forTimeInterval: 0.1)
} while Date() < deadline

fputs("The packaged application did not show a window after frontend initialization.\n", stderr)
exit(1)

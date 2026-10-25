// trim cpu <capture-dir> [--threads n] [--warmup n] [--repeat n] [--out file]
// trim metal <capture-dir> [--warmup n] [--repeat n] [--out file] [--variant index|dense|lean|wide|packed]
// --repeat 0 loads and indexes (and sets Metal up) only, for the footprint before any trim.
// Exit 2: a flag or a capture refused, with why; 3: memory, a device or the pool.
import Foundation

let usage = "usage: trim cpu|metal <capture-dir> [--threads n] [--warmup n] [--repeat n] [--out file] [--variant index|dense|lean|wide|packed]"
var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
  guard let at = args.firstIndex(of: name) else { return nil }
  guard at + 1 < args.count else { refuse("\(name) needs a value\n\(usage)", 2) }
  let value = args[at + 1]
  args.removeSubrange(at...(at + 1))
  return value
}
/// A whole-number flag within its range, or its default when absent; any
/// other value is refused, never read as the default.
func number(_ name: String, _ fallback: Int, _ range: ClosedRange<Int>) -> Int {
  guard let given = option(name) else { return fallback }
  guard let value = Int(given), range.contains(value) else {
    refuse("\(name) takes a whole number from \(range.lowerBound) to \(range.upperBound), not \(given)", 2)
  }
  return value
}
let threads = number("--threads", ProcessInfo.processInfo.activeProcessorCount, 1...1024)
let repeatCount = number("--repeat", 5, 0...100_000)
let warmup = number("--warmup", 0, 0...100_000)
let outPath = option("--out")
let variant = option("--variant") ?? "index"
let variants = ["index", "dense", "lean", "wide", "packed"]
guard variants.contains(variant) else { refuse("--variant is one of \(variants.joined(separator: ", ")), not \(variant)", 2) }
guard args.count == 2 else { refuse(usage, 2) }
let mode = args[0], dir = args[1]
guard ["cpu", "metal"].contains(mode) else { refuse("unknown mode \(mode)\n\(usage)", 2) }

var t = now()
let capture = Capture(dir: dir)
let loadMs = now() - t
t = now()
let index = Index(capture)
let indexMs = now() - t

func report(_ version: String, _ lists: [[UInt32]], _ times: [Double], _ extra: [String: Any] = [:]) {
  if let outPath, !times.isEmpty { write(encode(lists), to: outPath) }
  var fields: [String: Any] = [
    "version": version, "facts": capture.facts, "rules": capture.rules.count, "patterns": lists.count,
    "kept": lists.reduce(0) { $0 + $1.count }, "loadMs": (loadMs * 100).rounded() / 100,
    "indexMs": (indexMs * 100).rounded() / 100, "trimMs": times.map { ($0 * 100).rounded() / 100 },
  ]
  if !times.isEmpty { fields["medianMs"] = (median(times) * 100).rounded() / 100 }
  for (k, v) in extra { fields[k] = v }
  guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else {
    refuse("could not write the report")
  }
  print(String(decoding: data, as: UTF8.self))
}

switch mode {
case "cpu":
  var times: [Double] = []
  var lists: [[UInt32]] = []
  for _ in 0..<warmup { _ = trimCPU(capture, index, threads: threads) }
  for _ in 0..<repeatCount {
    let t = now()
    lists = trimCPU(capture, index, threads: threads)
    times.append(now() - t)
  }
  report("swift-cpu-\(threads)", lists, times, ["threads": threads])
case "metal":
  #if TRIM_METAL
  runMetal(capture, index, variant: variant, warmup: warmup, repeatCount: repeatCount, report: report)
  #else
  FileHandle.standardError.write("this build has no Metal backend; build it with -D TRIM_METAL\n".data(using: .utf8)!)
  exit(3)
  #endif
default:
  refuse("unknown mode \(mode)\n\(usage)", 2)
}

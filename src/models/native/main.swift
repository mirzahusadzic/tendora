// trim cpu <capture-dir> [--threads n] [--warmup n] [--repeat n] [--out file]
// trim metal <capture-dir> [--warmup n] [--repeat n] [--out file] [--variant index|dense|lean|wide|packed]
// --repeat 0 loads and indexes (and sets Metal up) only, for the footprint before any trim.
import Foundation

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
  guard let at = args.firstIndex(of: name), at + 1 < args.count else { return nil }
  let value = args[at + 1]
  args.removeSubrange(at...(at + 1))
  return value
}
let threads = Int(option("--threads") ?? "") ?? ProcessInfo.processInfo.activeProcessorCount
let repeatCount = Int(option("--repeat") ?? "") ?? 5
let warmup = Int(option("--warmup") ?? "") ?? 0
let outPath = option("--out")
let variant = option("--variant") ?? "index"
guard args.count == 2 else {
  print("usage: trim cpu|metal <capture-dir> [--threads n] [--warmup n] [--repeat n] [--out file] [--variant index|dense|lean|wide|packed]")
  exit(2)
}
let mode = args[0], dir = args[1]

var t = now()
let capture = try Capture(dir: dir)
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
  let data = try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
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
  print("unknown mode \(mode)")
  exit(2)
}

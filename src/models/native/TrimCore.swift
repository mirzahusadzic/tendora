// The trim of a capture, shared by the CPU and Metal versions: reading the
// capture (columns mapped, not copied), the per-column index, the CPU trim
// (the same algorithm as trimFast in trim.mjs, rules spread over threads), the
// residual fixpoint the GPU versions finish on, and the output encoding.
import Foundation

let VAR: UInt32 = 0x8000_0000
let MISSING: UInt32 = 0xFFFF_FFFF
let pageSize = 16384

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }

/// The run ends with a reason on stderr, never a crash: 2 for what the caller
/// gave (a flag, a capture that does not hold together), 3 for what this
/// machine could not give (memory, a device, a pool too small).
func refuse(_ reason: String, _ code: Int32 = 3) -> Never {
  FileHandle.standardError.write("\(reason)\n".data(using: .utf8)!)
  exit(code)
}

/// Page-aligned memory, so Metal can wrap it without copying.
func alignedAlloc(_ count: Int) -> UnsafeMutablePointer<UInt32> {
  var raw: UnsafeMutableRawPointer?
  let bytes = max(pageSize, (count * 4 + pageSize - 1) / pageSize * pageSize)
  guard posix_memalign(&raw, pageSize, bytes) == 0, let raw else {
    refuse("could not allocate \(bytes) bytes")
  }
  return raw.bindMemory(to: UInt32.self, capacity: bytes / 4)
}
/// Heap memory for `count` values, or a refusal: never a trap when the
/// machine has none to give. Given back with `release`.
func heap<T>(_ type: T.Type, _ count: Int) -> UnsafeMutablePointer<T> {
  guard let raw = malloc(max(1, count) * MemoryLayout<T>.stride) else {
    refuse("could not allocate \(count * MemoryLayout<T>.stride) bytes")
  }
  return raw.bindMemory(to: T.self, capacity: max(1, count))
}
func release<T>(_ pointer: UnsafeMutablePointer<T>) { free(pointer) }
func alignedBytes(_ count: Int) -> Int { max(pageSize, (count * 4 + pageSize - 1) / pageSize * pageSize) }

struct Rule {
  var patterns: [[UInt32]]
  var vars: Int
}

final class Capture {
  let facts: Int, terms: Int, columnBytes: Int
  let base: UnsafeMutableRawPointer  // the mapped columns file
  let mappedBytes: Int
  let columns: [UnsafeMutablePointer<UInt32>]
  let rules: [Rule]
  /// A capture is read only once it holds together: counts that are whole
  /// numbers, files as long as they say, rules that end where the file does,
  /// and every word of a rule a variable it has, a constant below `terms`, or
  /// MISSING. What does not is refused with why (the column values are checked
  /// as the index is built).
  init(dir: String) {
    guard let metaData = FileManager.default.contents(atPath: dir + "/meta.json") else {
      refuse("the capture has no readable meta.json", 2)
    }
    guard let meta = (try? JSONSerialization.jsonObject(with: metaData)) as? [String: Any] else {
      refuse("meta.json is not a JSON object", 2)
    }
    func count(_ key: String) -> Int {
      // As checkCapture: up to 2^28 facts or terms, so no term holds VAR;
      // columns of 4 bytes a fact, padded to a page.
      let limit = key == "columnBytes" ? 1 << 31 : 1 << 28
      guard let number = meta[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
        let value = Int(exactly: number), value >= 0, value <= limit
      else { refuse("meta.json: \(key) is not a count the trim takes", 2) }
      return value
    }
    facts = count("facts")
    terms = count("terms")
    columnBytes = count("columnBytes")
    guard columnBytes % 4 == 0, facts * 4 <= columnBytes else {
      refuse("meta.json: \(facts) facts do not fit columns of \(columnBytes) bytes", 2)
    }
    if columnBytes == 0 {
      // No facts: one zeroed page stands for the three empty columns.
      let page = alignedAlloc(pageSize / 4)
      page.initialize(repeating: 0, count: pageSize / 4)
      base = UnsafeMutableRawPointer(page)
      mappedBytes = pageSize
    } else {
      let fd = open(dir + "/columns.bin", O_RDONLY)
      guard fd >= 0 else { refuse("the capture has no readable columns.bin", 2) }
      var info = stat()
      guard fstat(fd, &info) == 0, Int(info.st_size) >= columnBytes * 3 else {
        close(fd)
        refuse("columns.bin holds \(info.st_size) bytes; meta.json says 3 × \(columnBytes)", 2)
      }
      mappedBytes = columnBytes * 3
      // Private and writable, so the pages can be wrapped by Metal; never written.
      guard let mapped = mmap(nil, mappedBytes, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0),
        mapped != MAP_FAILED
      else {
        close(fd)
        refuse("could not map columns.bin")
      }
      close(fd)
      base = mapped
    }
    let stride = columnBytes
    let mapped = base
    columns = (0..<3).map { mapped.advanced(by: $0 * stride).bindMemory(to: UInt32.self, capacity: max(1, stride / 4)) }
    guard let ruleData = FileManager.default.contents(atPath: dir + "/rules.bin"),
      ruleData.count % 4 == 0, ruleData.count >= 4
    else { refuse("rules.bin is missing or not whole 32-bit words", 2) }
    let words = ruleData.withUnsafeBytes { Array($0.bindMemory(to: UInt32.self)) }
    var at = 1
    var rules: [Rule] = []
    let termLimit = UInt32(clamping: self.terms)
    for r in 0..<Int(words[0]) {
      guard at + 2 <= words.count else { refuse("rules.bin ends inside rule \(r)", 2) }
      let count = Int(words[at]), vars = Int(words[at + 1])
      at += 2
      guard count <= (words.count - at) / 3 else { refuse("rules.bin ends inside rule \(r)", 2) }
      // A rule names at most three variables a pattern; more declared would
      // only cost memory, a bitset each (as checkCapture).
      guard vars <= 3 * count else { refuse("rules.bin: rule \(r) declares \(vars) variables for \(count) patterns", 2) }
      var patterns: [[UInt32]] = []
      for _ in 0..<count {
        let pattern = [words[at], words[at + 1], words[at + 2]]
        for word in pattern where word != MISSING {
          let fits = word & VAR != 0 ? Int(word & ~VAR) < vars : word < termLimit
          guard fits else { refuse("rules.bin: rule \(r) names \(word), no variable it has nor a term", 2) }
        }
        patterns.append(pattern)
        at += 3
      }
      rules.append(Rule(patterns: patterns, vars: vars))
    }
    guard at == words.count else { refuse("rules.bin holds \(words.count - at) words past its rules", 2) }
    self.rules = rules
  }
}

/// Per column, the facts holding each term as one run, in fact order (CSR).
final class Index {
  let offsets: [UnsafeMutablePointer<UInt32>]  // terms + 1 each
  let order: [UnsafeMutablePointer<UInt32>]  // facts each
  let terms: Int, facts: Int
  init(_ c: Capture) {
    terms = c.terms
    facts = c.facts
    var offsets: [UnsafeMutablePointer<UInt32>] = [], order: [UnsafeMutablePointer<UInt32>] = []
    for i in 0..<3 {
      let column = c.columns[i]
      let off = alignedAlloc(c.terms + 1)
      off.initialize(repeating: 0, count: c.terms + 1)
      for f in 0..<c.facts {
        let t = Int(column[f])
        // A term past `terms` would index past the runs: the capture is refused.
        guard t < c.terms else { refuse("columns.bin: fact \(f) holds term \(t) of \(c.terms)", 2) }
        off[t + 1] &+= 1
      }
      for t in 0..<c.terms { off[t + 1] &+= off[t] }
      let ord = alignedAlloc(c.facts)
      let fill = heap(UInt32.self, c.terms)
      fill.update(from: off, count: c.terms)
      for f in 0..<c.facts {
        let t = Int(column[f])
        ord[Int(fill[t])] = UInt32(f)
        fill[t] &+= 1
      }
      release(fill)
      offsets.append(off)
      order.append(ord)
    }
    self.offsets = offsets
    self.order = order
  }
  @inline(__always) func run(_ i: Int, _ t: UInt32) -> UnsafeBufferPointer<UInt32> {
    let lo = Int(offsets[i][Int(t)]), hi = Int(offsets[i][Int(t) + 1])
    return UnsafeBufferPointer(start: order[i] + lo, count: hi - lo)
  }
}

@inline(__always) func fits(_ c0: UnsafeMutablePointer<UInt32>, _ c1: UnsafeMutablePointer<UInt32>, _ c2: UnsafeMutablePointer<UInt32>, _ p: (UInt32, UInt32, UInt32), _ f: Int) -> Bool {
  let v0 = c0[f], v1 = c1[f], v2 = c2[f]
  if p.0 & VAR == 0 { if v0 != p.0 { return false } } else {
    if p.1 == p.0 && v1 != v0 { return false }
    if p.2 == p.0 && v2 != v0 { return false }
  }
  if p.1 & VAR == 0 { if v1 != p.1 { return false } } else if p.2 == p.1 && v2 != v1 { return false }
  if p.2 & VAR == 0 { if v2 != p.2 { return false } }
  return true
}
@inline(__always) func fits(_ cols: [UnsafeMutablePointer<UInt32>], _ p: [UInt32], _ f: Int) -> Bool {
  fits(cols[0], cols[1], cols[2], (p[0], p[1], p[2]), f)
}
func narrowest(_ index: Index, _ p: [UInt32]) -> UnsafeBufferPointer<UInt32>? {
  var best: UnsafeBufferPointer<UInt32>? = nil
  for i in 0..<3 where p[i] & VAR == 0 {
    let r = index.run(i, p[i])
    if best == nil || r.count < best!.count { best = r }
  }
  return best
}

/// A thread's domains: one bitset over the terms per variable slot (small
/// enough to stay in cache), and one more to intersect with. A bitset is
/// cleared by the values it holds, so nothing proportional to the terms is
/// touched between rules.
final class Scratch {
  var bits: [UnsafeMutablePointer<UInt64>]
  let spare: UnsafeMutablePointer<UInt64>
  init(vars: Int, terms: Int) {
    let words = (terms + 63) / 64
    func make() -> UnsafeMutablePointer<UInt64> {
      let b = heap(UInt64.self, words)
      b.initialize(repeating: 0, count: words)
      return b
    }
    bits = (0..<max(vars, 1)).map { _ in make() }
    spare = make()
  }
}
@inline(__always) func test(_ b: UnsafeMutablePointer<UInt64>, _ t: UInt32) -> Bool { b[Int(t >> 6)] & (1 << UInt64(t & 63)) != 0 }
@inline(__always) func set(_ b: UnsafeMutablePointer<UInt64>, _ t: UInt32) { b[Int(t >> 6)] |= 1 << UInt64(t & 63) }
@inline(__always) func clear(_ b: UnsafeMutablePointer<UInt64>, _ t: UInt32) { b[Int(t >> 6)] &= ~(1 << UInt64(t & 63)) }

/// One rule's patterns and variables, as the trim reads them.
struct RuleShape {
  let slotsOf: [[(Int, Int)]]  // per pattern: (slot, variable), once per variable
  let holders: [[(Int, Int)]]  // per variable: (pattern, slot)
  init(_ rule: Rule) {
    var slotsOf: [[(Int, Int)]] = []
    for p in rule.patterns {
      var slots: [(Int, Int)] = []
      for i in 0..<3 where p[i] & VAR != 0 {
        let v = Int(p[i] & ~VAR)
        if !slots.contains(where: { $0.1 == v }) { slots.append((i, v)) }
      }
      slotsOf.append(slots)
    }
    var holders = Array(repeating: [(Int, Int)](), count: rule.vars)
    for (k, slots) in slotsOf.enumerated() { for (i, v) in slots { holders[v].append((k, i)) } }
    self.slotsOf = slotsOf
    self.holders = holders
  }
}

/// Domains of one rule's variables over the patterns materialized so far: the
/// values every materialized holder gives, set in the variable's bitset.
struct Domains {
  var values: [[UInt32]?]
  init(vars: Int) { values = Array(repeating: nil, count: vars) }
  mutating func rebuild(_ v: Int, _ shape: RuleShape, _ kept: [[UInt32]?], _ cols: [UnsafeMutablePointer<UInt32>], _ s: Scratch) {
    let known = shape.holders[v].filter { kept[$0.0] != nil }
    if known.isEmpty { return }
    let b = s.bits[v], spare = s.spare
    if let old = values[v] { for t in old { clear(b, t) } }
    var current: [UInt32] = []
    for (h, (k, i)) in known.enumerated() {
      let column = cols[i]
      kept[k]!.withUnsafeBufferPointer { L in
        if h == 0 {
          current.reserveCapacity(L.count)
          for f in L {
            let t = column[Int(f)]
            if !test(b, t) { set(b, t); current.append(t) }
          }
        } else {
          for f in L { set(spare, column[Int(f)]) }
          var held: [UInt32] = []
          held.reserveCapacity(current.count)
          for t in current { if test(spare, t) { held.append(t) } else { clear(b, t) } }
          for f in L { clear(spare, column[Int(f)]) }
          current = held
        }
      }
    }
    values[v] = current
  }
  /// After one more holder is materialized: the old domain narrowed by its
  /// values (the other holders' lists have not changed since).
  mutating func narrow(_ v: Int, _ k: Int, _ i: Int, _ kept: [[UInt32]?], _ cols: [UnsafeMutablePointer<UInt32>], _ s: Scratch) {
    let b = s.bits[v], column = cols[i]
    kept[k]!.withUnsafeBufferPointer { L in
      guard let current = values[v] else {
        var found: [UInt32] = []
        found.reserveCapacity(L.count)
        for f in L {
          let t = column[Int(f)]
          if !test(b, t) { set(b, t); found.append(t) }
        }
        values[v] = found
        return
      }
      let spare = s.spare
      for f in L { set(spare, column[Int(f)]) }
      var held: [UInt32] = []
      held.reserveCapacity(current.count)
      for t in current { if test(spare, t) { held.append(t) } else { clear(b, t) } }
      for f in L { clear(spare, column[Int(f)]) }
      values[v] = held
    }
  }
  /// Leave the bitsets empty for the next rule.
  func release(_ s: Scratch) { for (v, vals) in values.enumerated() { if let vals { for t in vals { clear(s.bits[v], t) } } } }
}

/// The greatest fixpoint from lists that already hold every survivor, and the
/// rule's emptiness: what trimFast does after materializing.
func fixpoint(_ rule: Rule, _ shape: RuleShape, _ kept: inout [[UInt32]?], _ cols: [UnsafeMutablePointer<UInt32>], _ s: Scratch) {
  var d = Domains(vars: rule.vars)
  var changed = true
  while changed {
    changed = false
    for v in 0..<rule.vars { d.rebuild(v, shape, kept, cols, s) }
    for k in 0..<rule.patterns.count {
      let L = kept[k]!
      let checks = shape.slotsOf[k].map { (cols[$0.0], d.values[$0.1] == nil ? nil : s.bits[$0.1]) }
      var next: [UInt32] = []
      next.reserveCapacity(L.count)
      for f in L {
        var ok = true
        for (column, bits) in checks where bits != nil && !test(bits!, column[Int(f)]) { ok = false; break }
        if ok { next.append(f) }
      }
      if next.count != L.count { kept[k] = next; changed = true }
    }
  }
  d.release(s)
  if kept.contains(where: { $0!.isEmpty }) { kept = kept.map { _ in [] } }
}

/// trimFast for one rule.
func trimRule(_ rule: Rule, _ c: Capture, _ index: Index, _ s: Scratch) -> [[UInt32]] {
  let P = rule.patterns.count
  if rule.patterns.contains(where: { $0.contains(MISSING) }) { return Array(repeating: [], count: P) }
  let shape = RuleShape(rule)
  let cols = c.columns
  let c0 = cols[0], c1 = cols[1], c2 = cols[2]
  let tuples = rule.patterns.map { ($0[0], $0[1], $0[2]) }
  func start(_ k: Int) -> [UInt32] {
    let p = tuples[k]
    var list: [UInt32] = []
    if let run = narrowest(index, rule.patterns[k]) { for f in run where fits(c0, c1, c2, p, Int(f)) { list.append(f) } }
    else { for f in 0..<c.facts where fits(c0, c1, c2, p, f) { list.append(UInt32(f)) } }
    return list
  }
  var kept: [[UInt32]?] = (0..<P).map { shape.slotsOf[$0].isEmpty ? start($0) : nil }
  var d = Domains(vars: rule.vars)
  for v in 0..<rule.vars { d.rebuild(v, shape, kept, cols, s) }
  var empty = kept.contains { $0 != nil && $0!.isEmpty }
  var left = kept.filter { $0 == nil }.count
  while left > 0 && !empty {
    var best = -1, slot = -1, cost = Int.max
    for k in 0..<P where kept[k] == nil {
      let own = narrowest(index, rule.patterns[k])?.count ?? c.facts
      if own < cost { best = k; slot = -1; cost = own }
      for (i, v) in shape.slotsOf[k] {
        guard let vals = d.values[v] else { continue }
        let off = index.offsets[i]
        var visits = 0
        for x in vals { visits += Int(off[Int(x) + 1] - off[Int(x)]); if visits >= cost { break } }
        if visits < cost { best = k; slot = i; cost = visits }
      }
    }
    let p = tuples[best]
    // The checks of the pattern's variables: a column, and the bitset of a
    // finite domain (none while unknown).
    let checks = shape.slotsOf[best].map { (cols[$0.0], d.values[$0.1] == nil ? nil : s.bits[$0.1]) }
    var list: [UInt32] = []
    @inline(__always) func consider(_ f: UInt32) {
      if !fits(c0, c1, c2, p, Int(f)) { return }
      for (column, bits) in checks where bits != nil && !test(bits!, column[Int(f)]) { return }
      list.append(f)
    }
    if slot < 0 {
      if let run = narrowest(index, rule.patterns[best]) { for f in run { consider(f) } }
      else { for f in 0..<c.facts { consider(UInt32(f)) } }
    } else {
      let order = index.order[slot], off = index.offsets[slot]
      for x in d.values[Int(rule.patterns[best][slot] & ~VAR)]! {
        var j = Int(off[Int(x)])
        let end = Int(off[Int(x) + 1])
        while j < end { consider(order[j]); j += 1 }
      }
      list.sort()
    }
    kept[best] = list
    if list.isEmpty { empty = true } else { for (i, v) in shape.slotsOf[best] { d.narrow(v, best, i, kept, cols, s) } }
    left -= 1
  }
  d.release(s)
  if empty { return Array(repeating: [], count: P) }
  fixpoint(rule, shape, &kept, cols, s)
  return kept.map { $0! }
}

/// Rules spread over threads, taken from a shared counter (their costs differ).
func trimCPU(_ c: Capture, _ index: Index, threads: Int) -> [[UInt32]] {
  let maxVars = c.rules.map { $0.vars }.max() ?? 1
  var results = Array(repeating: [[UInt32]](), count: c.rules.count)
  let next = heap(Int.self, 1)
  next.initialize(to: 0)
  let lock = NSLock()
  results.withUnsafeMutableBufferPointer { out in
    let out = out
    DispatchQueue.concurrentPerform(iterations: threads) { _ in
      let scratch = Scratch(vars: maxVars, terms: c.terms)
      while true {
        lock.lock()
        let r = next.pointee
        next.pointee += 1
        lock.unlock()
        if r >= c.rules.count { break }
        out[r] = trimRule(c.rules[r], c, index, scratch)
      }
      for b in scratch.bits { release(b) }
      release(scratch.spare)
    }
  }
  release(next)
  return results.flatMap { $0 }
}

func encode(_ lists: [[UInt32]]) -> [UInt32] {
  let total = lists.reduce(0) { $0 + $1.count }
  var words = [UInt32](repeating: 0, count: 2 + lists.count + total)
  words[0] = UInt32(lists.count)
  var at = 2 + lists.count
  for (k, list) in lists.enumerated() {
    words[1 + k] = UInt32(at - (2 + lists.count))
    for (j, f) in list.enumerated() { words[at + j] = f }
    at += list.count
  }
  words[1 + lists.count] = UInt32(total)
  return words
}
func write(_ words: [UInt32], to path: String) {
  words.withUnsafeBytes {
    do { try Data($0).write(to: URL(fileURLWithPath: path)) } catch { refuse("could not write \(path): \(error.localizedDescription)") }
  }
}
func median(_ xs: [Double]) -> Double { let s = xs.sorted(); return s[s.count / 2] }

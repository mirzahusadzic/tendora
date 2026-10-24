// Random 4-byte gathers from a large array: GPU against CPU threads, the ceiling for the trim's access pattern.
import Foundation
import Metal
func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }
let n = 36_000_000, m = 16_000_000
var raw: UnsafeMutableRawPointer?
posix_memalign(&raw, 16384, n * 4); let a = raw!.bindMemory(to: UInt32.self, capacity: n)
posix_memalign(&raw, 16384, m * 4); let idx = raw!.bindMemory(to: UInt32.self, capacity: m)
var seed: UInt64 = 88172645463325252
for i in 0..<n { a[i] = UInt32(truncatingIfNeeded: i &* 2654435761) }
for i in 0..<m { seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17; idx[i] = UInt32(seed % UInt64(n)) }
// CPU
for threads in [1, 6, 12, 18] {
  var best = 1e9
  for _ in 0..<5 {
    let t = now()
    let sums = UnsafeMutablePointer<UInt64>.allocate(capacity: threads)
    DispatchQueue.concurrentPerform(iterations: threads) { k in
      let lo = m * k / threads, hi = m * (k + 1) / threads
      var s: UInt64 = 0
      var i = lo
      while i < hi { s &+= UInt64(a[Int(idx[i])]); i += 1 }
      sums[k] = s
    }
    best = min(best, now() - t)
    sums.deallocate()
  }
  print("cpu \(threads) threads: \(String(format: "%.2f", best)) ms, \(String(format: "%.2f", Double(m) / best / 1e6)) G gathers/s")
}
// GPU
let d = MTLCreateSystemDefaultDevice()!
let lib = try! d.makeLibrary(source: """
#include <metal_stdlib>
using namespace metal;
kernel void g(device const uint *a [[buffer(0)]], device const uint *idx [[buffer(1)]], device atomic_uint *out [[buffer(2)]], constant uint &m [[buffer(3)]],
  uint i [[thread_position_in_grid]], uint n [[threads_per_grid]]) {
  uint s = 0;
  for (uint j = i; j < m; j += n) s += a[idx[j]];
  s = simd_sum(s);
  if ((i & 31) == 0) atomic_fetch_add_explicit(out, s, memory_order_relaxed);
}
""", options: nil)
let p = try! d.makeComputePipelineState(function: lib.makeFunction(name: "g")!)
let ab = d.makeBuffer(bytesNoCopy: UnsafeMutableRawPointer(a), length: n * 4, options: .storageModeShared, deallocator: nil)!
let ib = d.makeBuffer(bytesNoCopy: UnsafeMutableRawPointer(idx), length: m * 4, options: .storageModeShared, deallocator: nil)!
let ob = d.makeBuffer(length: 4, options: .storageModeShared)!
var mm = UInt32(m)
let q = d.makeCommandQueue()!
for threads in [65536, 262144, 1048576] {
  var best = 1e9
  for _ in 0..<12 {
    let cb = q.makeCommandBuffer()!
    let e = cb.makeComputeCommandEncoder()!
    e.setComputePipelineState(p); e.setBuffer(ab, offset: 0, index: 0); e.setBuffer(ib, offset: 0, index: 1); e.setBuffer(ob, offset: 0, index: 2); e.setBytes(&mm, length: 4, index: 3)
    e.dispatchThreads(MTLSize(width: threads, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
    e.endEncoding(); cb.commit(); cb.waitUntilCompleted()
    best = min(best, (cb.gpuEndTime - cb.gpuStartTime) * 1000)
  }
  print("gpu \(threads) threads: \(String(format: "%.2f", best)) ms, \(String(format: "%.2f", Double(m) / best / 1e6)) G gathers/s")
}

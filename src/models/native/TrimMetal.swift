// The trim on the GPU with Metal 4. One SIMD group trims one rule at a time,
// taking rules from a shared counter, and runs the CPU algorithm with its 32
// lanes: patterns reached cheapest first (through their own run or through the
// index of a variable's domain), domains as bitsets over the terms narrowed as
// each holder arrives, then the fixpoint. A list read from a run is written in
// one pass in its order (SIMD-group prefix sums); a list reached through a
// domain is spread evenly over the lanes and sorted at the end. With --variant
// dense every pattern is read from its own run whole (after Cuckoo Cycle's mean
// miner, github.com/tromp/cuckoo); the output is the same.
//
// Columns are wrapped without copying (the capture's mapped pages, the index's
// page-aligned arrays). Pipelines are compiled once into a Metal 4 archive and
// loaded from it on later runs.
#if TRIM_METAL
import Foundation
import Metal

let shaderSource = """
#include <metal_stdlib>
using namespace metal;

// One SIMD group trims one rule at a time: its 32 lanes run the CPU
// algorithm's loops, and synchronize as a SIMD group, not a threadgroup.
constant uint VAR = 0x80000000u;
constant uint NONE = 0xffffffffu;
constant uint PMAX = 16, VMAX = 8, W = 32, SIMDS = 8;

struct Params {
  uint rules, words, facts, terms, poolCapacity, dense, vmax;
};
struct Control {
  atomic_uint next;      // the next rule to take
  atomic_uint bump;      // words of the pool used
  atomic_uint overflow;  // the pool ran out: the result is invalid
};
struct Rule {
  uint P, V, empty, first, rule;
  uint pat[PMAX][3];
  uchar slots[PMAX], slotI[PMAX][3], slotV[PMAX][3];
  uchar holders[VMAX], holderK[VMAX][PMAX], holderI[VMAX][PMAX];
  uint keptStart[PMAX], keptCount[PMAX];
  uchar kept[PMAX], keptSorted[PMAX], valKnown[VMAX];
  uint valStart[VMAX], valCount[VMAX];
  uint start, count, base;
  // Visits through a domain per column: exact (1), at least sumVal (2), or
  // unknown (0); a rebuild of the variable forgets them.
  uint sumVal[VMAX][3];
  uchar sumState[VMAX][3];
  atomic_uint counter;
};
struct Ctx {
  device const uint *col[3];
  device const uint *off[3];
  device const uint *ord[3];
  device uint *pool;
  device Control *ctl;
  constant Params *prm;
  device atomic_uint *bits;
  device atomic_uint *spare;
  uint lane;
};

inline void sync() { simdgroup_barrier(mem_flags::mem_threadgroup | mem_flags::mem_device); }
inline bool member(device atomic_uint *bits, uint t) {
  return (atomic_load_explicit(&bits[t >> 5], memory_order_relaxed) >> (t & 31u)) & 1u;
}
inline device atomic_uint *bitsOf(thread const Ctx &c, uint v) { return c.bits + (ulong)v * c.prm->words; }
inline uint runLength(device const uint *off, uint t) { return off[t + 1] - off[t]; }
inline bool fits(thread const Ctx &c, threadgroup const uint *p, uint f) {
  uint v0 = c.col[0][f], v1 = c.col[1][f], v2 = c.col[2][f];
  uint a = p[0], b = p[1], d = p[2];
  if (!(a & VAR)) { if (v0 != a) return false; }
  else { if (b == a && v1 != v0) return false; if (d == a && v2 != v0) return false; }
  if (!(b & VAR)) { if (v1 != b) return false; }
  else if (d == b && v2 != v1) return false;
  if (!(d & VAR)) { if (v2 != d) return false; }
  return true;
}
// A fact for pattern k: it fits, and lies in every known domain.
inline bool accept(thread const Ctx &c, threadgroup Rule &r, uint k, uint f) {
  if (!fits(c, r.pat[k], f)) return false;
  for (uint j = 0; j < r.slots[k]; j++) {
    uint v = r.slotV[k][j];
    if (r.valKnown[v] && !member(bitsOf(c, v), c.col[r.slotI[k][j]][f])) return false;
  }
  return true;
}
// One step of an order-preserving compaction over 32 candidates: where this
// lane writes when it keeps; r.base advances by the step's total.
inline uint compactSlot(bool keep, threadgroup Rule &r, thread const Ctx &c) {
  uint flag = keep ? 1u : 0u;
  uint at = r.base + simd_prefix_exclusive_sum(flag);
  uint total = simd_sum(flag);
  sync();
  if (c.lane == 0) r.base += total;
  sync();
  return at;
}
inline uint allocate(thread const Ctx &c, uint words) {
  uint at = atomic_fetch_add_explicit(&c.ctl->bump, words, memory_order_relaxed);
  if (at + words > c.prm->poolCapacity || at + words < at) {
    atomic_store_explicit(&c.ctl->overflow, 1u, memory_order_relaxed);
    return NONE;
  }
  return at;
}

// The facts reached through 32 domain values at a time, spread evenly over
// the lanes: each value's run is a span of a flattened sequence the lanes take
// 32 entries at a time (a lane finds the run its entry falls in by a binary
// search over the lanes' prefix sums). Calls visit(f) for every fact reached,
// with every lane busy until the last step.
template <typename Visit>
inline void expand(thread const Ctx &c, uint from, uint count, device const uint *off, device const uint *ord, thread Visit &visit) {
  for (uint base = 0; base < count; base += W) {
    uint x = base + c.lane;
    uint t = x < count ? c.pool[from + x] : 0;
    uint lo = x < count ? off[t] : 0, len = x < count ? off[t + 1] - lo : 0;
    uint before = simd_prefix_exclusive_sum(len), total = simd_sum(len);
    for (uint step = 0; step < total; step += W) {
      uint item = step + c.lane;
      // The last lane whose span starts at or before item.
      uint owner = 0;
      for (uint bit = 16; bit > 0; bit >>= 1) {
        uint probe = owner + bit;
        uint start = simd_shuffle(before, ushort(min(probe, W - 1)));
        if (probe < W && start <= item) owner = probe;
      }
      uint ownerLo = simd_shuffle(lo, ushort(owner)), ownerBefore = simd_shuffle(before, ushort(owner));
      if (item < total) visit(ord[ownerLo + item - ownerBefore]);
    }
  }
}
struct Writing {
  thread const Ctx &c; threadgroup Rule &r; uint k;
  void operator()(uint f) {
    if (accept(c, r, k, f)) c.pool[r.start + atomic_fetch_add_explicit(&r.counter, 1u, memory_order_relaxed)] = f;
  }
};

// Visits through variable v's domain in column i, counted until they reach
// cap: exact below it, else a lower bound. Cached until v is rebuilt.
inline uint visitsThrough(thread const Ctx &c, threadgroup Rule &r, uint v, uint i, uint cap) {
  uint state = r.sumState[v][i], value = r.sumVal[v][i];
  if (state == 1 || (state == 2 && value >= cap)) return value;
  device const uint *off = c.off[i];
  uint total = 0;
  bool exact = true;
  for (uint base = 0; base < r.valCount[v]; base += W) {
    uint x = base + c.lane;
    uint len = 0;
    if (x < r.valCount[v]) { uint t = c.pool[r.valStart[v] + x]; len = off[t + 1] - off[t]; }
    total += simd_sum(len);
    if (total >= cap) { exact = base + W >= r.valCount[v]; break; }
  }
  sync();
  if (c.lane == 0) { r.sumVal[v][i] = total; r.sumState[v][i] = exact ? 1 : 2; }
  sync();
  return total;
}

// Materialize pattern k from its own narrowest run (slot NONE) or through the
// index of slot's variable, in one pass: the path's visits bound its survivors,
// so that much is taken from the pool. A run is written in its order.
void materialize(thread const Ctx &c, threadgroup Rule &r, uint k, uint slot, uint visits) {
  threadgroup const uint *p = r.pat[k];
  uint col = 3, lo = 0, hi = c.prm->facts;
  if (slot == NONE)
    for (uint i = 0; i < 3; i++) if (!(p[i] & VAR)) {
      uint a = c.off[i][p[i]], b = c.off[i][p[i] + 1];
      if (col == 3 || b - a < hi - lo) { col = i; lo = a; hi = b; }
    }
  if (c.lane == 0) {
    r.start = visits ? allocate(c, visits) : 0;
    r.base = 0;
    atomic_store_explicit(&r.counter, 0u, memory_order_relaxed);
  }
  sync();
  if (r.start == NONE) { if (c.lane == 0) r.empty = 1; sync(); return; }
  if (slot == NONE) {
    for (uint chunk = lo; chunk < hi; chunk += W) {
      uint j = chunk + c.lane;
      uint f = j < hi ? (col == 3 ? j : c.ord[col][j]) : 0;
      bool keep = j < hi && accept(c, r, k, f);
      uint at = compactSlot(keep, r, c);
      if (keep) c.pool[r.start + at] = f;
    }
  } else {
    uint v = p[slot] & ~VAR;
    Writing writing{c, r, k};
    expand(c, r.valStart[v], r.valCount[v], c.off[slot], c.ord[slot], writing);
  }
  sync();
  if (c.lane == 0) {
    r.keptStart[k] = r.start;
    r.keptCount[k] = slot == NONE ? r.base : atomic_load_explicit(&r.counter, memory_order_relaxed);
    r.kept[k] = 1;
    r.keptSorted[k] = slot == NONE ? 1 : 0;
  }
  sync();
}

// A variable's domain: the values every materialized holder gives, set in its
// bitset and listed in the pool.
void rebuild(thread const Ctx &c, threadgroup Rule &r, uint v) {
  device atomic_uint *b = bitsOf(c, v);
  uint first = PMAX;
  for (uint h = 0; h < r.holders[v]; h++) if (r.kept[r.holderK[v][h]]) { first = h; break; }
  if (first == PMAX) return;
  if (c.lane < 3) r.sumState[v][c.lane] = 0;
  if (r.valKnown[v]) {
    for (uint x = c.lane; x < r.valCount[v]; x += W) {
      uint t = c.pool[r.valStart[v] + x];
      atomic_fetch_and_explicit(&b[t >> 5], ~(1u << (t & 31u)), memory_order_relaxed);
    }
    sync();
  }
  uint k0 = r.holderK[v][first], i0 = r.holderI[v][first];
  if (c.lane == 0) {
    r.start = r.keptCount[k0] ? allocate(c, r.keptCount[k0]) : 0;
    atomic_store_explicit(&r.counter, 0u, memory_order_relaxed);
  }
  sync();
  if (r.start == NONE) { if (c.lane == 0) r.empty = 1; sync(); return; }
  for (uint j = c.lane; j < r.keptCount[k0]; j += W) {
    uint t = c.col[i0][c.pool[r.keptStart[k0] + j]];
    uint bit = 1u << (t & 31u);
    // Read first: a value seen before costs no atomic.
    if (!(atomic_load_explicit(&b[t >> 5], memory_order_relaxed) & bit) &&
        !(atomic_fetch_or_explicit(&b[t >> 5], bit, memory_order_relaxed) & bit))
      c.pool[r.start + atomic_fetch_add_explicit(&r.counter, 1u, memory_order_relaxed)] = t;
  }
  sync();
  if (c.lane == 0) { r.valStart[v] = r.start; r.valCount[v] = atomic_load_explicit(&r.counter, memory_order_relaxed); r.valKnown[v] = 1; }
  sync();
  for (uint h = first + 1; h < r.holders[v]; h++) {
    uint k = r.holderK[v][h], i = r.holderI[v][h];
    if (!r.kept[k]) continue;
    for (uint j = c.lane; j < r.keptCount[k]; j += W) {
      uint t = c.col[i][c.pool[r.keptStart[k] + j]];
      if (!member(c.spare, t)) atomic_fetch_or_explicit(&c.spare[t >> 5], 1u << (t & 31u), memory_order_relaxed);
    }
    sync();
    if (c.lane == 0) r.base = 0;
    sync();
    // Keep the values this holder gives too, in place.
    uint count = r.valCount[v], from = r.valStart[v];
    for (uint chunk = 0; chunk < count; chunk += W) {
      uint x = chunk + c.lane;
      uint t = x < count ? c.pool[from + x] : 0;
      bool keep = x < count && member(c.spare, t);
      if (x < count && !keep) atomic_fetch_and_explicit(&b[t >> 5], ~(1u << (t & 31u)), memory_order_relaxed);
      uint at = compactSlot(keep, r, c);
      if (keep) c.pool[from + at] = t;
    }
    sync();
    for (uint j = c.lane; j < r.keptCount[k]; j += W) {
      uint t = c.col[i][c.pool[r.keptStart[k] + j]];
      if (member(c.spare, t)) atomic_fetch_and_explicit(&c.spare[t >> 5], ~(1u << (t & 31u)), memory_order_relaxed);
    }
    sync();
    if (c.lane == 0) r.valCount[v] = r.base;
    sync();
  }
}

// After pattern k is materialized: variable v's domain narrowed by its values
// in column i (the other holders' lists have not changed since).
void narrow(thread const Ctx &c, threadgroup Rule &r, uint v, uint k, uint i) {
  device atomic_uint *b = bitsOf(c, v);
  if (c.lane < 3) r.sumState[v][c.lane] = 0;
  sync();
  if (!r.valKnown[v]) {
    if (c.lane == 0) {
      r.start = r.keptCount[k] ? allocate(c, r.keptCount[k]) : 0;
      atomic_store_explicit(&r.counter, 0u, memory_order_relaxed);
    }
    sync();
    if (r.start == NONE) { if (c.lane == 0) r.empty = 1; sync(); return; }
    for (uint j = c.lane; j < r.keptCount[k]; j += W) {
      uint t = c.col[i][c.pool[r.keptStart[k] + j]];
      uint bit = 1u << (t & 31u);
      if (!(atomic_load_explicit(&b[t >> 5], memory_order_relaxed) & bit) &&
          !(atomic_fetch_or_explicit(&b[t >> 5], bit, memory_order_relaxed) & bit))
        c.pool[r.start + atomic_fetch_add_explicit(&r.counter, 1u, memory_order_relaxed)] = t;
    }
    sync();
    if (c.lane == 0) { r.valStart[v] = r.start; r.valCount[v] = atomic_load_explicit(&r.counter, memory_order_relaxed); r.valKnown[v] = 1; }
    sync();
    return;
  }
  for (uint j = c.lane; j < r.keptCount[k]; j += W) {
    uint t = c.col[i][c.pool[r.keptStart[k] + j]];
    if (!member(c.spare, t)) atomic_fetch_or_explicit(&c.spare[t >> 5], 1u << (t & 31u), memory_order_relaxed);
  }
  sync();
  if (c.lane == 0) r.base = 0;
  sync();
  uint count = r.valCount[v], from = r.valStart[v];
  for (uint chunk = 0; chunk < count; chunk += W) {
    uint x = chunk + c.lane;
    uint t = x < count ? c.pool[from + x] : 0;
    bool keep = x < count && member(c.spare, t);
    if (x < count && !keep) atomic_fetch_and_explicit(&b[t >> 5], ~(1u << (t & 31u)), memory_order_relaxed);
    uint at = compactSlot(keep, r, c);
    if (keep) c.pool[from + at] = t;
  }
  sync();
  for (uint j = c.lane; j < r.keptCount[k]; j += W) {
    uint t = c.col[i][c.pool[r.keptStart[k] + j]];
    if (member(c.spare, t)) atomic_fetch_and_explicit(&c.spare[t >> 5], ~(1u << (t & 31u)), memory_order_relaxed);
  }
  sync();
  if (c.lane == 0) r.valCount[v] = r.base;
  sync();
}

// Sort list k ascending, in the pool (a bitonic sort padded to a power of two).
void sortList(thread const Ctx &c, threadgroup Rule &r, uint k) {
  uint count = r.keptCount[k], from = r.keptStart[k];
  uint n = 2;
  while (n < count) n <<= 1;
  if (c.lane == 0) r.start = allocate(c, n);
  sync();
  if (r.start == NONE) { if (c.lane == 0) r.empty = 1; sync(); return; }
  device uint *a = c.pool + r.start;
  for (uint x = c.lane; x < n; x += W) a[x] = x < count ? c.pool[from + x] : NONE;
  sync();
  for (uint size = 2; size <= n; size <<= 1)
    for (uint stride = size >> 1; stride > 0; stride >>= 1) {
      for (uint x = c.lane; x < n; x += W) {
        uint y = x ^ stride;
        if (y > x) {
          bool up = (x & size) == 0;
          uint p = a[x], q = a[y];
          if ((p > q) == up) { a[x] = q; a[y] = p; }
        }
      }
      sync();
    }
  if (c.lane == 0) r.keptStart[k] = r.start;
  sync();
}

kernel void trimRules(
  device const uint *s [[buffer(0)]], device const uint *rr [[buffer(1)]], device const uint *o [[buffer(2)]],
  device const uint *off0 [[buffer(3)]], device const uint *off1 [[buffer(4)]], device const uint *off2 [[buffer(5)]],
  device const uint *ord0 [[buffer(6)]], device const uint *ord1 [[buffer(7)]], device const uint *ord2 [[buffer(8)]],
  device const uint *plan [[buffer(9)]], device atomic_uint *bitsAll [[buffer(10)]], device uint *pool [[buffer(11)]],
  device Control *ctl [[buffer(12)]], device uint *outputs [[buffer(13)]], constant Params *prm [[buffer(14)]],
  uint tgid [[threadgroup_position_in_grid]],
  uint lane [[thread_index_in_simdgroup]], uint simd [[simdgroup_index_in_threadgroup]])
{
  threadgroup Rule rules[SIMDS];
  threadgroup Rule &r = rules[simd];
  Ctx c;
  c.col[0] = s; c.col[1] = rr; c.col[2] = o;
  c.off[0] = off0; c.off[1] = off1; c.off[2] = off2;
  c.ord[0] = ord0; c.ord[1] = ord1; c.ord[2] = ord2;
  c.pool = pool; c.ctl = ctl; c.prm = prm;
  c.bits = bitsAll + (ulong)(tgid * SIMDS + simd) * (prm->vmax + 1) * prm->words;
  c.spare = c.bits + (ulong)prm->vmax * prm->words;
  c.lane = lane;

  for (;;) {
    if (lane == 0) r.rule = atomic_fetch_add_explicit(&ctl->next, 1u, memory_order_relaxed);
    sync();
    uint rule = r.rule;
    if (rule >= prm->rules) break;
    if (lane == 0) {
      uint at = plan[rule];
      r.P = plan[at]; r.V = plan[at + 1]; r.empty = plan[at + 2]; r.first = plan[at + 3];
      for (uint k = 0; k < r.P; k++) for (uint i = 0; i < 3; i++) r.pat[k][i] = plan[at + 4 + k * 3 + i];
      for (uint v = 0; v < r.V; v++) {
        r.holders[v] = 0; r.valKnown[v] = 0; r.valCount[v] = 0;
        for (uint i = 0; i < 3; i++) r.sumState[v][i] = 0;
      }
      for (uint k = 0; k < r.P; k++) {
        r.slots[k] = 0; r.kept[k] = 0; r.keptCount[k] = 0; r.keptStart[k] = 0; r.keptSorted[k] = 1;
        for (uint i = 0; i < 3; i++) {
          uint a = r.pat[k][i];
          if (!(a & VAR)) continue;
          uint v = a & ~VAR;
          bool seen = false;
          for (uint j = 0; j < r.slots[k]; j++) if (r.slotV[k][j] == v) seen = true;
          if (seen) continue;
          r.slotI[k][r.slots[k]] = i; r.slotV[k][r.slots[k]] = v; r.slots[k]++;
          r.holderK[v][r.holders[v]] = k; r.holderI[v][r.holders[v]] = i; r.holders[v]++;
        }
      }
    }
    sync();
    // Patterns without a variable first, from their runs.
    for (uint k = 0; k < r.P && !r.empty; k++) {
      if (r.slots[k]) continue;
      uint own = prm->facts;
      for (uint i = 0; i < 3; i++) if (!(r.pat[k][i] & VAR)) own = min(own, runLength(c.off[i], r.pat[k][i]));
      materialize(c, r, k, NONE, own);
      if (lane == 0 && r.keptCount[k] == 0) r.empty = 1;
      sync();
    }
    // The rest, cheapest first: through its own run, or the index of a known
    // domain, whichever visits fewer facts.
    for (;;) {
      if (r.empty) break;
      uint left = 0;
      for (uint k = 0; k < r.P; k++) left += r.kept[k] ? 0u : 1u;
      if (!left) break;
      // As the CPU does: own runs first, then each known domain, a count
      // stopping once it cannot beat the best so far.
      uint best = PMAX, slot = NONE, cost = NONE;
      for (uint k = 0; k < r.P; k++) {
        if (r.kept[k]) continue;
        uint own = prm->facts;
        for (uint i = 0; i < 3; i++) if (!(r.pat[k][i] & VAR)) own = min(own, runLength(c.off[i], r.pat[k][i]));
        if (best == PMAX || own < cost) { best = k; slot = NONE; cost = own; }
        if (prm->dense) continue;
        for (uint j = 0; j < r.slots[k]; j++) {
          uint v = r.slotV[k][j], i = r.slotI[k][j];
          if (!r.valKnown[v]) continue;
          uint visits = visitsThrough(c, r, v, i, cost);
          if (visits < cost) { best = k; slot = i; cost = visits; }
        }
      }
      materialize(c, r, best, slot, cost);
      if (lane == 0 && r.keptCount[best] == 0) r.empty = 1;
      sync();
      if (!r.empty) for (uint j = 0; j < r.slots[best]; j++) narrow(c, r, r.slotV[best][j], best, r.slotI[best][j]);
    }
    // The greatest fixpoint: filter in place, in order, until nothing changes.
    for (;;) {
      if (r.empty) break;
      for (uint v = 0; v < r.V; v++) rebuild(c, r, v);
      bool changed = false;
      for (uint k = 0; k < r.P; k++) {
        if (lane == 0) r.base = 0;
        sync();
        uint count = r.keptCount[k], from = r.keptStart[k];
        for (uint chunk = 0; chunk < count; chunk += W) {
          uint x = chunk + lane;
          uint f = x < count ? pool[from + x] : 0;
          bool keep = x < count;
          if (keep) for (uint j = 0; j < r.slots[k]; j++)
            if (!member(bitsOf(c, r.slotV[k][j]), c.col[r.slotI[k][j]][f])) { keep = false; break; }
          uint at = compactSlot(keep, r, c);
          if (keep) pool[from + at] = f;
        }
        sync();
        if (r.base != r.keptCount[k]) changed = true;
        sync();
        if (lane == 0) r.keptCount[k] = r.base;
        sync();
      }
      if (!changed) break;
    }
    if (lane == 0) for (uint k = 0; k < r.P; k++) if (r.keptCount[k] == 0) r.empty = 1;
    sync();
    // Leave the bitsets empty for the next rule.
    for (uint v = 0; v < r.V; v++) {
      if (!r.valKnown[v]) continue;
      device atomic_uint *b = bitsOf(c, v);
      for (uint x = lane; x < r.valCount[v]; x += W) {
        uint t = pool[r.valStart[v] + x];
        atomic_fetch_and_explicit(&b[t >> 5], ~(1u << (t & 31u)), memory_order_relaxed);
      }
    }
    sync();
    if (!r.empty)
      for (uint k = 0; k < r.P; k++)
        if (!r.keptSorted[k] && r.keptCount[k] > 1) sortList(c, r, k);
    if (lane == 0) for (uint k = 0; k < r.P; k++) {
      outputs[(r.first + k) * 2] = r.keptStart[k];
      outputs[(r.first + k) * 2 + 1] = r.empty ? 0 : r.keptCount[k];
    }
    sync();
  }
}
"""

/// The pipeline, from the archive when one was made by this source.
func trimPipeline(_ device: MTLDevice, archivePath: String) throws -> (MTLComputePipelineState, Double, Bool) {
  let function = MTL4LibraryFunctionDescriptor()
  function.name = "trimRules"
  let descriptor = MTL4ComputePipelineDescriptor()
  descriptor.maxTotalThreadsPerThreadgroup = 256
  descriptor.threadGroupSizeIsMultipleOfThreadExecutionWidth = true
  let stamp = archivePath + ".source"
  let t = now()
  if FileManager.default.fileExists(atPath: archivePath),
    (try? String(contentsOfFile: stamp, encoding: .utf8)) == shaderSource
  {
    // The archive holds the binary; the library is still needed to name the function.
    let compilerDescriptor = MTL4CompilerDescriptor()
    let compiler = try device.makeCompiler(descriptor: compilerDescriptor)
    let library = MTL4LibraryDescriptor()
    library.source = shaderSource
    library.name = "trim"
    function.library = try compiler.makeLibrary(descriptor: library)
    descriptor.computeFunctionDescriptor = function
    let archive = try device.makeArchive(url: URL(fileURLWithPath: archivePath))
    let state = try archive.makeComputePipelineState(descriptor: descriptor)
    return (state, now() - t, true)
  }
  let serializerDescriptor = MTL4PipelineDataSetSerializerDescriptor()
  serializerDescriptor.configuration = .captureBinaries
  let compilerDescriptor = MTL4CompilerDescriptor()
  compilerDescriptor.pipelineDataSetSerializer = device.makePipelineDataSetSerializer(descriptor: serializerDescriptor)
  let compiler = try device.makeCompiler(descriptor: compilerDescriptor)
  let library = MTL4LibraryDescriptor()
  library.source = shaderSource
  library.name = "trim"
  function.library = try compiler.makeLibrary(descriptor: library)
  descriptor.computeFunctionDescriptor = function
  let state = try compiler.makeComputePipelineState(descriptor: descriptor)
  try? FileManager.default.removeItem(atPath: archivePath)
  try compilerDescriptor.pipelineDataSetSerializer!.serializeAsArchiveAndFlush(url: URL(fileURLWithPath: archivePath))
  try shaderSource.write(toFile: stamp, atomically: true, encoding: .utf8)
  return (state, now() - t, false)
}

func runMetal(_ c: Capture, _ index: Index, variant: String, warmup: Int, repeatCount: Int, report: (String, [[UInt32]], [Double], [String: Any]) -> Void) {
  let setupStarted = now()
  let device = MTLCreateSystemDefaultDevice()!
  let archivePath = (ProcessInfo.processInfo.environment["TRIM_ARCHIVE"] ?? "tmp/lean/trim.mtl4archive")
  let (pipeline, pipelineMs, fromArchive) = try! trimPipeline(device, archivePath: archivePath)
  let maxVars = c.rules.map { $0.vars }.max() ?? 1
  let maxPatterns = c.rules.map { $0.patterns.count }.max() ?? 1
  precondition(maxVars <= 8 && maxPatterns <= 16, "the kernel holds at most 8 variables and 16 patterns a rule")

  // The plan: per rule its offset, then P, V, missing, first pattern, patterns.
  var plan = [UInt32](repeating: 0, count: c.rules.count)
  var first = 0
  for (r, rule) in c.rules.enumerated() {
    plan[r] = UInt32(plan.count)
    plan.append(UInt32(rule.patterns.count))
    plan.append(UInt32(rule.vars))
    plan.append(rule.patterns.contains { $0.contains(MISSING) } ? 1 : 0)
    plan.append(UInt32(first))
    for p in rule.patterns { plan.append(contentsOf: p) }
    first += rule.patterns.count
  }
  let patterns = first

  // Buffers: what the CPU already holds is wrapped, not copied.
  let shared: MTLResourceOptions = [.storageModeShared, .hazardTrackingModeUntracked]
  let columnsBuffer = device.makeBuffer(bytesNoCopy: c.base, length: c.mappedBytes, options: shared, deallocator: nil)!
  let offsetBuffers = (0..<3).map { device.makeBuffer(bytesNoCopy: UnsafeMutableRawPointer(index.offsets[$0]), length: alignedBytes(c.terms + 1), options: shared, deallocator: nil)! }
  let orderBuffers = (0..<3).map { device.makeBuffer(bytesNoCopy: UnsafeMutableRawPointer(index.order[$0]), length: alignedBytes(c.facts), options: shared, deallocator: nil)! }
  let planBuffer = plan.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: shared)! }
  let words = (c.terms + 31) / 32
  // Persistent threadgroups: enough to fill the GPU, each with its own bitsets.
  let groups = Int(ProcessInfo.processInfo.environment["TRIM_GROUPS"] ?? "") ?? 64
  let bitsBytes = groups * 8 * (maxVars + 1) * words * 4
  let bitsBuffer = device.makeBuffer(length: bitsBytes, options: [.storageModePrivate, .hazardTrackingModeUntracked])!
  let poolCapacity = Int(ProcessInfo.processInfo.environment["TRIM_POOL"] ?? "") ?? 96_000_000
  let poolBuffer = device.makeBuffer(length: poolCapacity * 4, options: shared)!
  let controlBuffer = device.makeBuffer(length: 16, options: shared)!
  let outputBuffer = device.makeBuffer(length: max(8, patterns * 8), options: shared)!
  var params: [UInt32] = [UInt32(c.rules.count), UInt32(words), UInt32(c.facts), UInt32(c.terms), UInt32(poolCapacity), variant == "dense" ? 1 : 0, UInt32(maxVars)]
  let paramsBuffer = device.makeBuffer(bytes: &params, length: params.count * 4, options: shared)!

  let residencyDescriptor = MTLResidencySetDescriptor()
  residencyDescriptor.initialCapacity = 16
  let residency = try! device.makeResidencySet(descriptor: residencyDescriptor)
  for b in [columnsBuffer, planBuffer, bitsBuffer, poolBuffer, controlBuffer, outputBuffer, paramsBuffer] + offsetBuffers + orderBuffers { residency.addAllocation(b) }
  residency.commit()
  residency.requestResidency()
  let queue = device.makeMTL4CommandQueue()!
  queue.addResidencySet(residency)
  let allocator = device.makeCommandAllocator()!
  let tableDescriptor = MTL4ArgumentTableDescriptor()
  tableDescriptor.maxBufferBindCount = 15
  let table = try! device.makeArgumentTable(descriptor: tableDescriptor)
  for i in 0..<3 { table.setAddress(columnsBuffer.gpuAddress + UInt64(i * c.columnBytes), index: i) }
  for i in 0..<3 { table.setAddress(offsetBuffers[i].gpuAddress, index: 3 + i); table.setAddress(orderBuffers[i].gpuAddress, index: 6 + i) }
  table.setAddress(planBuffer.gpuAddress, index: 9)
  table.setAddress(bitsBuffer.gpuAddress, index: 10)
  table.setAddress(poolBuffer.gpuAddress, index: 11)
  table.setAddress(controlBuffer.gpuAddress, index: 12)
  table.setAddress(outputBuffer.gpuAddress, index: 13)
  table.setAddress(paramsBuffer.gpuAddress, index: 14)

  // The bitsets start empty once; every rule leaves them empty.
  do {
    let commands = device.makeCommandBuffer()!
    commands.beginCommandBuffer(allocator: allocator)
    let encoder = commands.makeComputeCommandEncoder()!
    encoder.fill(buffer: bitsBuffer, range: 0..<bitsBytes, value: 0)
    encoder.endEncoding()
    commands.endCommandBuffer()
    let done = DispatchSemaphore(value: 0)
    let options = MTL4CommitOptions()
    options.addFeedbackHandler { _ in done.signal() }
    queue.commit([commands], options: options)
    done.wait()
  }

  let setupMs = now() - setupStarted
  var walls: [Double] = [], gpus: [Double] = []
  var lists: [[UInt32]] = []
  for run in 0..<(warmup + repeatCount) {
    let wall = now()
    memset(controlBuffer.contents(), 0, 16)
    allocator.reset()
    let commands = device.makeCommandBuffer()!
    commands.beginCommandBuffer(allocator: allocator)
    let encoder = commands.makeComputeCommandEncoder()!
    encoder.setComputePipelineState(pipeline)
    encoder.setArgumentTable(table)
    encoder.dispatchThreadgroups(threadgroupsPerGrid: MTLSize(width: groups, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
    encoder.endEncoding()
    commands.endCommandBuffer()
    let done = DispatchSemaphore(value: 0)
    let options = MTL4CommitOptions()
    var gpu = 0.0
    var failure: Error? = nil
    options.addFeedbackHandler { feedback in
      gpu = (feedback.gpuEndTime - feedback.gpuStartTime) * 1000
      failure = feedback.error
      done.signal()
    }
    queue.commit([commands], options: options)
    done.wait()
    if let failure { fatalError("GPU error: \(failure)") }
    let control = controlBuffer.contents().bindMemory(to: UInt32.self, capacity: 4)
    if control[2] != 0 { fatalError("the pool of \(poolCapacity) words ran out; set TRIM_POOL") }
    // Read the lists out in pattern order.
    let out = outputBuffer.contents().bindMemory(to: UInt32.self, capacity: patterns * 2)
    let pool = poolBuffer.contents().bindMemory(to: UInt32.self, capacity: poolCapacity)
    lists = (0..<patterns).map { k in Array(UnsafeBufferPointer(start: pool + Int(out[k * 2]), count: Int(out[k * 2 + 1]))) }
    if run >= warmup {
      walls.append(now() - wall)
      gpus.append(gpu)
    }
  }
  let used = controlBuffer.contents().bindMemory(to: UInt32.self, capacity: 4)[1]
  var extra: [String: Any] = [
    "gpuMs": gpus.map { ($0 * 1000).rounded() / 1000 },
    "pipelineMs": (pipelineMs * 100).rounded() / 100, "pipelineFromArchive": fromArchive,
    "setupMs": (setupMs * 100).rounded() / 100,
    "groups": groups, "poolWords": poolCapacity, "poolWordsUsed": Int(used), "bitsetBytes": bitsBytes,
    "device": device.name,
  ]
  if !gpus.isEmpty { extra["gpuMedianMs"] = (median(gpus) * 1000).rounded() / 1000 }
  report("metal-\(variant)", lists, walls, extra)
}
#endif

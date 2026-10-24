# Lean core: trimming on the GPU, a fair test

What Metal gives for trimming a module's rules against its fact store, measured
against the best CPU versions known, every output compared with an oracle.
Apple M5 Pro (6 Super and 12 Performance cores, 48 GB), macOS 26.7.1, Swift
6.4, Node 25.9, 2026-10-25. Report: `reports/trim-2026-10-25.json`; the raw
output is at the end.

A benchmark, not part of Tendora: nothing in `src/` imports it, and it is not
run by `npm run check` or CI (it needs macOS, Metal and a Corpus P copy).

## The trim

For every rule, each of its patterns keeps the facts that can still take part
in a match of the whole rule, by arc consistency: a fact survives when it fits
the pattern's constants and repeated variables, and every value it gives a
variable is one that every other pattern holding that variable also gives from
its own survivors; repeated to the greatest fixpoint. A rule with a pattern
left empty keeps nothing. Injectivity is not trimmed. Output: per pattern, the
surviving fact positions in ascending order.

Against the engine (`check-engine.mjs`): on Corpus P repeated 1, 4, 16 and 64
times, the trim keeps exactly the facts the engine's matches use (64×: 1,792
of 26.9 million candidates, 512 of 832 rules matching), and the engine's
grammar matcher over only those facts gives the same matches. Trimming leaves
the join almost nothing to do; that is the largest result here, and it holds
on any device.

## The workload

`capture.mjs` writes a scaled Corpus P base's store columns and the bodies of the
rules inference matches against it:

| capture | facts     | terms     | rules | patterns | how                                   |
| ------- | --------- | --------- | ----- | -------- | ------------------------------------- |
| 16×     | 140,960   | 35,323    | 208   | 1,280    | built by the engine                   |
| 64×     | 563,840   | 138,427   | 832   | 5,120    | built by the engine                   |
| 9.0M    | 9,021,440 | 1,959,547 | 832   | 5,120    | the 64× store repeated 16×, occurrence terms renumbered; not built by the engine |

Every pattern fixes its role; a rule has at most 13 patterns and 5 variables.
Repeating Corpus P repeats its rules too; no version exploits that.

## Versions

- `js-oracle` (`trim.mjs --oracle`): every pattern from its narrowest run,
  domains as Sets; written to be read.
- `js-fast` (`trim.mjs`): patterns reached cheapest first, through their own
  run or through the index of a variable whose domain is already finite;
  domains marked in tagged arrays, narrowed as each holder arrives.
- `swift-cpu-N` (`trim cpu`): the same algorithm in Swift, domains as bitsets,
  rules taken from a counter by N threads (18 is the fastest; 6: 42.8 ms, 12:
  29.2 ms at 9M).
- `metal-index` (`trim metal`): the same algorithm on the GPU, one SIMD group
  per rule, about 512 in flight, taking rules from a counter. Metal 4 queue,
  allocator, argument table and residency set; the columns and the index
  wrapped without copying (the capture's mapped pages, page-aligned arrays);
  the pipeline loaded from a Metal 4 archive. A list read from a run is
  written in one pass in its order (SIMD-group prefix sums); a list reached
  through a domain is spread evenly over the lanes and sorted at the end.
- `metal-dense` (`trim metal --variant dense`): the same kernel with every
  pattern read from its own run: the cuckoo-style dense trim.

## Exactness

Every output is byte-identical to the oracle's at all three sizes (the 9M oracle
takes 55 s), in every round. Engine cross-check at 1×, 4×, 16× and 64×.

## Results

The trim alone, its index and inputs in memory; medians over three interleaved
rounds (JS 21 runs, CPU 21 to 63, Metal 45 to 93). GPU: the command buffer's
own time; wall adds the commit, the wait and reading the lists out.

| facts     | js-fast | swift 1 thread | swift 18 threads | metal-index GPU (wall) | metal-dense GPU |
| --------- | ------- | -------------- | ---------------- | ---------------------- | --------------- |
| 140,960   | 7.7 ms  | 0.61 ms        | 0.33 ms          | 0.50 (0.69) ms         | 0.70 ms         |
| 563,840   | 27 ms   | 6.3 ms         | 1.13 ms          | 0.43 (0.76) ms         | 1.82 ms         |
| 9,021,440 | 935 ms  | 191 ms         | 26.5 ms          | 11.6 (11.9) ms         | 32.9 ms         |

Once per process: the index, 40 ms at 9M on one CPU thread; Metal setup 24 to
80 ms, of which the pipeline from its archive is 0.9 ms (150 to 180 ms
compiled), and the rest device, queue and residency, the bitsets (750 MB at 9M)
and the pool (the benchmark's 1.6 GB is sized for the dense variant; the index
variant uses 36 M words at 9M).

The ceiling (`gather.swift`): random 4-byte reads from a 144 MB array reach
1.8 G/s on the CPU (12 threads; 18 give 1.6) and 3.5 G/s on the GPU. The trim is such reads into the columns and the
index; the GPU's 2.2× over 18 threads at 9M is that ratio.

## What it says

- At Corpus P's sizes, up to 564k facts, the GPU gives nothing worth a native
  bridge: 18 CPU threads trim in 0.3 to 1.1 ms, the GPU in 0.4 to 0.5 ms plus
  about 0.3 ms to submit and read back.
- At 9 million facts the GPU is 2.2× the best CPU (12 against 26 ms): the
  hardware's ratio for random reads on unified memory. The dense trim loses to
  the index-driven one on the GPU (33 ms) and to the CPU.
- The trim is the lever, not the device: it keeps exactly the matches'
  facts, in 8 to 27 ms in JS at Corpus P's sizes, while the engine's joins take
  seconds at scale. A trim before the join belongs in the engine first, in
  JS; native code is 4 to 13× faster on one thread; the GPU is about 2× more
  than every CPU core, at millions of facts.
- M6: Metal wraps page-aligned memory without copying (shown here with mapped
  file pages and `posix_memalign` arrays). If the GPU path is taken, the
  store's columns must be allocated that way (mapped column files, or native
  memory exposed to JS), not as ordinary SharedArrayBuffers. At about 2× this
  does not decide the allocation now; it can wait until the core goes native.

## Best known: yes, with these shortcuts

On both sides: `fits` reads all three columns, though the run's own column is
known; a (term, role) index would visit fewer facts; the rules a copy repeats
are trimmed again. CPU: `-O` with exclusivity checks off (`-Ounchecked`
crashed and was not investigated). GPU: each SIMD group's slot holds a bitset
over every term per variable (1.5 MB at 9M), so more than about 512 in flight
thrash the cache; a compressed or hashed domain could allow more; the index is
built on the CPU; the forward-progress pipeline options need macOS 27. Tried
and kept though they changed nothing measurable: testing a bit before setting
it atomically; spreading a domain's runs evenly over the lanes. Not tried:
decoupled look-back scans (Apple GPUs give no forward-progress guarantee
between threadgroups), Metal 4 machine-learning encoders (not a fit).

The prototype this replaces (one semijoin on synthetic data, an unordered
atomic compaction, columns copied, the shader compiled every run) is in the
history at `6e89809`.

## Regenerating the captures

The captures come from `tmp/corpus-p-dream`: a copy of `.proj/corpus-p` at revision
`d1b723ad3c91` (Shared making v2, 209 statements; the working tree's Corpus P on
2026-10-25) holding a saved check of "Who brings intention to the shared
work?". To make one: copy the project, ask that question once (the question
needs a reading from the local eGemma service unless one is retained), and
pass `--project` to `capture.mjs` and `check-engine.mjs` if it lives
elsewhere. A capture of the same revision is the same, byte for byte (16×,
checked after the move to `bench/`).

```sh
node bench/lean-core/capture.mjs 16 tmp/lean/k16
node bench/lean-core/capture.mjs 64 tmp/lean/k64
node --max-old-space-size=16000 bench/lean-core/capture.mjs 64 tmp/lean/k64x16 --replicate 16
node --max-old-space-size=30000 bench/lean-core/trim.mjs tmp/lean/k64x16 --oracle --out tmp/lean/k64x16/oracle.bin
node bench/lean-core/check-engine.mjs 16
node bench/lean-core/bench.mjs --rounds 3 --out bench/lean-core/reports/<name>.json tmp/lean/k16 tmp/lean/k64 tmp/lean/k64x16
```

`bench.mjs` builds `tmp/lean/trim` (`swiftc -O -enforce-exclusivity=unchecked
-swift-version 5 TrimCore.swift TrimMetal.swift main.swift`); the Metal
archive is kept at `tmp/lean/trim.mtl4archive` and made again when the shader
changes. The ceiling: `swiftc -O bench/lean-core/gather.swift -o
tmp/lean/gather && tmp/lean/gather`.

## Open questions about the CPU baseline

- **Core types.** The 18 threads mix 6 Super cores (16 MB L2) and 12
  Performance cores (8 MB L2). Rules come from a shared counter, so slower
  cores take fewer, but no QoS class was set and macOS gives no affinity. At
  9M: 6 threads 42.8 ms, 12 29.2, 18 26.9. Whether another split or QoS would
  lower the best CPU figure was not measured.
- **NEON.** The CPU loops are scalar Swift, without NEON intrinsics. NEON has
  no gather, and the trim's time is in random reads (1.8 G/s at best here), so
  vectorizing the compare-and-compact steps may gain little; not measured.
  Nor were C with explicit prefetching, or `-Ounchecked` (it crashed; not
  investigated).
- **Allocation.** Each CPU trim allocates its threads' bitsets (1.5 MB a
  thread at 9M) and the JS trim its mark arrays; the GPU's are allocated once,
  in setup. Inside the CPU figures; small against them, not measured apart.

## Raw output

Every line below is copied from the runs that produced the figures above.
The final benchmark's per-round log was removed when `tmp/` was tidied; the
report keeps each version's median, p10, p90, minimum and run count.

Benchmark summary (`bench.mjs --rounds 3`):

```
k16        140960 js-fast        median     7.70 ms (p10 2.93, p90 8.87)  equal to oracle
k16        140960 swift-cpu-1    median     0.61 ms (p10 0.58, p90 0.96)  equal to oracle
k16        140960 swift-cpu-18   median     0.33 ms (p10 0.26, p90 0.54)  equal to oracle
k16        140960 metal-index    median     0.69 ms (GPU 0.50, p10 0.11, p90 0.51)  equal to oracle
k16        140960 metal-dense    median     0.91 ms (GPU 0.70, p10 0.36, p90 0.71)  equal to oracle
k64        563840 js-fast        median    27.10 ms (p10 26.46, p90 39.49)  equal to oracle
k64        563840 swift-cpu-1    median     6.28 ms (p10 6.12, p90 6.43)  equal to oracle
k64        563840 swift-cpu-18   median     1.13 ms (p10 1.09, p90 1.17)  equal to oracle
k64        563840 metal-index    median     0.76 ms (GPU 0.43, p10 0.42, p90 0.82)  equal to oracle
k64        563840 metal-dense    median     2.09 ms (GPU 1.82, p10 1.81, p90 1.83)  equal to oracle
k64x16    9021440 js-fast        median   934.87 ms (p10 910.98, p90 1032.46)  equal to oracle
k64x16    9021440 swift-cpu-1    median   191.35 ms (p10 187.73, p90 200.64)  equal to oracle
k64x16    9021440 swift-cpu-18   median    26.45 ms (p10 25.65, p90 27.19)  equal to oracle
k64x16    9021440 metal-index    median    11.87 ms (GPU 11.57, p10 11.54, p90 11.77)  equal to oracle
k64x16    9021440 metal-dense    median    33.22 ms (GPU 32.91, p10 32.78, p90 33.06)  equal to oracle
```

The oracle at 9M, and the engine cross-checks (`check-engine.mjs`):

```
{"version":"js-oracle","facts":9021440,"rules":832,"patterns":5120,"candidates":430777792,"kept":1792,"indexMs":51.44,"trimMs":[55342.33]}
9M: js-fast == oracle
{"copies":1,"facts":8810,"rules":13,"rulesWithMatches":8,"witnesses":28,"kept":28,"ok":true}
{"copies":4,"facts":35240,"rules":52,"rulesWithMatches":32,"witnesses":112,"kept":112,"ok":true}
{"copies":16,"facts":140960,"rules":208,"rulesWithMatches":128,"witnesses":448,"kept":448,"ok":true}
{"copies":64,"facts":563840,"rules":832,"rulesWithMatches":512,"witnesses":1792,"kept":1792,"ok":true}
```

CPU threads (`trim cpu --warmup 5 --repeat 21`, medians in ms):

```
k64 threads 6 1.95
k64x16 threads 6 42.78
k64 threads 12 1.39
k64x16 threads 12 29.17
k64 threads 18 1.18
k64x16 threads 18 26.91
```

The ceiling (`gather.swift`, two runs):

```
cpu 1 threads: 49.79 ms, 0.32 G gathers/s      cpu 1 threads: 49.00 ms, 0.33 G gathers/s
cpu 6 threads: 11.48 ms, 1.39 G gathers/s      cpu 6 threads: 11.36 ms, 1.41 G gathers/s
cpu 12 threads: 8.86 ms, 1.80 G gathers/s      cpu 12 threads: 8.80 ms, 1.82 G gathers/s
cpu 18 threads: 9.99 ms, 1.60 G gathers/s      cpu 18 threads: 9.94 ms, 1.61 G gathers/s
gpu 65536 threads: 4.57 ms, 3.50 G gathers/s   gpu 65536 threads: 4.53 ms, 3.54 G gathers/s
gpu 262144 threads: 4.53 ms, 3.53 G gathers/s  gpu 262144 threads: 4.53 ms, 3.53 G gathers/s
gpu 1048576 threads: 4.53 ms, 3.53 G gathers/s gpu 1048576 threads: 4.51 ms, 3.55 G gathers/s
```

Metal setup against the pool's size (ms; the pool in words):

```
pool 8000000 k64 setup 24.53 pipeline 0.95 bitset MB 53 gpu 1.824
pool 8000000 k64x16: trim/TrimMetal.swift:624: Fatal error: the pool of 8000000 words ran out; set TRIM_POOL
pool 40000000 k64 setup 24.34 pipeline 0.9 bitset MB 53 gpu 0.438
pool 40000000 k64x16 setup 52.72 pipeline 0.84 bitset MB 752 gpu 11.618
pool 400000000 k64 setup 52.02 pipeline 0.9 bitset MB 53 gpu 0.444
pool 400000000 k64x16 setup 79.69 pipeline 1 bitset MB 752 gpu 11.715
```

How the versions got here, at 9M (medians from single runs during
development; each step's output equal to the reference before it was kept):

```
swift 18 threads: tagged marks 58.5 → no exclusivity checks, raw loops 43.2 → bitset domains 31.5 → narrowed domains 26.6
swift 1 thread:   tagged marks 438  → no exclusivity checks, raw loops 256  → bitset domains 229  → narrowed domains 191
metal (GPU):      a threadgroup per rule 25.1 → a SIMD group per rule 19.3 to 22.7
                  → bit tested before set 19.4 to 20.8 (no change) → runs spread over lanes 21.3 (no change)
                  → cost counts capped as on the CPU 20.8 to 20.9 (no change) → one pass 17.0 → narrowed domains 11.6
metal dense:      147.6 → 61.2 (SIMD group per rule) → 35.7 (one pass) → 32.9
```

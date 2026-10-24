/** Every version of the trim on every capture, interleaved, each output
 * compared byte for byte with the reference (the oracle's, where it was run).
 *
 *   node bench/lean-core/bench.mjs [--rounds n] [--out report.json] <capture-dir>...
 *
 * Each round runs every version once per capture, as a fresh process with its
 * own warm-up, so drift in clocks or temperature falls on all of them alike.
 * Times are the trim alone, the index and the inputs already in memory; the
 * Metal setup (pipeline from its archive, wrapping, residency) is reported
 * apart. GPU times are the command buffer's own; wall times add the commit, the
 * wait and reading the lists out.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, release } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args.splice(at, 2)[1];
};
const rounds = Number(flag('--rounds') ?? 3);
const outPath = flag('--out');
const captures = args.map((dir) => resolve(dir));
const binary = join(repo, 'tmp/lean/trim');
const source = join(repo, 'bench/lean-core');
const swiftFlags = ['-O', '-enforce-exclusivity=unchecked', '-swift-version 5'];
execFileSync(
  'swiftc',
  [
    ...swiftFlags.flatMap((f) => f.split(' ')),
    '-o',
    binary,
    ...['TrimCore.swift', 'TrimMetal.swift', 'main.swift'].map((f) => join(source, f)),
  ],
  { stdio: 'inherit' },
);
const threads = availableParallelism();
const versions = [
  {
    name: 'js-fast',
    run: (dir, out) => [
      'node',
      [
        '--max-old-space-size=16000',
        join(source, 'trim.mjs'),
        dir,
        '--warmup',
        '3',
        '--repeat',
        '7',
        '--out',
        out,
      ],
    ],
  },
  {
    name: 'swift-cpu-1',
    run: (dir, out) => [
      binary,
      ['cpu', dir, '--threads', '1', '--warmup', '2', '--repeat', '7', '--out', out],
    ],
  },
  {
    name: `swift-cpu-${threads}`,
    run: (dir, out) => [
      binary,
      ['cpu', dir, '--threads', String(threads), '--warmup', '5', '--repeat', '21', '--out', out],
    ],
  },
  {
    name: 'metal-index',
    run: (dir, out) => [
      binary,
      ['metal', dir, '--variant', 'index', '--warmup', '10', '--repeat', '31', '--out', out],
    ],
  },
  {
    name: 'metal-dense',
    run: (dir, out) => [
      binary,
      ['metal', dir, '--variant', 'dense', '--warmup', '5', '--repeat', '15', '--out', out],
    ],
  },
];
const env = {
  ...process.env,
  TRIM_POOL: '400000000',
  TRIM_ARCHIVE: join(repo, 'tmp/lean/trim.mtl4archive'),
};
const results = {};
for (let round = 0; round < rounds; round++)
  for (const dir of captures) {
    const reference = existsSync(join(dir, 'oracle.bin')) ? join(dir, 'oracle.bin') : null;
    for (const version of versions) {
      const out = join(dir, `bench-${version.name}.bin`);
      const [command, argv] = version.run(dir, out);
      const line = execFileSync(command, argv, { env, encoding: 'utf8', maxBuffer: 1 << 26 })
        .trim()
        .split('\n')
        .at(-1);
      const report = JSON.parse(line);
      const key = `${dir}\u0000${version.name}`;
      const entry = (results[key] ??= {
        capture: dir,
        version: version.name,
        times: [],
        gpu: [],
        wall: [],
        equal: true,
        reference: reference ? 'oracle' : 'js-fast',
      });
      entry.times.push(...(report.trimMs ?? []));
      if (report.gpuMs) entry.gpu.push(...report.gpuMs);
      entry.facts = report.facts;
      entry.kept = report.kept;
      if (report.setupMs !== undefined) entry.setupMs = report.setupMs;
      if (report.pipelineFromArchive !== undefined)
        entry.pipelineFromArchive = report.pipelineFromArchive;
      const against = reference ?? join(dir, 'bench-js-fast.bin');
      if (!readFileSync(out).equals(readFileSync(against))) entry.equal = false;
      console.error(
        `round ${round + 1} ${version.name} ${dir.split('/').at(-1)}: ${report.medianMs} ms${report.gpuMedianMs ? `, GPU ${report.gpuMedianMs} ms` : ''}`,
      );
    }
  }
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { median: q(0.5), p10: q(0.1), p90: q(0.9), min: s[0], runs: s.length };
};
const summary = Object.values(results).map((e) => ({
  capture: e.capture.split('/').at(-1),
  facts: e.facts,
  version: e.version,
  kept: e.kept,
  equalToReference: e.equal,
  reference: e.reference,
  ms: stats(e.times),
  ...(e.gpu.length ? { gpuMs: stats(e.gpu) } : {}),
  ...(e.setupMs !== undefined
    ? { setupMs: e.setupMs, pipelineFromArchive: e.pipelineFromArchive }
    : {}),
}));
const report = {
  profile: 'lean-core-trim-bench-v1',
  at: new Date().toISOString(),
  machine: { cpu: cpus()[0].model, threads, os: release() },
  swift: execFileSync('swiftc', ['--version'], { encoding: 'utf8' }).split('\n')[0],
  swiftFlags,
  node: process.version,
  rounds,
  captures: captures.map((dir) => JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))),
  summary,
};
if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
for (const row of summary)
  console.log(
    `${row.capture.padEnd(8)} ${String(row.facts).padStart(8)} ${row.version.padEnd(14)} median ${row.ms.median.toFixed(2).padStart(8)} ms` +
      (row.gpuMs
        ? ` (GPU ${row.gpuMs.median.toFixed(2)}, p10 ${row.gpuMs.p10.toFixed(2)}, p90 ${row.gpuMs.p90.toFixed(2)})`
        : ` (p10 ${row.ms.p10.toFixed(2)}, p90 ${row.ms.p90.toFixed(2)})`) +
      `  ${row.equalToReference ? 'equal' : 'DIFFERENT'} to ${row.reference}`,
  );

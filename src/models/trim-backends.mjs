/** Trim backends: where inference's trim runs (src/amr/trim.mjs).
 *
 *   js     in this process; the default, everywhere
 *   swift  the trim compiled from src/models/native (Swift, every CPU thread)
 *   metal  the same program on the GPU (Metal 4)
 *   auto   js below `nativeFrom` facts, then the fastest native backend here
 *
 * Swift and Metal need macOS and the Swift toolchain (`xcode-select
 * --install`); Metal also an Apple GPU with Metal 4. The native program is
 * built on first use into .deps/native, named by the digest of its sources,
 * flags and compiler, and runs once per trim over a capture written to a
 * temporary directory. Starting it costs tens of milliseconds, so it pays only
 * on large stores: every check's inference is bounded far below `nativeFrom`
 * today, and `auto` then chooses js. Every backend's output is the same.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISSING, checkCapture, decodeTrim, trimFast, useTrim } from '../amr/trim.mjs';

export const trimBackends = ['js', 'swift', 'metal', 'auto'];
// Where a native backend starts to pay: the trim in JS takes about 20 ms at
// 141k facts and 290 ms at 567k; starting the program, 10 to 80 ms
// (bench/lean-core).
export const nativeFrom = 250_000;

const repo = fileURLToPath(new URL('../../', import.meta.url));
const sources = ['TrimCore.swift', 'TrimMetal.swift', 'main.swift'].map((name) =>
  join(repo, 'src/models/native', name),
);
const flags = ['-O', '-enforce-exclusivity=unchecked', '-swift-version', '5'];
const swiftc = () => process.env.TENDORA_SWIFTC || 'swiftc';
const unavailable = (name, reason) =>
  Object.assign(new Error(`The ${name} backend is not available here: ${reason}`), {
    code: 'BACKEND_UNAVAILABLE',
    reason,
  });

let toolchain;
/** The Swift compiler on this machine, or why there is none. */
function compiler() {
  if (toolchain) return toolchain;
  if (process.platform !== 'darwin')
    return (toolchain = { reason: `it needs macOS, and this is ${process.platform}` });
  const found = spawnSync(swiftc(), ['--version'], { encoding: 'utf8' });
  if (found.error || found.status !== 0)
    return (toolchain = {
      reason: 'it needs the Swift toolchain (xcode-select --install)',
    });
  const version = `${found.stdout}${found.stderr}`.match(/Swift version [\d.]+/u)?.[0] ?? 'Swift';
  return (toolchain = { version });
}

const builds = new Map();
/** The native program for a backend, built once; or why it cannot be. */
export function nativeProgram(kind) {
  return program(kind);
}
function program(kind) {
  if (builds.has(kind)) return builds.get(kind);
  const tool = compiler();
  if (tool.reason) return builds.set(kind, { reason: tool.reason }).get(kind);
  const options = [...flags, ...(kind === 'metal' ? ['-D', 'TRIM_METAL'] : [])];
  const digest = createHash('sha256')
    .update(JSON.stringify([tool.version, options]))
    .update(Buffer.concat(sources.map((path) => readFileSync(path))))
    .digest('hex')
    .slice(0, 16);
  const directory = join(repo, '.deps/native', digest);
  const binary = join(directory, `trim-${kind}`);
  const built = { binary, archive: join(directory, 'trim.mtl4archive'), version: tool.version };
  if (!existsSync(binary)) {
    mkdirSync(directory, { recursive: true });
    // Built beside its name and renamed: a concurrent build never runs half a file.
    const staged = `${binary}.${process.pid}.tmp`;
    const compiled = spawnSync(swiftc(), [...options, '-o', staged, ...sources], {
      encoding: 'utf8',
    });
    if (compiled.status !== 0) {
      rmSync(staged, { force: true });
      const first = `${compiled.stderr ?? ''}${compiled.error?.message ?? ''}`
        .split('\n')
        .find((line) => /error/u.test(line));
      return builds
        .set(kind, {
          reason: `the native trim did not build (${first?.trim() ?? 'swiftc failed'})`,
        })
        .get(kind);
    }
    renameSync(staged, binary);
  }
  return builds.set(kind, built).get(kind);
}

// How long one native trim may run before the check gives it up.
const nativeTimeout = 300_000;
let scratch;
/** A capture as the native program reads it: page-aligned u32 columns, the
 * rules, and their counts (bench/lean-core/capture.mjs). One scratch directory
 * a thread is enough: a trim is written, run and read back synchronously, and
 * each worker thread has its own. */
function writeCapture(capture) {
  scratch ??= mkdtempSync(join(tmpdir(), 'tendora-trim-'));
  const page = 16384,
    columnBytes = Math.max(page, Math.ceil((capture.facts * 4) / page) * page);
  const columns = new Uint32Array((3 * columnBytes) / 4);
  // A column longer than its facts is read up to them, as the JavaScript trim
  // reads it.
  capture.columns.forEach((column, c) =>
    columns.set(column.subarray(0, capture.facts), (c * columnBytes) / 4),
  );
  writeFileSync(join(scratch, 'columns.bin'), columns);
  const words = [capture.rules.length];
  for (const rule of capture.rules) {
    words.push(rule.patterns.length, rule.vars);
    for (const pattern of rule.patterns) words.push(...pattern);
  }
  writeFileSync(join(scratch, 'rules.bin'), Uint32Array.from(words));
  writeFileSync(
    join(scratch, 'meta.json'),
    JSON.stringify({ facts: capture.facts, terms: capture.terms, columnBytes, page }),
  );
  return scratch;
}
process.on('exit', () => scratch && rmSync(scratch, { recursive: true, force: true }));

const missingIn = (rule) => rule.patterns.some((pattern) => pattern.includes(MISSING));

/** A capture without the rules that name a constant the store lacks, and how
 * to put their lists back: such a rule keeps nothing, on every backend, and
 * the native program never sees it. */
export function withoutMissing(capture) {
  const sent = { ...capture, rules: capture.rules.filter((rule) => !missingIn(rule)) };
  const restore = (lists) => {
    const out = [];
    let at = 0;
    for (const rule of capture.rules)
      for (let k = 0; k < rule.patterns.length; k++)
        out.push(missingIn(rule) ? new Uint32Array(0) : lists[at++]);
    return out;
  };
  return { sent, restore };
}

/** Why the Metal kernel cannot take these rules, or null: it holds at most 8
 * variables and 16 patterns a rule (TrimMetal.swift); Swift and JavaScript
 * take any. */
export function metalLimit(rules) {
  const over = rules.find(
    (rule) => !missingIn(rule) && (rule.vars > 8 || rule.patterns.length > 16),
  );
  return over
    ? `a rule has ${over.vars} variables and ${over.patterns.length} patterns, and Metal holds at most 8 variables and 16 patterns a rule`
    : null;
}

/** A trim run by the native program. */
function nativeTrim(kind) {
  const built = program(kind);
  if (built.reason) throw unavailable(kind, built.reason);
  const threads = availableParallelism();
  const trim = (capture) => {
    checkCapture(capture);
    const { sent, restore } = withoutMissing(capture);
    if (!sent.rules.length) return restore([]);
    const over = kind === 'metal' && metalLimit(sent.rules);
    if (over) throw unavailable(kind, over);
    const directory = writeCapture(sent),
      out = join(directory, 'out.bin');
    // The GPU lists its kept facts in one pool; a pool too small is retried larger.
    for (let pool = Math.max(1 << 20, capture.facts * 4); ; pool *= 4) {
      const ran = spawnSync(
        built.binary,
        kind === 'metal'
          ? ['metal', directory, '--variant', 'packed', '--repeat', '1', '--out', out]
          : ['cpu', directory, '--threads', String(threads), '--repeat', '1', '--out', out],
        {
          encoding: 'utf8',
          env: { ...process.env, TRIM_POOL: String(pool), TRIM_ARCHIVE: built.archive },
          // A trim takes well under a second; one that hangs fails the check.
          timeout: nativeTimeout,
        },
      );
      if (ran.error?.code === 'ETIMEDOUT')
        throw unavailable(kind, `it ran longer than ${nativeTimeout / 1000} seconds`);
      if (ran.status === 0) {
        try {
          trim.report = JSON.parse(ran.stdout.trim().split('\n').at(-1));
        } catch {
          // A report that does not parse is the program's fault, like output
          // that does not fit: never retried elsewhere (GPU recheck, #4).
          throw Object.assign(unavailable(kind, 'its report was not JSON'), {
            invalidOutput: true,
          });
        }
        // Output that does not fit the capture fails the check; it is never
        // read as a trim that kept nothing, nor retried elsewhere.
        try {
          return restore(decodeTrim(readFileSync(out), sent));
        } catch (error) {
          throw Object.assign(unavailable(kind, error.message), { invalidOutput: true });
        }
      }
      if (kind === 'metal' && /pool .* ran out/u.test(ran.stderr) && pool < 1 << 30) continue;
      throw unavailable(
        kind,
        (
          ran.stderr ||
          ran.error?.message ||
          (ran.signal ? `it stopped on ${ran.signal}` : `it exited ${ran.status}`)
        ).trim(),
      );
    }
  };
  return trim;
}

const detected = new Map();
/** Whether a native backend runs here: built, and checked on a small capture. */
function works(kind) {
  if (detected.has(kind)) return detected.get(kind);
  let found;
  try {
    const trim = nativeTrim(kind);
    const probe = {
      columns: [Uint32Array.of(0, 2), Uint32Array.of(1, 1), Uint32Array.of(2, 3)],
      rules: [{ vars: 2, patterns: [[0x80000000, 1, 0x80000001]] }],
      facts: 2,
      terms: 4,
    };
    const kept = trim(probe);
    found =
      kept.length === 1 && kept[0].length === 2
        ? { available: true, trim }
        : { available: false, reason: 'its output differed from the JavaScript trim' };
  } catch (error) {
    found = { available: false, reason: error.reason ?? error.message };
  }
  detected.set(kind, found);
  return found;
}

/** The backend `auto` chooses for a store of `facts` and its rules, given
 * what works here: never Metal for a rule larger than it holds. */
export function chooseBackend(facts, available = (kind) => works(kind).available, rules = []) {
  if (facts < nativeFrom) return 'js';
  return (
    ['metal', 'swift'].find(
      (kind) => (kind !== 'metal' || !metalLimit(rules)) && available(kind),
    ) ?? 'js'
  );
}

/** A backend's trim; an unknown or unavailable one is refused with why. */
export function trimBackend(name = 'js') {
  if (!trimBackends.includes(name))
    throw Object.assign(
      new Error(`Unknown trim backend: ${name}. Choose ${trimBackends.join(', ')}.`),
      {
        code: 'BACKEND_UNKNOWN',
      },
    );
  if (name === 'js') return trimFast;
  if (name === 'auto')
    return (capture) => {
      checkCapture(capture);
      // The fastest here; a native one that fails as it runs (its device, its
      // memory) hands the trim to the next, Swift then JavaScript, which give
      // the same lists. Output that does not fit is a fault, never retried.
      let chosen = chooseBackend(capture.facts, undefined, capture.rules);
      for (;;) {
        if (chosen === 'js') return trimFast(capture);
        try {
          return works(chosen).trim(capture);
        } catch (error) {
          if (error.code !== 'BACKEND_UNAVAILABLE' || error.invalidOutput) throw error;
          chosen = chosen === 'metal' && works('swift').available ? 'swift' : 'js';
        }
      }
    };
  const found = works(name);
  if (!found.available) throw unavailable(name, found.reason);
  return found.trim;
}

/** Use a backend for this process's inference: the one named, or
 * TENDORA_BACKEND, or js. */
export function useTrimBackend(name = process.env.TENDORA_BACKEND || 'js') {
  useTrim(trimBackend(name));
  return name;
}

/** What each backend is here, for `tendora backends`. */
export function describeBackends() {
  const tool = compiler();
  return trimBackends.map((name) => {
    if (name === 'js') return { name, available: true, detail: `Node ${process.version}` };
    if (name === 'auto')
      return {
        name,
        available: true,
        detail: `js below ${nativeFrom.toLocaleString('en')} facts, then ${chooseBackend(nativeFrom)}`,
      };
    const found = works(name);
    return found.available
      ? {
          name,
          available: true,
          detail:
            name === 'swift'
              ? `${tool.version}, ${availableParallelism()} threads`
              : `${found.trim.report?.device ?? 'the GPU'} through Metal 4`,
        }
      : { name, available: false, detail: found.reason };
  });
}

export const nativeDirectory = resolve(repo, '.deps/native');

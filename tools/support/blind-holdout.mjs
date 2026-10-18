/** Mechanical packet, freeze and accounting contracts. No model or project imports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const json = (value) => JSON.stringify(value, null, 2) + '\n';
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function shape(value, required, optional = []) {
  assert(object(value), 'Expected an object');
  assert(
    required.every((key) => Object.hasOwn(value, key)),
    'Missing required fields',
  );
  assert(
    Object.keys(value).every((key) => [...required, ...optional].includes(key)),
    'Unknown fields (including answer/oracle fields) are forbidden in a public packet',
  );
}
function language(value, label) {
  assert(typeof value === 'string' && value.trim(), `${label} must be nonempty language`);
  // The editor normalizes control characters; reject instead of silently changing a packet.
  assert(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value), `${label}: control character`);
}
export function validatePacket(packet) {
  shape(packet, ['title', 'roles', 'cases', 'questions']);
  language(packet.title, 'title');
  assert(!/[\n\t]/u.test(packet.title), 'title must be one line');
  const ids = new Set();
  const identify = (entry) => {
    assert(typeof entry.id === 'string' && entry.id.trim(), 'ID must be a nonempty string');
    assert(!ids.has(entry.id), 'IDs must be unique across the packet');
    ids.add(entry.id);
  };
  for (const key of ['roles', 'cases', 'questions'])
    assert(Array.isArray(packet[key]), `${key} must be an array`);
  for (const role of packet.roles) {
    shape(role, ['id', 'name', 'parent', 'statements']);
    identify(role);
    language(role.name, 'role name');
    assert(!/[\n\t]/u.test(role.name), 'role name must be one line');
    assert(role.parent === null || typeof role.parent === 'string', 'parent must be an ID or null');
    assert(Array.isArray(role.statements), 'statements must be an array');
    for (const statement of role.statements) {
      shape(statement, ['id', 'text']);
      identify(statement);
      language(statement.text, 'statement');
    }
  }
  const roles = new Map(packet.roles.map((role) => [role.id, role]));
  assert.equal(
    new Set(packet.roles.map((role) => role.name)).size,
    packet.roles.length,
    'Role names must be unique for deterministic authoring',
  );
  assert(
    packet.roles.filter((role) => role.parent === null).length === 1,
    'Exactly one root is required',
  );
  for (const role of packet.roles) {
    const ancestors = new Set();
    let at = role;
    while (at) {
      assert(!ancestors.has(at.id), 'Role parents must form a tree, without cycles');
      ancestors.add(at.id);
      if (at.parent === null) break;
      assert(roles.has(at.parent), 'Every parent must exist');
      at = roles.get(at.parent);
    }
  }
  for (const entry of packet.cases) {
    shape(entry, ['id', 'text']);
    identify(entry);
    language(entry.text, 'case');
  }
  const cases = new Set(packet.cases.map((entry) => entry.id));
  for (const entry of packet.questions) {
    shape(entry, ['id', 'text'], ['caseId']);
    identify(entry);
    language(entry.text, 'question');
    assert(entry.caseId == null || cases.has(entry.caseId), 'Question caseId must exist');
  }
  return packet;
}

export function parseOptions(args, required, flags = []) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    assert([...required, ...flags].includes(key), `Unknown option: ${key}`);
    assert(!Object.hasOwn(options, key), `Repeated option: ${key}`);
    if (flags.includes(key)) options[key] = true;
    else {
      assert(args[i + 1] && !args[i + 1].startsWith('--'), `${key} needs a value`);
      options[key] = args[++i];
    }
  }
  for (const key of required) assert(options[key], `Required option: ${key}`);
  return options;
}

/** Only the selected row within the Roles pane; headings are never click targets. */
export function selectedSidebarRow(screen) {
  const rows = screen.split('\n');
  let inRoles = false;
  for (let y = 0; y < rows.length; y++) {
    const cell = rows[y].match(/^│([^│┃┆]*)[│┃┆]/u)?.[1];
    if (cell === undefined) {
      if (inRoles) break;
      continue;
    }
    if (/^\s*(?:›\s*)?Roles\s*$/u.test(cell)) inRoles = true;
    else if (inRoles && /^\s*● /u.test(cell)) return { x: 3, y: y + 1 };
  }
  throw new Error('No visible selected sidebar role row');
}

/** Retain visible answer text, including wrapped continuation lines, without synthesizing it. */
export function displayedValues(screen, label) {
  const answers = [];
  let active = false;
  for (const row of screen.split('\n')) {
    const cell = row.match(/^│.*?[│┃┆] │(.*)[│┃┆]$/u)?.[1]?.trim();
    if (!cell) {
      active = false;
      continue;
    }
    const value = cell.replace(/^(?:[●›>])\s*/u, '');
    if (value.startsWith(`${label}: `)) {
      answers.push(value.slice(label.length + 2));
      active = true;
    } else if (active && !/^[^:]+:/u.test(value)) answers[answers.length - 1] += ' ' + value;
    else active = false;
  }
  return answers;
}
export const displayedAnswers = (screen) => displayedValues(screen, 'Answer');

async function artifactBytes(directory, name) {
  // Freeze artifacts are flat files. Do not follow references into projects or other inputs.
  assert(
    typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name),
    'Invalid artifact path',
  );
  const path = join(directory, name);
  assert((await lstat(path)).isFile(), `Artifact must be a regular file: ${name}`);
  assert.equal(await realpath(path), path, `Artifact must not redirect: ${name}`);
  return readFile(path);
}
export async function artifactHash(directory, path) {
  const bytes = await artifactBytes(await realpath(directory), path);
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}
export async function freezeRun(directory, integration) {
  assert.equal(integration.status, 'complete', 'Cannot freeze incomplete capture');
  await writeFile(join(directory, 'integration.json'), json(integration), { flag: 'wx' });
  const freeze = {
    version: 1,
    packet: await artifactHash(directory, 'public.json'),
    integration: await artifactHash(directory, 'integration.json'),
    captures: await Promise.all(
      integration.captures.map(({ path }) => artifactHash(directory, path)),
    ),
  };
  await writeFile(join(directory, 'freeze.json'), json(freeze), { flag: 'wx' });
  return freeze;
}

export async function verifyFrozenRun(requested) {
  const directory = await realpath(resolve(requested));
  const freeze = JSON.parse(await artifactBytes(directory, 'freeze.json'));
  assert.equal(freeze.version, 1, 'Unsupported freeze version');
  assert.equal(freeze.packet?.path, 'public.json', 'Frozen packet missing');
  assert.equal(freeze.integration?.path, 'integration.json', 'Frozen integration missing');
  assert(Array.isArray(freeze.captures) && freeze.captures.length, 'Frozen captures missing');
  const entries = [freeze.packet, freeze.integration, ...freeze.captures];
  assert.equal(
    new Set(entries.map((e) => e.path)).size,
    entries.length,
    'Duplicate frozen artifact',
  );
  const bytes = new Map();
  for (const entry of entries) {
    const content = await artifactBytes(directory, entry.path);
    assert.equal(sha256(content), entry.sha256, `Frozen hash mismatch: ${entry.path}`);
    assert.equal(content.length, entry.bytes, `Frozen size mismatch: ${entry.path}`);
    bytes.set(entry.path, content);
  }
  const packet = validatePacket(JSON.parse(bytes.get('public.json')));
  const integration = JSON.parse(bytes.get('integration.json'));
  assert.equal(integration.version, 1, 'Unsupported integration version');
  assert.equal(integration.status, 'complete', 'Incomplete run');
  assert(['questions', 'author-only'].includes(integration.mode), 'Invalid capture mode');
  assert.deepEqual(integration.packet, freeze.packet, 'Packet reference mismatch');
  assert.deepEqual(integration.captures, freeze.captures, 'Capture inventory mismatch');
  assert.deepEqual(
    integration.questions.map((q) => q.id),
    packet.questions.map((q) => q.id),
    'Question inventory mismatch',
  );
  const frames = new Map();
  for (const entry of freeze.captures.filter((entry) => entry.path.endsWith('.capture.jsonl'))) {
    const list = bytes.get(entry.path).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    assert(
      list.length && list.every((frame) => !frame.error),
      'Capture has no frames or contains errors',
    );
    assert.equal(list.at(-1).exitCode, 0, 'Editor did not exit cleanly');
    frames.set(entry.path, list);
  }
  assert(frames.size, 'No PTY capture frozen');
  for (const [index, question] of integration.questions.entries()) {
    assert.equal(question.text, packet.questions[index].text, 'Question text mismatch');
    assert.equal(
      question.caseId ?? null,
      packet.questions[index].caseId ?? null,
      'Question case mismatch',
    );
    if (integration.mode === 'author-only') {
      assert.equal(question.state, 'not-asked', 'Invalid author-only question');
      continue;
    }
    assert.equal(question.state, 'captured', 'Question capture missing');
    const display = question.display;
    assert(Number.isInteger(display?.frame) && display.frame >= 0, 'Invalid answer frame');
    const frame = frames.get(display.capture)?.[display.frame];
    assert(frame?.screen && frame.screen === display.screen, 'Displayed answer frame mismatch');
    assert.deepEqual(displayedAnswers(frame.screen), display.answers, 'Displayed answers mismatch');
    assert(display.answers.length && display.answers.every(Boolean), 'Visible answer missing');
    assert(
      question.run?.id &&
        typeof question.run.status === 'string' &&
        question.run.status !== 'running',
      'Retained question run missing',
    );
    assert(question.input && question.result, 'Retained question artifacts missing');
    assert.equal(
      question.run.questions?.[0]?.text,
      question.text.trim(),
      'Retained question mismatch',
    );
  }
  return { directory, freeze, packet, integration };
}

/** Oracle prose stays opaque and is never copied into the report. Only resolution labels compare. */
export function evaluateAccounting(integration, oracle) {
  assert(object(oracle) && Array.isArray(oracle.questions), 'Oracle must have a questions array');
  const seen = new Set();
  for (const entry of oracle.questions) {
    assert(
      object(entry) && typeof entry.id === 'string' && entry.id.trim(),
      'Oracle question needs an ID',
    );
    assert(!seen.has(entry.id), 'Duplicate oracle question ID');
    seen.add(entry.id);
    const resolution = entry.resolution ?? entry.label ?? entry.expectedStatus ?? null;
    assert(
      resolution === null || ['supported', 'ambiguous', 'open', 'partial'].includes(resolution),
      'Unknown oracle resolution label',
    );
  }
  const captured = new Map(integration.questions.map((entry) => [entry.id, entry]));
  assert.equal(captured.size, integration.questions.length, 'Duplicate captured question ID');
  const questions = oracle.questions.map((expected) => {
    const entry = captured.get(expected.id);
    const observed = entry?.state === 'captured';
    const status = observed ? (entry.run?.status ?? null) : null;
    const partial = entry?.run?.answer?.partial;
    const parts = partial?.parts ?? [];
    const openings = partial?.aporias ?? partial?.openings ?? [];
    const inputs = entry?.result?.inputs ?? [];
    const resolution = expected.resolution ?? expected.label ?? expected.expectedStatus ?? null;
    const observedResolution = status === 'open' && parts.length ? 'partial' : status;
    return {
      id: expected.id,
      accounting: !entry ? 'missing-question' : observed ? 'captured' : 'not-asked',
      expectedResolution: resolution,
      observedStatus: status,
      resolutionLabelMatches: resolution && observed ? resolution === observedResolution : null,
      supportedResolution: observed ? status === 'supported' : null,
      ambiguousResolution: observed ? status === 'ambiguous' : null,
      openPreservation:
        resolution === 'open' && observed ? status === 'open' && parts.length === 0 : null,
      semanticJudgment: 'requires-human-review',
      display: entry?.display ?? null,
      retainedAnswerTexts: entry?.run?.answer?.answers?.map((answer) => answer.text) ?? [],
      retainedAnswersVisible: (entry?.run?.answer?.answers ?? []).map((answer) => ({
        text: answer.text,
        visible: (entry?.display?.answers ?? []).some(
          (text) => text.replace(/\s+/gu, ' ').trim() === answer.text.replace(/\s+/gu, ' ').trim(),
        ),
      })),
      partialStructure: {
        parts: parts.length,
        openings: openings.length,
        answerOpenings: entry?.run?.answer?.openings?.length ?? 0,
        runOpenings: entry?.run?.openings?.length ?? 0,
        anchors: openings.map((opening) => ({
          id: opening.id,
          state: opening.state,
          anchor: opening.anchor ?? null,
        })),
        evidence: observed
          ? `integration.json#/questions/${integration.questions.indexOf(entry)}/run/answer`
          : null,
      },
      acquisition: {
        inputs: inputs.map((input) => ({
          id: input.id,
          kind: input.kind,
          text: input.text,
          acquisition: input.acquisition ?? null,
          penman: input.penman ?? null,
          lexicalAudit: input.lexicalAudit ?? null,
        })),
        calls: entry?.run?.calls ?? [],
        error: entry?.run?.error ?? null,
      },
      reasoning: {
        stages: entry?.run?.stages ?? [],
        resultRetained: Boolean(entry?.result),
        evidence: observed
          ? `integration.json#/questions/${integration.questions.indexOf(entry)}`
          : null,
        attributedAnswers: entry?.run?.answer?.answers ?? [],
        candidates: entry?.run?.answer?.candidates ?? [],
      },
    };
  });
  const unscored = integration.questions
    .filter((entry) => !seen.has(entry.id))
    .map((entry) => entry.id);
  return {
    version: 1,
    policy:
      'Mechanical ID and resolution-label accounting only; semantic correctness requires human review. Oracle prose is not reproduced.',
    counts: {
      oracle: questions.length,
      captured: questions.filter((q) => q.accounting === 'captured').length,
      missing: questions.filter((q) => q.accounting === 'missing-question').length,
      notAsked: questions.filter((q) => q.accounting === 'not-asked').length,
      unscored: unscored.length,
      supported: questions.filter((q) => q.supportedResolution === true).length,
      ambiguous: questions.filter((q) => q.ambiguousResolution === true).length,
      openPreserved: questions.filter((q) => q.openPreservation === true).length,
      partial: questions.filter((q) => q.partialStructure.parts > 0).length,
      resolutionLabelMismatches: questions.filter((q) => q.resolutionLabelMatches === false).length,
    },
    questions,
    unscoredQuestionIds: unscored,
  };
}

/** One command declaration drives engine argument validation and scoped help. */
import { parseArgs } from 'node:util';
import { trimBackends } from '../engine/trim-backend.mjs';

export const program = 'tendora';
const options = {
  project: ['string', '<directory>', 'Project directory.'],
  scope: ['string', '<role-or-path>', 'Ask within this role and its children.'],
  case: ['string', '<role-or-path>', 'Use this role as an independent case.'],
  'case-text': ['string', '<text>', 'Use an independent case without adding sources.'],
  question: ['string', '<text>', 'The question to check; - reads it from standard input.'],
  statement: ['string', '<text>', 'A statement, by its text or a part only it has.'],
  text: ['string', '<text>', 'The statement to suppose; it is never saved.'],
  role: ['string', '<role-or-path>', 'A role: its label, /Root/Child path or placement ID.'],
  grain: ['string', '<depth>', 'Branch depth under the root role; defaults to 1.'],
  run: ['string', '<id>', 'Saved check identity from ask or runs.'],
  all: ['boolean', '', 'Reset saved engine checks and associated data.'],
  'dry-run': ['boolean', '', 'Show what would be deleted; delete nothing.'],
  yes: ['boolean', '', 'Do not ask for confirmation on a terminal.'],
  name: ['string', '<name>', 'Project name; defaults to the directory name.'],
  root: ['string', '<name>', 'Initial role name; defaults to Root.'],
  json: ['boolean', '', 'Write the result as JSON to stdout.'],
  explain: ['boolean', '', 'Include proof details; check progress goes to stderr.'],
  offline: ['boolean', '', 'Use retained AMRs only; never acquire missing readings.'],
  trace: ['boolean', '', 'Retain detailed local comparison diagnostics.'],
  actor: ['string', '<name>', 'Record the check as made by NAME; otherwise unrecorded.'],
  file: ['string', '<path>', 'Existing authored engine-knowledge JSON to import.'],
  backend: [
    'string',
    '<name>',
    'Where the trim runs: js (default), swift, metal or auto; see tendora backends.',
  ],
  withhold: [
    'boolean',
    '',
    'Ask each variable again without its statement: borne alone, or shared.',
  ],
  help: ['boolean', '', 'Show help for this command.'],
  version: ['boolean', '', 'Show the version.'],
};
const checking = [
  'scope',
  'case',
  'case-text',
  'question',
  'offline',
  'trace',
  'explain',
  'actor',
  'backend',
];
const demo = '.proj/payments-demo';
export const engineCommands = {
  ask: {
    description: 'Check a question against scoped sources.',
    options: checking,
    required: '--question <text>',
    example: `--scope "Incident Commander" \\\n    --question "Who freezes deployments during a major incident?" --offline`,
    notes: [
      'Scope and case accept a role label, /Root/Child path, or placement ID.',
      'Bare labels prefer a matching root; nested duplicates need a full path.',
      'In path segments, escape ~ as ~0 and / as ~1.',
      "Choose --case or --case-text: one check's circumstances, never a statement.",
      'Without --offline, missing AMRs may be acquired through configured eGemma.',
      'A proposal waits for a person: confirm it in the workbench (Development, d).',
      'Also invoked as tendora run.',
    ],
  },
  run: { alias: 'ask' },
  suppose: {
    description: 'Hypothesis: what would follow if a statement were said; nothing is saved.',
    options: ['text', 'role', 'backend', 'offline'],
    required: '--text <text>',
    example: '--text "A certificate expires." --offline',
    notes: [
      'The statement stands at --role (the root by default): its own variables asked',
      'back (new, said, otherwise, conflict), the rules that apply with it (only with it,',
      'or also without), and each saved question in its scope checked again with and',
      "without it. Its reading is retained like a question's; no statement, check or",
      'case is saved. That nothing follows is a result. Also invoked as tendora hypothesis.',
    ],
  },
  hypothesis: { alias: 'suppose' },
  runs: {
    description: 'List saved checks and questions.',
    options: ['explain'],
    example: '--json',
  },
  show: {
    description: 'Read one saved check.',
    options: ['run', 'explain'],
    required: '--run <id>',
    example: '--run <id> --json',
    notes: ['This reads a saved assessment; it does not recheck changed sources.'],
  },
  recoil: {
    description: 'What a statement, role or question rests on, what rests on it, and beside it.',
    options: ['statement', 'role', 'question', 'scope', 'case-text', 'offline'],
    required: '(--statement <text> | --role <role> | --question <text>)',
    example:
      '--question "Who notifies the customers?" \\\n    --case-text "A certificate expires."',
    notes: [
      'Down is what it rests on, up what rests on it, sideways what shares its place.',
      'A question is the saved one asked at --scope (the root by default) with its case.',
      'Reads the saved checks: offline, it checks and saves nothing. The frontier is',
      'what the walk cannot see, never absence.',
    ],
  },
  tensions: {
    description: 'Juxtaposition: where questions bring the branches of the role tree together.',
    options: ['grain', 'offline'],
    example: '',
    notes: [
      'A line between two branches is resolved when one answer composes both, gathered',
      'when each gives its own answer, and open when only parts reach one of them.',
      'Uses the latest check of each question, scope and case; offline, it saves nothing.',
      'An open line is a place to ask or to author, never an answer.',
      'Also invoked as tendora juxtaposition.',
    ],
  },
  juxtaposition: { alias: 'tensions' },
  probe: {
    description: 'Ask statements back from their own readings (cloze probes).',
    options: ['statement', 'role', 'backend', 'offline'],
    required: '(--statement <text> | --role <role>)',
    example: '--role "Security Engineer"',
    notes: [
      "Each participant of a statement's relation is left blank and asked back, then its",
      'truth, from the latest check at the root role. Offline: it evaluates retained',
      'readings in memory and saves nothing.',
    ],
  },
  fidelity: {
    description:
      'Corpus fidelity: what the statements can be asked back for, what questions rest on.',
    options: ['withhold', 'backend', 'offline'],
    example: '',
    notes: [
      "Each statement's participants, circumstances and truth are asked back (the probes),",
      'and each variable is classed: own, shared or carried (answerable); silent (its',
      'condition not given); possible, otherwise, owed or conflict (to review). Each saved',
      'question (its latest check) is answered by one statement, composed, conditional,',
      'possible or open. Offline: it evaluates retained readings in memory and saves',
      'nothing; --withhold doubles the work.',
    ],
  },
  backends: {
    description: 'List where the trim can run on this machine.',
    options: [],
    project: false,
    notes: [
      'js runs everywhere and is the default. swift and metal need macOS and the Swift',
      'toolchain; they are built on first use into .deps/native. auto uses js below',
      '250,000 facts and the fastest native backend above. --backend on a check, or',
      'TENDORA_BACKEND, chooses one; every backend gives the same answers.',
    ],
  },
  init: {
    description: 'Create an empty project, where there is no project or its storage.',
    options: ['name', 'root'],
    example: '--name "Payments" --root "Incident Commander"',
    project: 'tmp/my-project',
  },
  delete: {
    description: 'Remove saved checks; retain authored concepts and sources.',
    options: ['run', 'all', 'dry-run', 'yes'],
    required: '(--run <id> | --all)',
    example: '--all --dry-run',
    notes: [
      'On a terminal it asks before deleting, unless --yes; a script (no terminal)',
      "deletes at once. --dry-run lists what would go. --run keeps the question's",
      'reading; --all also clears saved cases and readings no statement owns.',
    ],
  },
  storage: {
    description: 'Report project storage usage.',
    options: [],
    example: '',
  },
  compact: {
    description: 'Compact storage and rebuildable check caches.',
    options: [],
    example: '',
    notes: ['Authored material stays; evicted assessments are rechecked when reopened.'],
  },
  knowledge: {
    description: 'Import existing authored engine knowledge (advanced).',
    options: ['file'],
    required: '--file <path>',
    example: '--file knowledge.json',
  },
};
const sections = [
  ['Check questions', ['ask', 'suppose', 'runs', 'show']],
  ['Inspect saved checks (read-only, offline)', ['recoil', 'tensions', 'probe', 'fidelity']],
  ['Manage a project', ['init', 'delete', 'storage', 'compact', 'knowledge']],
  ['This machine', ['backends']],
];

/** An invalid invocation (exit status 2). A syntax error points to the help;
 * a name that matches nothing (a statement, role, run or project) gives its
 * own next step as `hint` instead. */
export class EngineUsageError extends Error {
  constructor(message, { hint = null, syntax = true } = {}) {
    super(message);
    this.hint = hint;
    this.syntax = syntax;
  }
}

/** The closest name within two edits, for "did you mean". */
export function closest(word, names) {
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const current = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
        previous = current;
      }
    }
    return row[b.length];
  };
  const ranked = names
    .map((name) => [name, distance(word, name)])
    .filter(([, d]) => d <= 2)
    .sort((a, b) => a[1] - b[1]);
  return ranked[0]?.[0] ?? null;
}

export function engineHelp(action) {
  if (!action)
    return [
      `Usage: ${program} <command> [options]`,
      '',
      ...sections.flatMap(([title, names]) => [
        `${title}:`,
        ...names.map((name) => `  ${name.padEnd(10)} ${engineCommands[name].description}`),
        '',
      ]),
      'Every command but backends requires --project <directory>.',
      'Aliases: run (ask), juxtaposition (tensions). tendora --version prints the version.',
      `Use ${program} <command> --help for its options and an example.`,
      'From a checkout, npm run --silent engine -- <command> runs the same CLI.',
      '',
      'Exit status: 0 completed; 1 failed or missing readings; 2 invalid arguments;',
      '             130 interrupted. An open answer is a completed check.',
      '',
      'Environment: EGEMMA_URL, EGEMMA_API_KEY_FILE or EGEMMA_API_KEY (acquisition),',
      'PENMAN_PYTHON (graph preparation), TENDORA_BACKEND and TENDORA_SWIFTC (the trim).',
      'See docs/cli.md.',
    ].join('\n');
  const name = engineCommands[action].alias ?? action;
  const command = engineCommands[name];
  const project = command.project !== false;
  const lines = [
    `Usage: ${program} ${action}${project ? ' --project <directory>' : ''}${command.required ? ' ' + command.required : ''} [options]`,
    '',
    command.description,
    '',
    'Options:',
    ...[...(project ? ['project'] : []), ...command.options, 'json', 'help'].map((option) => {
      const [, value, description] = options[option];
      return `  ${(option === 'help' ? '-h, --help' : `--${option}${value ? ' ' + value : ''}`).padEnd(27)} ${description}`;
    }),
  ];
  if (command.notes?.length) lines.push('', ...command.notes);
  lines.push(
    '',
    'Example:',
    `  ${program} ${action}${project ? ` --project ${command.project ?? demo}` : ''}${command.example ? ' ' + command.example : ''}`,
    '',
    'Diagnostics go to stderr; --json leaves stdout machine-readable.',
  );
  return lines.join('\n');
}

export function parseEngineArguments(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      tokens: true,
      options: Object.fromEntries(
        Object.entries(options).map(([name, [type]]) => [
          name,
          { type, ...(name === 'help' ? { short: 'h' } : {}) },
        ]),
      ),
    });
  } catch (error) {
    const unknown = /^Unknown option '(-{1,2}[^']+)'/u.exec(error.message)?.[1];
    if (unknown) {
      const suggestion = closest(unknown.replace(/^-+/u, ''), Object.keys(options));
      throw new EngineUsageError(
        `Unknown option ${unknown}.${suggestion ? ` Did you mean --${suggestion}?` : ''}`,
      );
    }
    throw new EngineUsageError(error.message.replace(/\. To specify a positional.*$/su, '.'));
  }
  const { values, positionals, tokens } = parsed;
  const [action] = positionals;
  if (action && !Object.hasOwn(engineCommands, action)) {
    const suggestion = closest(action, Object.keys(engineCommands));
    throw new EngineUsageError(
      `Unknown command: ${action}.${suggestion ? ` Did you mean ${suggestion}?` : ''}`,
    );
  }
  if (positionals.length > 1) throw new EngineUsageError(`Unexpected argument: ${positionals[1]}`);
  const seen = new Set();
  for (const token of tokens.filter((token) => token.kind === 'option')) {
    if (seen.has(token.name)) throw new EngineUsageError(`Repeated option: --${token.name}`);
    seen.add(token.name);
  }
  if (!action) {
    if (values.version) return { version: true, values };
    // Help is text, with or without --json, as a command's help is.
    if (Object.keys(values).some((name) => !['help', 'json'].includes(name)))
      throw new EngineUsageError('Choose a command.');
    return { help: engineHelp(), values };
  }
  const command = engineCommands[engineCommands[action].alias ?? action];
  const allowed = new Set([
    ...(command.project !== false ? ['project'] : []),
    'json',
    'help',
    ...command.options,
  ]);
  for (const name of Object.keys(values))
    if (!allowed.has(name))
      throw new EngineUsageError(`--${name} is not available for ${program} ${action}.`);
  if (values.help) return { action, values, help: engineHelp(action) };
  for (const [name, value] of Object.entries(values))
    if (typeof value === 'string' && !value.trim())
      throw new EngineUsageError(`--${name} needs a non-empty value.`);
  const requireOption = (name) => {
    if (!values[name])
      throw new EngineUsageError(
        name === 'project'
          ? `--project is required for ${program} ${action}: the project's directory, such as --project .proj/payments-demo after npm run demo -- --reset.`
          : `--${name} is required for ${program} ${action}.`,
      );
  };
  const exactlyOne = (names) => {
    if (names.filter((name) => values[name]).length !== 1)
      throw new EngineUsageError(
        `Choose one of ${names.map((name) => `--${name}`).join(', ')} for ${program} ${action}.`,
      );
  };
  if (command.project !== false) requireOption('project');
  if (values.backend && !trimBackends.includes(values.backend))
    throw new EngineUsageError(
      `Unknown trim backend: ${values.backend}. Choose ${trimBackends.join(', ')}.`,
      { syntax: false, hint: `See what this machine offers with: ${program} backends` },
    );
  if (['ask', 'run'].includes(action)) {
    requireOption('question');
    if (values.case && values['case-text'])
      throw new EngineUsageError('Choose --case or --case-text, not both.');
  }
  if (['suppose', 'hypothesis'].includes(action)) requireOption('text');
  if (action === 'recoil') {
    exactlyOne(['statement', 'role', 'question']);
    if (!values.question && (values.scope || values['case-text']))
      throw new EngineUsageError(
        `--scope and --case-text qualify a question; drop them, or recoil from the question with --question instead of --${values.statement ? 'statement' : 'role'}.`,
      );
  }
  if (action === 'probe') exactlyOne(['statement', 'role']);
  if (action === 'tensions' && values.grain !== undefined && !/^[1-9]\d*$/u.test(values.grain))
    throw new EngineUsageError('--grain needs a whole number of at least 1.');
  if (action === 'show') requireOption('run');
  if (action === 'knowledge') requireOption('file');
  if (action === 'delete' && Boolean(values.run) === Boolean(values.all))
    throw new EngineUsageError(`Choose --run <id> or --all for ${program} delete.`);
  return { action: engineCommands[action].alias ?? action, values };
}

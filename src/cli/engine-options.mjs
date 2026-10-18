/** One command declaration drives engine argument validation and scoped help. */
import { parseArgs } from 'node:util';

const options = {
  project: ['string', '<directory>', 'Project directory.'],
  scope: ['string', '<role-or-path>', 'Ask within this role and its children.'],
  case: ['string', '<role-or-path>', 'Use this role as an independent case.'],
  'case-text': ['string', '<text>', 'Use an independent case without adding sources.'],
  question: ['string', '<text>', 'The question to check against current sources.'],
  run: ['string', '<id>', 'Saved check identity from ask or runs.'],
  all: ['boolean', '', 'Reset saved engine checks and associated data.'],
  name: ['string', '<name>', 'Project name; defaults to the directory name.'],
  root: ['string', '<name>', 'Initial role name; defaults to Root.'],
  json: ['boolean', '', 'Write the result as JSON to stdout.'],
  explain: ['boolean', '', 'Include proof details; check progress goes to stderr.'],
  offline: ['boolean', '', 'Use retained AMRs only; never acquire missing readings.'],
  trace: ['boolean', '', 'Retain detailed local comparison diagnostics.'],
  file: ['string', '<path>', 'Existing authored engine-knowledge JSON to import.'],
  help: ['boolean', '', 'Show help for this command.'],
};
const checking = ['scope', 'case', 'case-text', 'question', 'offline', 'trace', 'explain'];
export const engineCommands = {
  init: { description: 'Create an empty project.', options: ['name', 'root'] },
  ask: { description: 'Check a question against scoped sources.', options: checking },
  run: { description: 'Alias for ask.', options: checking },
  runs: { description: 'List saved checks and questions.', options: ['explain'] },
  show: { description: 'Read one saved check.', options: ['run', 'explain'] },
  delete: {
    description: 'Remove saved checks; retain authored concepts and sources.',
    options: ['run', 'all'],
  },
  knowledge: {
    description: 'Import existing authored engine knowledge (advanced).',
    options: ['file'],
  },
  storage: { description: 'Report project storage usage.', options: [] },
  compact: { description: 'Compact storage and rebuildable check caches.', options: [] },
};

export class EngineUsageError extends Error {}

export function engineHelp(action) {
  if (!action)
    return [
      'Usage: engine <command> [options]',
      '',
      'Check questions:',
      ...['ask', 'run', 'runs', 'show'].map(
        (name) => `  ${name.padEnd(10)} ${engineCommands[name].description}`,
      ),
      '',
      'Manage a project:',
      ...['init', 'delete', 'storage', 'compact', 'knowledge'].map(
        (name) => `  ${name.padEnd(10)} ${engineCommands[name].description}`,
      ),
      '',
      'All commands require --project <directory>.',
      'Use engine <command> --help for its options and examples.',
      '',
      'Exit status: 0 completed; 1 failed or missing readings; 2 invalid arguments;',
      '             130 interrupted. An open answer is a completed check.',
    ].join('\n');
  const command = engineCommands[action];
  const required =
    action === 'ask' || action === 'run'
      ? ' --question <text>'
      : action === 'show'
        ? ' --run <id>'
        : action === 'delete'
          ? ' (--run <id> | --all)'
          : action === 'knowledge'
            ? ' --file <path>'
            : '';
  const lines = [
    `Usage: engine ${action} --project <directory>${required} [options]`,
    '',
    command.description,
    '',
    'Options:',
    ...['project', ...command.options, 'json', 'help'].map((name) => {
      const [, value, description] = options[name];
      return `  ${(name === 'help' ? '-h, --help' : `--${name}${value ? ' ' + value : ''}`).padEnd(27)} ${description}`;
    }),
  ];
  if (action === 'ask' || action === 'run')
    lines.push(
      '',
      'Scope and case accept a role label, /Root/Child path, or placement ID.',
      'Bare labels prefer a matching root; nested duplicates need a full path.',
      'In path segments, escape ~ as ~0 and / as ~1.',
      'Choose --case or --case-text. Case material does not become corpus evidence.',
      'Without --offline, missing AMRs may be acquired through configured eGemma.',
      '',
      'Example:',
      `  engine ${action} --project .proj/payments-demo --scope "Incident Commander" \\`,
      '    --question "Who freezes deployments during a major incident?" --offline',
    );
  if (action === 'delete')
    lines.push(
      '',
      'Deletion runs immediately with the explicit --run or --all selection.',
      'It does not ask for terminal confirmation. --all also clears saved cases',
      'and rebuildable acquisitions not owned by authored corpus material.',
    );
  if (action === 'show')
    lines.push('', 'This reads a saved assessment; it does not recheck changed sources.');
  if (action === 'compact')
    lines.push('', 'Authored material stays; evicted assessments are rechecked when reopened.');
  lines.push('', 'Diagnostics go to stderr; --json leaves stdout machine-readable.');
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
    throw new EngineUsageError(error.message);
  }
  const { values, positionals, tokens } = parsed;
  const [action] = positionals;
  if (action && !Object.hasOwn(engineCommands, action))
    throw new EngineUsageError(`Unknown engine command: ${action}`);
  if (positionals.length > 1) throw new EngineUsageError(`Unexpected argument: ${positionals[1]}`);
  const seen = new Set();
  for (const token of tokens.filter((token) => token.kind === 'option')) {
    if (seen.has(token.name)) throw new EngineUsageError(`Repeated option: --${token.name}`);
    seen.add(token.name);
  }
  if (!action) {
    if (Object.keys(values).some((name) => name !== 'help'))
      throw new EngineUsageError('Choose an engine command.');
    return { help: engineHelp(), values };
  }
  const allowed = new Set(['project', 'json', 'help', ...engineCommands[action].options]);
  for (const name of Object.keys(values))
    if (!allowed.has(name))
      throw new EngineUsageError(`--${name} is not available for engine ${action}.`);
  if (values.help) return { action, values, help: engineHelp(action) };
  for (const [name, value] of Object.entries(values))
    if (typeof value === 'string' && !value.trim())
      throw new EngineUsageError(`--${name} needs a non-empty value.`);
  const requireOption = (name) => {
    if (!values[name]) throw new EngineUsageError(`--${name} is required for engine ${action}.`);
  };
  requireOption('project');
  if (['ask', 'run'].includes(action)) {
    requireOption('question');
    if (values.case && values['case-text'])
      throw new EngineUsageError('Choose --case or --case-text, not both.');
  }
  if (action === 'show') requireOption('run');
  if (action === 'knowledge') requireOption('file');
  if (action === 'delete' && Boolean(values.run) === Boolean(values.all))
    throw new EngineUsageError('Choose --run <id> or --all for engine delete.');
  return { action, values };
}

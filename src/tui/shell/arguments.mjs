/** Startup options shared by interactive and plain-text workbench entry points. */
import { parseArgs } from 'node:util';

export const workbenchHelp = `Tendora workbench: develop knowledge through roles and questions.

Usage:
  npm run workbench
  npm run workbench -- --project PATH
  npm run workbench -- --project PATH --snapshot

Options:
  --project PATH       Open a project directory or project.json
  --actor NAME         Attribute edits to NAME (default: participant)
  --backend NAME       Where the trim runs: js (default), swift, metal or auto
  --snapshot           Print the project or recording without opening the TUI
  --no-color           Disable colors (also respects NO_COLOR and TERM=dumb)
  --color              Enable colors, overriding the environment
  -h, --help           Show this help without opening a project

Recording diagnostics:
  --recording PATH     Inspect a saved traversal recording (read-only)
  --node ID            Select a recorded node
  --visit ID           Select a recorded visit
  --occurrence ID      Select an occurrence at that node
  --detail NAME        scope, source, proposal or provenance

Without a terminal, --project or --recording prints a plain-text snapshot.
Project and recording options cannot be combined. Recording selections require
--recording. Use npm run engine -- --help for scriptable engine operations.
`;

export function workbenchArguments(args, env = process.env) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const { values, positionals, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries([
      ...['project', 'recording', 'actor', 'backend', 'node', 'visit', 'occurrence', 'detail'].map(
        (name) => [name, { type: 'string' }],
      ),
      ...['snapshot', 'color', 'no-color'].map((name) => [name, { type: 'boolean' }]),
    ]),
  });
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && !value.trim()) throw new Error(`--${name} needs a value`);
    if (!['color', 'no-color'].includes(name) && tokens.filter((t) => t.name === name).length > 1)
      throw new Error(`--${name} may only be given once`);
  }
  const selections = ['node', 'visit', 'occurrence', 'detail'].filter((key) => values[key]);
  if (values.project && (values.recording || selections.length))
    throw new Error('--project cannot be combined with recording selections');
  if (selections.length && !values.recording)
    throw new Error(`--${selections[0]} requires --recording PATH`);
  if (values.backend && !['js', 'swift', 'metal', 'auto'].includes(values.backend))
    throw new Error('--backend must be js, swift, metal or auto');
  if (values.detail && !['scope', 'source', 'proposal', 'provenance'].includes(values.detail))
    throw new Error('--detail must be scope, source, proposal or provenance');
  if (values.snapshot && !values.project && !values.recording)
    throw new Error('--snapshot requires --project PATH or --recording PATH');
  const color = tokens.filter((t) => t.name === 'color' || t.name === 'no-color').at(-1);
  return {
    ...values,
    noColor: color ? color.name === 'no-color' : Boolean(env.NO_COLOR) || env.TERM === 'dumb',
  };
}

/** Draw the capability graphs of docs/demo.md from the bundled demo's saved
 * checks: a question and its answer, what questions bring together, and recoil
 * down, up and sideways. Read-only and offline. Each graph is a mermaid block,
 * left to right; test/project/demo-graphs.mjs keeps docs/demo.md equal to them.
 *
 *   node tools/demo-graphs.mjs [--project <copy of the demo>] [--write [docs/demo.md]]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { openProject, projectTree } from '../src/project/authoring/project.mjs';
import { listEngineRuns } from '../src/project/storage/engine-runs.mjs';
import { recoilLocus, recoilReport, tensionReport } from '../src/project/inquiries/inspection.mjs';
import { statementCatalog } from '../src/project/inquiries/recoil.mjs';

const ring = { person: '#8e5bd6', kept: '#4d6bfe', engine: '#2e9e5b', open: '#8a96a8' };
const style = (rings) => `---
config:
    layout: elk
    look: neo
    flowchart:
        wrappingWidth: 240
    themeCSS: >-
        foreignObject { overflow: visible; }
        .edgeLabel, .edgeLabel p, .edgeLabel span {
        background: transparent !important; }
        .edgeLabel rect { fill: transparent !important; }
        .labelBkg { --knock: var(--vscode-editor-background,
        var(--bgColor-default, rgb(from currentColor
        clamp(30, (128 - r) * 100, 255) clamp(30, (128 - r) * 100, 255)
        clamp(30, (128 - r) * 100, 255)))); --ring: var(--knock);
        --fill: color-mix(in srgb, var(--ring) 30%, var(--knock));
        background: var(--fill) !important; border-radius: 4px;
        box-shadow: 0 0 0 5px var(--fill), 0 0 0 7px var(--ring); }
${rings.map(([prefix, color]) => `        .label[data-id^="L_${prefix}"] .labelBkg { --ring: ${color}; }`).join('\n')}
        .edgeLabel p, .edgeLabel span, .edgeLabel text {
        --halo: var(--fill, var(--vscode-editor-background,
        var(--bgColor-default,
        rgb(from currentColor clamp(0, (128 - r) * 100, 255)
        clamp(0, (128 - r) * 100, 255) clamp(0, (128 - r) * 100, 255)))));
        text-shadow: 1px 0 var(--halo), -1px 0 var(--halo),
        0 1px var(--halo), 0 -1px var(--halo), 1px 1px var(--halo),
        -1px -1px var(--halo), 1px -1px var(--halo), -1px 1px var(--halo),
        0 0 3px var(--halo), 0 0 4px var(--halo); }
---`;
const classes = `    classDef default fill:#8a96a82e,stroke:#8a96a8,stroke-width:1px
    classDef person fill:#8e5bd64d,stroke:#8e5bd6,stroke-width:2px
    classDef kept fill:#4d6bfe4d,stroke:#4d6bfe,stroke-width:2px
    classDef engine fill:#2e9e5b4d,stroke:#2e9e5b,stroke-width:2px
    classDef open fill:#8a96a814,stroke:#8a96a8,stroke-width:2px,stroke-dasharray:6 4`;
const text = (value) => String(value).replaceAll('"', '#quot;');
const box = (id, title, body) => `    ${id}["<b>${text(title)}</b><br/>${text(body)}"]`;
const block = (rings, lines) =>
  ['```mermaid', style(rings), 'flowchart LR', ...lines, classes, '```'].join('\n');

const root = fileURLToPath(new URL('../', import.meta.url));
const at = process.argv.indexOf('--project');
const project = await openProject(
  at > 0 ? resolve(process.argv[at + 1]) : join(root, 'demo/payments-on-call'),
);
const rows = projectTree(project.data);
const roleOf = (placementId) => rows.find((row) => row.placement.id === placementId)?.concept.name;
const catalog = new Map(statementCatalog(project.data).map((item) => [item.id, item]));
const runs = await listEngineRuns(project);
const chainQuestion = 'Who notifies the customers?',
  chainCase = 'A certificate expires.';
const chain = runs.find(
  (run) =>
    run.questions[0].text === chainQuestion && run.caseSelection?.sources?.[0]?.text === chainCase,
);
if (!chain?.answer?.answers?.length) throw new Error('The demo has no answered chain question');
const [answer] = chain.answer.answers;
const statements = answer.sourceIds.filter((id) => catalog.has(id)).map((id) => catalog.get(id));
// The rule whose condition the case meets comes first.
statements.sort((a, b) => Number(b.text.includes('expires')) - Number(a.text.includes('expires')));

const graphs = {};
graphs['question-and-answer'] = block(
  [
    ['Q_', ring.person],
    ['C_', ring.kept],
    ['S1_', ring.kept],
    ['S2_', ring.engine],
  ],
  [
    box('Q', 'Question', `${chainQuestion} (at ${roleOf(chain.scopePlacementId)})`),
    box('C', 'Case', chainCase),
    box('S1', roleOf(statements[0].nodeId), statements[0].text),
    box('S2', roleOf(statements[1].nodeId), statements[1].text),
    box(
      'A',
      `Answer: ${answer.text}`,
      `${chain.status}; rests on 2 statements, 2 rules and the case`,
    ),
    '',
    // The question and the case come in side by side: the question asks for
    // a rule's conclusion, the case meets the first condition.
    '    Q -->|"asks for the conclusion of"| S2',
    '    C -->|"meets the condition of"| S1',
    '    S1 -->|"its conclusion meets the condition of"| S2',
    '    S2 -->|"concludes"| A',
    '    class Q person',
    '    class C,S1 kept',
    '    class S2,A engine',
  ],
);

const tensions = await tensionReport(project);
const met = tensions.questions.filter((item) => item.effect === 'juxtaposition');
const branchIds = new Map();
const lines = [];
met.forEach((item, i) => {
  lines.push(box(`Q${i}`, 'Question', item.question + (item.case ? ` / Case: ${item.case}` : '')));
  for (const name of item.branches)
    if (!branchIds.has(name)) branchIds.set(name, `R${branchIds.size}`);
});
for (const [name, id] of branchIds) lines.push(`    ${id}["<b>${text(name)}</b>"]`);
lines.push('');
met.forEach((item, i) => {
  const status = item.lines[0]?.status;
  for (const name of item.branches) lines.push(`    Q${i} -->|"${status}"| ${branchIds.get(name)}`);
});
lines.push(
  `    class ${met.map((_, i) => `Q${i}`).join(',')} person`,
  `    class ${[...branchIds.values()].join(',')} kept`,
);
graphs.juxtaposition = block(
  met.map((_, i) => [`Q${i}_`, ring.engine]),
  lines,
);

const down = await recoilReport(
  project,
  recoilLocus(project, { question: chainQuestion, caseText: chainCase }),
);
const downLines = [box('Q', 'Question', down.locus.label)];
const downRows = down.down.filter((row) => row.kind !== 'role');
downRows.forEach((row, i) =>
  downLines.push(box(`D${i}`, row.kind[0].toUpperCase() + row.kind.slice(1), row.label)),
);
const placed = [...new Set(down.down.filter((row) => row.kind === 'role').map((row) => row.label))];
placed.forEach((name, i) => downLines.push(`    P${i}["<b>${text(name)}</b>"]`));
downLines.push('');
downRows.forEach((row, i) => downLines.push(`    Q -->|"${text(row.relation)}"| D${i}`));
downRows.forEach((row, i) => {
  const statement = [...catalog.values()].find((item) => item.text === row.label);
  if (statement)
    downLines.push(`    D${i} -->|"placed at"| P${placed.indexOf(roleOf(statement.nodeId))}`);
});
downLines.push(
  '    class Q person',
  `    class ${downRows.map((_, i) => `D${i}`).join(',')} kept`,
  `    class ${placed.map((_, i) => `P${i}`).join(',')} engine`,
);
graphs['recoil-down'] = block(
  [
    ['Q_', ring.kept],
    ['D', ring.engine],
  ],
  downLines,
);

const upFrom = statements[0].text;
const up = await recoilReport(project, recoilLocus(project, { statement: upFrom }));
const upRows = up.up.filter((row) => row.kind === 'question');
const upLines = [box('S', `Statement at ${roleOf(statements[0].nodeId)}`, upFrom)];
upRows.forEach((row, i) => upLines.push(box(`U${i}`, 'Question', row.label)));
upLines.push(`    N["<b>Unaffected</b><br/>${up.unaffected} other checked questions"]`, '');
upRows.forEach((row, i) => upLines.push(`    S -->|"${text(row.relation)}"| U${i}`));
upLines.push(
  '    S -.-|"none rests on it"| N',
  '    class S kept',
  `    class ${upRows.map((_, i) => `U${i}`).join(',')} person`,
  '    class N open',
);
graphs['recoil-up'] = block(
  [
    ['S_U', ring.person],
    ['S_N', ring.open],
  ],
  upLines,
);

// Sideways: the questions side by side, resting on the statements they share.
const side = down.sideways;
const sideLines = [box('Q', 'Question', down.locus.label)];
side.forEach((row, i) => sideLines.push(box(`O${i}`, 'Question', row.label)));
const through = [...new Set(side.flatMap((row) => row.through))];
through.forEach((label, i) => sideLines.push(box(`T${i}`, 'Statement', label)));
sideLines.push('');
through.forEach((_, i) => sideLines.push(`    Q -->|"rests on"| T${i}`));
side.forEach((row, i) =>
  row.through.forEach((label) =>
    sideLines.push(`    O${i} -->|"also rests on"| T${through.indexOf(label)}`),
  ),
);
sideLines.push(
  `    class Q,${side.map((_, i) => `O${i}`).join(',')} person`,
  `    class ${through.map((_, i) => `T${i}`).join(',')} kept`,
);
graphs['recoil-sideways'] = block(
  [
    ['Q_', ring.kept],
    ['O', ring.kept],
  ],
  sideLines,
);

/** A document with each `<!-- graph: name -->` marker followed by its graph. */
export function withGraphs(markdown) {
  return markdown.replace(
    /<!-- graph: ([\w-]+) -->\n+(?:```mermaid\n[\s\S]*?\n```\n)?/gu,
    (_, name) => {
      if (!graphs[name]) throw new Error(`No graph named ${name}`);
      return `<!-- graph: ${name} -->\n\n${graphs[name]}\n`;
    },
  );
}

export { graphs };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.indexOf('--write');
  if (write > 0) {
    const target = process.argv[write + 1];
    const path = resolve(target && !target.startsWith('--') ? target : join(root, 'docs/demo.md'));
    await writeFile(path, withGraphs(await readFile(path, 'utf8')));
    console.log(`Graphs written into ${path}`);
  } else
    for (const [name, graph] of Object.entries(graphs))
      console.log(`<!-- graph: ${name} -->\n${graph}\n`);
}

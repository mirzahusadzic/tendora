/** Install the declared Python runtime into this repository's own environment. */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localPython } from './graph-preparation.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', (error) =>
      reject(
        new Error(
          command === 'uv' && error.code === 'ENOENT'
            ? 'Python setup requires uv on PATH.'
            : error.message,
        ),
      ),
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });

try {
  try {
    await access(localPython);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await run('uv', ['venv', '.venv', '--python', '3.14']);
  }
  await run(localPython, [
    '-c',
    'import sys; sys.exit(0 if sys.version_info >= (3, 14) else "Python 3.14+ is required. Move .venv aside and rerun npm run setup:python.")',
  ]);
  await run(localPython, ['python/semcat/manage.py', 'install', '--python', localPython]);
  console.log('Python runtime ready. Engine and workbench use .venv automatically.');
} catch (error) {
  console.error(`Python setup failed: ${error.message}`);
  process.exitCode = 1;
}

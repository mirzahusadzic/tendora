import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

export const localPath = (path) =>
  resolve(path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** Where the engine's trim runs, for the CLI and the workbench: js by default,
 * swift or metal where this machine has them (src/models/trim-backends.mjs). */
export {
  chooseBackend,
  describeBackends,
  nativeFrom,
  trimBackends,
  useTrimBackend,
} from '../models/trim-backends.mjs';

/** A capture preload: acquisition attempts fail before they can reach any server. */
import { appendFileSync } from 'node:fs';

globalThis.fetch = async (url) => {
  if (process.env.TENDORA_CAPTURE_NETWORK_LOG)
    appendFileSync(
      process.env.TENDORA_CAPTURE_NETWORK_LOG,
      JSON.stringify({ at: new Date().toISOString(), url: String(url) }) + '\n',
    );
  throw new Error('Offline capture: network acquisition is disabled; saved reading required.');
};

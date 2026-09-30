import { loadStdioAdapterConfig } from './config.js';
import { startStdioAdapter } from './server.js';

const config = loadStdioAdapterConfig();
const adapter = await startStdioAdapter(config);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  try {
    await adapter.close();
  } catch (error) {
    console.error('Tabro stdio adapter shutdown failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.stdin.once('end', () => void stop());

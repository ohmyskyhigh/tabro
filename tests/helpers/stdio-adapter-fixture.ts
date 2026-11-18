// Exercise the adapter component with an explicitly injected test configuration.
import { loadStdioAdapterConfig } from '../../apps/mcp-stdio-adapter/src/config.js';
import { startStdioAdapter } from '../../apps/mcp-stdio-adapter/src/server.js';

const config = loadStdioAdapterConfig();
if (process.env.TABRO_TEST_MACHINE_SECRET) config.machineSecret = Buffer.from(process.env.TABRO_TEST_MACHINE_SECRET, 'hex');
const adapter = await startStdioAdapter(config);
process.stdin.once('end', () => { void adapter.close(); });

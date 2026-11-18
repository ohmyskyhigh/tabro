import { loadMachineStdioAdapterConfig } from './config.js';
import { callTabro, startStdioAdapter } from './server.js';
import { MCP_TOOL_CATALOG, mcpToolInputJsonSchemas } from '../../shared/protocol/src/index.js';

const [mode, tool, extra] = process.argv.slice(2);
if (mode === '--list-tools' && tool === undefined) {
  console.log(JSON.stringify(MCP_TOOL_CATALOG.map(({ name, description }) => ({ name, description, inputSchema: mcpToolInputJsonSchemas[name] }))));
} else if (mode === '--call' && tool && extra === undefined) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new Error('Tabro tool arguments exceed 1 MiB.');
    chunks.push(bytes);
  }
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, '') || '{}');
  console.log(JSON.stringify(await callTabro(loadMachineStdioAdapterConfig(), tool, input)));
} else if (mode === undefined) {
  const config = loadMachineStdioAdapterConfig();
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
} else {
  throw new Error('Use Tabro with stdio, --list-tools, or --call <tool> with JSON on stdin.');
}

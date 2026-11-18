import process from 'node:process';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export function registerTabro(tools, defineTool, config) {
  const entry = config.adapterEntry ?? process.env.TABRO_ADAPTER_ENTRY;
  const command = config.nodePath ?? 'node';
  return tools.register(defineTool({
    name: 'tabro',
    description: 'Call a Tabro browser tool in your current chat. Call list_tools first for schemas. Reuse the chat workspace and poll accepted tickets.',
    parameters: {
      tool: { type: 'string', required: true, description: 'Tabro tool name, or list_tools for discovery.' },
      argumentsJson: { type: 'string', description: 'JSON object of arguments for the selected tool.' }
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute: async ({ tool, argumentsJson = '{}' }, execution) => {
      const session = execution.agent?.id ?? execution.agent?.session?.id ?? execution.agent?.session?.header?.id;
      if (typeof session !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,199}$/u.test(session)) {
        throw new Error('Tabro requires a current DSH chat.');
      }
      if (!entry || !isAbsolute(entry)) throw new Error('Configure TABRO_ADAPTER_ENTRY with the absolute installed adapter path.');
      const args = tool === 'list_tools' ? ['--list-tools'] : ['--call', tool];
      const env = { ...process.env, TABRO_RUNTIME: 'dsh', TABRO_RUNTIME_SESSION: session, TABRO_PARENT_RUNTIME_SESSION: '', OCTOPUS_PARENT_RUNTIME_SESSION: '' };
      const text = await new Promise((resolve, reject) => {
        const child = spawn(command, [entry, ...args], { env, windowsHide: true, signal: execution.signal,
          stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2048); });
        child.on('error', reject);
        child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
        child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || 'Tabro adapter exited with code ' + code)));
        child.stdin.end(argumentsJson);
      });
      return { text };
    }
  }));
}

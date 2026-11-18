import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

const { session_id: sessionId } = JSON.parse(readFileSync(0, 'utf8'));
if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,199}$/u.test(sessionId)) {
  throw new Error('Claude Code did not supply a valid session ID.');
}
if (!process.env.CLAUDE_ENV_FILE) throw new Error('Claude Code did not provide its session environment file.');
appendFileSync(process.env.CLAUDE_ENV_FILE, 'export TABRO_RUNTIME=cc\nexport TABRO_RUNTIME_SESSION=' + sessionId + '\n');

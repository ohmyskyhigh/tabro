import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerTabro } from './session-tool.js';

export const name = 'tabro';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  ctx.effect(() => registerTabro(ctx.tools, defineTool, config), 'Tabro chat-scoped browser tools');
}

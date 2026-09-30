export type DemoRole = 'Alice' | 'Bob' | 'Carol';
export interface DemoTodo { id: string; title: string; due: string; note: string; completed: boolean }
export interface DemoAccount { role: DemoRole; tasks: DemoTodo[]; summary: { state: 'idle' | 'pending' | 'ready'; requestedAt: string | null; completedAt: string | null; text: string | null } }
export interface DemoEvent { runId: string; at: string; role: DemoRole; type: 'login' | 'complete' | 'summary_started' | 'summary_finished'; taskId?: string }
export interface DemoConfig { runId: string; port: number; outputRoot: string; durations?: Record<DemoRole, number> }

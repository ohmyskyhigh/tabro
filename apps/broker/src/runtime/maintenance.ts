import { closeSync, existsSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const Marker = z.strictObject({ schemaVersion: z.literal(1), transactionId: z.string().uuid(), instanceRef: z.string().uuid() });

export class MaintenanceFence {
  private transactionId: string | null = null;
  private entering = false;
  private stopping = false;
  constructor(private readonly path: string) {
    if (existsSync(path)) this.transactionId = Marker.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown).transactionId;
  }
  get current(): string | null { return this.transactionId; }
  get fenced(): boolean { return this.entering || this.transactionId !== null; }
  canResume(transactionId: string): boolean { return !this.stopping && this.transactionId === transactionId; }
  enter(transactionId: string, instanceRef: string, quiet: () => boolean): boolean {
    Marker.parse({ schemaVersion: 1, transactionId, instanceRef });
    if (this.fenced) return false;
    this.entering = true;
    try {
      if (!quiet()) return false;
      const fd = openSync(this.path, 'wx', 0o600);
      this.transactionId = transactionId;
      try {
        writeFileSync(fd, JSON.stringify({ schemaVersion: 1, transactionId, instanceRef }) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      this.syncDirectory();
      return true;
    } finally { this.entering = false; }
  }
  resume(transactionId: string): boolean {
    if (this.stopping || transactionId !== this.transactionId) return false;
    unlinkSync(this.path);
    this.syncDirectory();
    this.transactionId = null;
    return true;
  }
  stop(transactionId: string): boolean {
    if (this.stopping || transactionId !== this.transactionId) return false;
    this.stopping = true;
    return true;
  }
  private syncDirectory(): void {
    if (process.platform === 'win32') return;
    const fd = openSync(dirname(this.path), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

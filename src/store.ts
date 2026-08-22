import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type {Status, Transaction} from './types.js';

export class ConcurrencyError extends Error {
  constructor(message = 'Transaction was modified by another request') { super(message); this.name = 'ConcurrencyError'; }
}
export interface Store {
  list(workspace: string): Promise<Transaction[]>;
  get(id: string, workspace: string): Promise<Transaction | undefined>;
  byKey(key: string, workspace: string): Promise<Transaction | undefined>;
  create(t: Transaction): Promise<{transaction: Transaction; created: boolean}>;
  save(t: Transaction, expectedVersion: number, expectedStatuses?: Status[]): Promise<void>;
}
const clone = <T>(value: T): T => structuredClone(value);
const normalize = (t: Transaction): Transaction => ({...t, version: t.version ?? 0});
export class FileStore implements Store {
  private queue: Promise<void> = Promise.resolve();
  constructor(private file = process.env.DATA_FILE || '.data/transactions.json') {}
  private async read(): Promise<Transaction[]> { try { return JSON.parse(await fs.readFile(this.file, 'utf8')) as Transaction[]; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
  private async write(all: Transaction[]) { await fs.mkdir(path.dirname(this.file), {recursive: true}); const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`; await fs.writeFile(tmp, JSON.stringify(all, null, 2), {mode: 0o600}); await fs.rename(tmp, this.file); }
  private locked<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work, work); this.queue = result.then(() => undefined, () => undefined); return result; }
  async list(workspace: string) { return (await this.read()).filter(t => t.workspaceId === workspace).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(t => clone(normalize(t))); }
  async get(id: string, workspace: string) { const found = (await this.read()).find(t => t.id === id && t.workspaceId === workspace); return found && clone(normalize(found)); }
  async byKey(key: string, workspace: string) { const found = (await this.read()).find(t => t.idempotencyKey === key && t.workspaceId === workspace); return found && clone(normalize(found)); }
  create(t: Transaction) { return this.locked(async () => { const all = await this.read(); const existing = all.find(x => x.workspaceId === t.workspaceId && x.idempotencyKey === t.idempotencyKey); if (existing) return {transaction: clone(normalize(existing)), created: false}; all.push(clone(t)); await this.write(all); return {transaction: clone(t), created: true}; }); }
  save(t: Transaction, expectedVersion: number, expectedStatuses?: Status[]) { return this.locked(async () => { const all = await this.read(); const index = all.findIndex(x => x.id === t.id && x.workspaceId === t.workspaceId); if (index < 0) throw new ConcurrencyError('Transaction no longer exists'); const current = all[index]; if ((current.version ?? 0) !== expectedVersion || (expectedStatuses && !expectedStatuses.includes(current.status))) throw new ConcurrencyError(); t.version = expectedVersion + 1; all[index] = clone(t); await this.write(all); }); }
}
export class PostgresStore implements Store {
  readonly pool: pg.Pool;
  constructor(connectionString = process.env.DATABASE_URL) { if (!connectionString) throw new Error('DATABASE_URL is required for PostgresStore'); this.pool = new pg.Pool({connectionString, max: 10, statement_timeout: 10_000}); }
  private row(row: {document: Transaction} | undefined) { return row?.document && clone(normalize(row.document)); }
  async list(workspace: string) { const r = await this.pool.query('SELECT document FROM transactions WHERE workspace_id=$1 ORDER BY created_at DESC', [workspace]); return r.rows.map(x => this.row(x)!); }
  async get(id: string, workspace: string) { return this.row((await this.pool.query('SELECT document FROM transactions WHERE id=$1 AND workspace_id=$2', [id, workspace])).rows[0]); }
  async byKey(key: string, workspace: string) { return this.row((await this.pool.query('SELECT document FROM transactions WHERE idempotency_key=$1 AND workspace_id=$2', [key, workspace])).rows[0]); }
  async create(t: Transaction) { const result = await this.pool.query('INSERT INTO transactions(id,workspace_id,idempotency_key,document,version,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING document', [t.id,t.workspaceId,t.idempotencyKey,t,t.version,t.createdAt]); if (result.rowCount) return {transaction:t,created:true}; const existing=await this.byKey(t.idempotencyKey,t.workspaceId); if(!existing) throw new ConcurrencyError('Idempotency conflict could not be resolved'); return {transaction:existing,created:false}; }
  async save(t: Transaction, expectedVersion: number, expectedStatuses?: Status[]) { const next=expectedVersion+1; t.version=next; const values:unknown[]=[t.id,t.workspaceId,expectedVersion,t,next]; let sql='UPDATE transactions SET document=$4,version=$5 WHERE id=$1 AND workspace_id=$2 AND version=$3'; if(expectedStatuses?.length){values.push(expectedStatuses);sql+=` AND document->>'status'=ANY($6::text[])`;} if((await this.pool.query(sql,values)).rowCount!==1){t.version=expectedVersion;throw new ConcurrencyError();} }
  async close(){await this.pool.end();}
}

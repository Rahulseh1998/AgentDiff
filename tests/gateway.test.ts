import { describe, expect, it } from 'vitest';
import { DemoProvider } from '../src/aws.js';
import { buildApp } from '../src/server.js';
import type { Store } from '../src/store.js';
import type { Transaction } from '../src/types.js';

class MemoryStore implements Store {
  transactions: Transaction[] = [];
  async list(workspace: string) { return this.transactions.filter(transaction => transaction.workspaceId === workspace); }
  async get(id: string, workspace: string) { return this.transactions.find(transaction => transaction.id === id && transaction.workspaceId === workspace); }
  async byKey(key: string, workspace: string) { return this.transactions.find(transaction => transaction.idempotencyKey === key && transaction.workspaceId === workspace); }
  async create(transaction: Transaction) {
    const existing = await this.byKey(transaction.idempotencyKey, transaction.workspaceId);
    if (existing) return { transaction: existing, created: false };
    this.transactions.push(transaction);
    return { transaction, created: true };
  }
  async save(transaction: Transaction, expectedVersion: number) {
    const index = this.transactions.findIndex(candidate => candidate.id === transaction.id);
    if (index === -1) this.transactions.push(transaction);
    else this.transactions[index] = transaction;
    transaction.version = expectedVersion + 1;
  }
}

const proposal = {
  idempotencyKey: 'integration-asg-0001', agent: 'Codex', sessionId: 'integration',
  intent: 'Scale down unused checkout capacity', operation: 'UpdateAutoScalingGroup',
  resource: 'checkout-prod', environment: 'production',
  params: { autoScalingGroupName: 'checkout-prod', desiredCapacity: 3, minSize: 2 },
  customerFacing: true, dependencies: ['checkout-api', 'order-service'],
};

describe('gateway transaction lifecycle', () => {
  it('plans, protects, approves, executes, verifies, and rolls back a reversible change', async () => {
    const app = buildApp({ store: new MemoryStore(), provider: new DemoProvider(), approvalToken: 'integration-token-1234' });
    const created = await app.inject({ method: 'POST', url: '/api/transactions', payload: proposal });
    expect(created.statusCode).toBe(201);
    const transaction = created.json<Transaction>();
    expect(transaction.status).toBe('AWAITING_APPROVAL');
    expect(transaction.beforeState.desiredCapacity).toBe(12);
    expect(transaction.risk.level).toBe('HIGH');

    const premature = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/execute`, headers: { 'x-approval-token': 'integration-token-1234' }, payload: { approver: 'test', comment: '' } });
    expect(premature.statusCode).toBe(409);
    const unauthorized = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/approve`, payload: { approver: 'test', comment: '' } });
    expect(unauthorized.statusCode).toBe(401);

    const approval = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/approve`, headers: { 'x-approval-token': 'integration-token-1234' }, payload: { approver: 'SRE', comment: 'Capacity reviewed' } });
    expect(approval.statusCode).toBe(200);
    expect(approval.json<Transaction>().status).toBe('APPROVED');
    const execution = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/execute`, headers: { 'x-approval-token': 'integration-token-1234' }, payload: { approver: 'SRE', comment: 'Execute approved plan' } });
    expect(execution.json<Transaction>()).toMatchObject({ status: 'COMMITTED', verification: 'VERIFIED', actualState: { desiredCapacity: 3 } });
    const rollback = await app.inject({ method: 'POST', url: `/api/transactions/${transaction.id}/rollback`, headers: { 'x-approval-token': 'integration-token-1234' }, payload: { approver: 'SRE', comment: 'Restore capacity' } });
    expect(rollback.json<Transaction>()).toMatchObject({ status: 'ROLLED_BACK', verification: 'VERIFIED', actualState: { desiredCapacity: 12, minSize: 8 } });
    await app.close();
  });

  it('isolates workspaces and renders escaped content', async () => {
    const app = buildApp({ store: new MemoryStore(), provider: new DemoProvider(), approvalToken: 'integration-token-1234' });
    await app.inject({ method: 'POST', url: '/api/transactions', headers: { 'x-workspace-id': 'alpha' }, payload: { ...proposal, idempotencyKey: 'workspace-alpha-001', intent: '<script>alert(1)</script>' } });
    const hidden = await app.inject({ method: 'GET', url: '/api/transactions' });
    expect(hidden.json()).toEqual([]);
    const visible = await app.inject({ method: 'GET', url: '/', headers: { 'x-workspace-id': 'alpha' } });
    expect(visible.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(visible.body).not.toContain('<script>alert(1)</script>');
    expect(visible.headers['x-frame-options']).toBe('DENY');
    await app.close();
  });
});

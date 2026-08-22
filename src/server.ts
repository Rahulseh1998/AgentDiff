import { pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import { z } from 'zod';
import { AwsProvider, DemoProvider, type Provider } from './aws.js';
import { TransactionService } from './service.js';
import { FileStore, PostgresStore, type Store } from './store.js';
import { dashboard, detail } from './ui.js';

const decisionSchema = z.object({
  approver: z.string().trim().min(1).max(100),
  comment: z.string().trim().max(500).default(''),
}).strict();
const workspaceSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

export interface AppOptions {
  store?: Store;
  provider?: Provider;
  approvalToken?: string;
  publicOrigin?: string;
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' ? false : {
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers.x-approval-token', '*.credentials', '*.secretAccessKey'],
    },
    requestIdHeader: 'x-request-id',
    trustProxy: process.env.TRUST_PROXY === 'true',
  });
  const store = options.store ?? (process.env.DATABASE_URL && process.env.USE_POSTGRES !== 'false' ? new PostgresStore() : new FileStore());
  const provider = options.provider ?? (process.env.DEMO_MODE === 'false' ? new AwsProvider() : new DemoProvider());
  const service = new TransactionService(store, provider);
  const approvalToken = options.approvalToken ?? process.env.APPROVAL_TOKEN;
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  const workspace = (headers: Record<string, unknown>) => workspaceSchema.parse(String(headers['x-workspace-id'] ?? 'default'));

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.headers({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      'cross-origin-opener-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-request-id': reply.request.id,
    });
    return payload;
  });

  app.get('/health', async () => ({ status: 'ok', mode: process.env.DEMO_MODE === 'false' ? 'aws' : 'demo' }));
  app.get('/metrics', async (_request, reply) => reply.type('text/plain').send(`agent_transaction_up 1\nprocess_uptime_seconds ${Math.floor(process.uptime())}\n`));
  app.get('/', async (request, reply) => reply.type('text/html').send(dashboard(await store.list(workspace(request.headers)))));
  app.get('/transactions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const transaction = await store.get(id, workspace(request.headers));
    return transaction ? reply.type('text/html').send(detail(transaction)) : reply.code(404).send({ error: 'Transaction not found' });
  });
  app.get('/api/transactions', async request => store.list(workspace(request.headers)));
  app.get('/api/transactions/:id', async (request, reply) => {
    const transaction = await store.get((request.params as { id: string }).id, workspace(request.headers));
    return transaction ?? reply.code(404).send({ error: 'Transaction not found' });
  });
  app.post('/api/transactions', async (request, reply) => reply.code(201).send(await service.propose(request.body, workspace(request.headers))));

  const authorizeMutation = async (request: { headers: Record<string, unknown> }, reply: { code(status: number): { send(body: unknown): unknown } }) => {
    if (!approvalToken || approvalToken.length < 16) return reply.code(503).send({ error: 'Operator authentication is not configured' });
    if (request.headers['x-approval-token'] !== approvalToken) return reply.code(401).send({ error: 'Invalid operator credentials' });
    const origin = request.headers.origin;
    if (origin && publicOrigin && origin !== publicOrigin) return reply.code(403).send({ error: 'Cross-origin mutation rejected' });
  };

  app.post('/api/transactions/:id/approve', { preHandler: authorizeMutation }, async request => {
    const body = decisionSchema.parse(request.body);
    return service.decide((request.params as { id: string }).id, 'APPROVE', body.approver, body.comment, workspace(request.headers));
  });
  app.post('/api/transactions/:id/reject', { preHandler: authorizeMutation }, async request => {
    const body = decisionSchema.parse(request.body);
    return service.decide((request.params as { id: string }).id, 'REJECT', body.approver, body.comment, workspace(request.headers));
  });
  for (const action of ['execute', 'rollback'] as const) {
    app.post(`/api/transactions/:id/${action}`, { preHandler: authorizeMutation }, async request => {
      // Parse and discard the audit metadata accepted by the shared web dialog. The service records the acting system transition.
      decisionSchema.parse(request.body);
      const id = (request.params as { id: string }).id;
      return action === 'execute' ? service.execute(id, workspace(request.headers)) : service.rollback(id, workspace(request.headers));
    });
  }

  app.setErrorHandler((error, _request, reply) => {
    const validation = error instanceof z.ZodError;
    const notFound = error.message === 'Transaction not found';
    reply.code(validation ? 400 : notFound ? 404 : 409).send({ error: validation ? 'Invalid request payload' : error.message });
  });
  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = buildApp();
  app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' }).catch(error => {
    app.log.error(error);
    process.exit(1);
  });
}

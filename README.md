# Agent Transaction

Change intelligence and transactional safety for autonomous AWS agents. The gateway turns allow-listed AWS writes into reviewable transactions: capture state, deterministic semantic diff, dependency evidence, explainable risk, policy, approval, execution, verification, audit history, and honest rollback.

## Architecture

A TypeScript modular monolith exposes HTTP/UI and an MCP stdio server. Core transaction concepts are strongly typed. `TransactionService` owns lifecycle invariants; providers isolate demo and real AWS SDK v3 execution. Demo persistence is an atomic mode-0600 file. A PostgreSQL migration is supplied; wiring its repository for multi-instance production is a known limitation.

## Quickstart and best demo

```bash
cp .env.example .env
npm install
APPROVAL_TOKEN=change-this-demo-token DEMO_MODE=true npm run dev
# another terminal
npm run db:seed
```

Open http://localhost:3000. Review checkout's 12→3 plan, enter `change-this-demo-token`, approve, execute, and rollback. The IAM wildcard scenario is blocked; the development Lambda change is auto-approved. Stable `idempotencyKey` values prevent replay.

## Connect Claude Code / Codex with MCP

Start the gateway and configure an stdio server:

```json
{"mcpServers":{"agent-transaction":{"command":"npm","args":["run","mcp"],"cwd":"/absolute/path/AgentDiff","env":{"GATEWAY_URL":"http://localhost:3000","WORKSPACE_ID":"default"}}}}
```

Agents call `propose_aws_change`, then `get_change_status`. There is deliberately no arbitrary AWS proxy tool.

## Connect an AWS sandbox

Set `DEMO_MODE=false`, `AWS_REGION`, and optionally `AWS_ROLE_ARN`. Local development uses the normal AWS credential chain. Production should use workload identity and role assumption for temporary credentials. Grant only Describe/Get and exact mutation APIs. Never configure static keys in the application; test in a dedicated sandbox first.

## Database, environment, and deployment

Environment variables are documented in `.env.example`. Run `npm run db:migrate` with `DATABASE_URL` to create the PostgreSQL table and workspace/idempotency constraint. `docker compose up --build` runs a durable single-node demo. Production should terminate TLS at a trusted proxy, inject a random 32+ byte approval token, persist data, disable demo mode, and monitor `/health` and `/metrics`.

## Security model

Strict Zod validation and operation allow-listing constrain proposals. Approval/execution require a server-side secret; reads are workspace-scoped; state transitions prevent premature, blocked, repeated execution and invalid rollback. Credentials are not stored, logs redact sensitive headers, output is HTML-escaped, security headers are emitted, failures remain truthful, and transitions are audited. The shared approval token and caller-provided workspace header require replacement by OIDC/RBAC and trusted workspace claims before multi-tenant production use.

## Supported actions and guarantees

| Action | Plan / semantic diff / risk | Verification | Rollback |
|---|---|---|---|
| UpdateAutoScalingGroup | Yes | Configuration | Fully reversible |
| UpdateService | Yes | Configuration | Fully reversible |
| UpdateFunctionConfiguration | Yes | Configuration | Fully reversible |
| StopInstances | Yes | State, partial | Compensatable; start not exposed |
| TerminateInstances | Yes | State | Irreversible |
| DeleteFunction | Yes | Existence | Irreversible |
| PutRolePolicy | Yes, wildcard block | Policy | Partial when newly created |
| AttachRolePolicy | Yes | Partial | Detach not exposed |
| UpdateAssumeRolePolicy | Yes | Partial | Fully reversible |
| PutBucketPolicy | Yes | Policy | Fully reversible |
| DeleteBucket | Yes | Existence | Irreversible |

Rollback is offered only for non-irreversible classifications and verifies captured fields. Treat explicitly partial cases conservatively.

## Tests and checks

```bash
npm test
npm run lint
npm run build
docker build -t agent-transaction .
npm audit --omit=dev
```

## Known limitations and next five improvements

There is no multi-user OIDC/RBAC, distributed lock/worker, CloudWatch stabilization gate, or wired Postgres repository. Some provider verification is partial. Priorities by customer value: (1) OIDC and workspace membership, (2) Postgres transactions and advisory locks, (3) complete IAM/EC2 compensators, (4) asynchronous stabilization plus CloudWatch evidence, (5) Resource Explorer dependency discovery.

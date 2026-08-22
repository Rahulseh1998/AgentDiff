# Security policy

Agent Transaction sits on a privileged execution path. Please report vulnerabilities privately to the repository maintainers rather than opening a public issue.

## Production baseline

- Run the gateway behind TLS and an identity-aware proxy. The built-in approval token is intended for a single-workspace V1 deployment, not public multi-tenancy.
- Use workload identity and an assumable, least-privilege executor role. Never inject long-lived AWS access keys.
- Separate the gateway's read/planning role from its mutation role where deployment infrastructure permits it.
- Restrict ingress to the agent and operator networks, rotate `APPROVAL_TOKEN`, and retain immutable copies of audit records.
- Pin container images, scan dependencies and images, back up PostgreSQL, and alert on `FAILED`, `ROLLBACK_FAILED`, and health-check failures.

## Threat model notes

The service rejects operations outside its compile-time allow-list, validates request shapes, scopes records to a workspace, and gates mutations on lifecycle state and operator authentication. It never accepts shell commands or provider credentials in its API. Provider permissions remain the final security boundary, so executor IAM should deny operations the application is not expected to perform.

Known risks and compensating controls are maintained in the README. Before multi-tenant use, replace caller-supplied workspace headers and the shared approval token with verified identity claims and server-side membership checks.

import pg from 'pg';
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
await c.connect();
await c.query(`CREATE TABLE IF NOT EXISTS transactions(
 id text PRIMARY KEY, workspace_id text NOT NULL, idempotency_key text NOT NULL,
 document jsonb NOT NULL, version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(workspace_id,idempotency_key)
); ALTER TABLE transactions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS transactions_workspace_created ON transactions(workspace_id,created_at DESC)`);
await c.end(); console.log('Migration complete');

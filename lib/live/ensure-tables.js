// Creates the Live tables on the database from NEON_DB_URL.
// Usage: npm run db:live
const db = require('../db');

const TABLES = ['live_graph', 'live_graph_history', 'live_graph_snapshots'];

async function main() {
  db.configure();
  const cfg = db.getConfig();
  if (!cfg.host || cfg.host === 'localhost') {
    console.error('NEON_DB_URL is not set. This command does not touch localhost.');
    process.exit(1);
  }
  await db.ensureLiveTables();
  const pool = db.getPool();
  const found = await pool.query(
    `SELECT c.relname AS table_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
     ORDER BY c.relname`,
    [TABLES]
  );
  const present = new Set(found.rows.map(row => row.table_name));
  console.log(`database: ${cfg.host}/${cfg.database}`);
  for (const name of TABLES) {
    if (!present.has(name)) {
      console.error(`${name}: missing`);
      process.exitCode = 1;
      continue;
    }
    const count = await pool.query(`SELECT COUNT(*)::int AS n FROM ${name}`);
    console.log(`${name}: present, ${count.rows[0].n} rows`);
  }
  await pool.end();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

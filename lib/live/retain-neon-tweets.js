const db = require('../db');
const { readEnvFile, redact } = require('./neon-sync');
const { retainTweets } = require('./tweet-retention');
const path = require('path');

async function main() {
  const env = readEnvFile(path.resolve(__dirname, '../../.env'));
  for (const key of ['NEON_DB_URL', 'TWEET_ARCHIVE_DB_URL']) {
    if (!(process.env[key] || env[key] || '').trim()) throw new Error(`${key} is required`);
  }
  db.configure();
  try {
    const archived = await retainTweets(db, {
      setup: process.argv.includes('--setup'),
      onCopied: count => console.log(`Archive ready. Copied ${count} tweet and related records. Starting Neon cleanup.`),
    });
    console.log(`Expired tweet and snapshot rows removed from Neon after archiving: ${archived}.`);
  } finally {
    await db.getPool().end();
  }
}

main().catch(err => {
  console.error(redact(err.message));
  process.exitCode = 1;
});

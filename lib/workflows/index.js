// Workflow registry. Each workflow is an isolated module exporting:
//   {
//     id:          string,                    // unique slug
//     platform:    'x' | 'linkedin' | 'both', // which platform tab shows it
//     label:       string,
//     description: string,
//     run(ctx):    async fn -> { ok, ...stats }
//   }
//
// ctx is built per-invocation by main.js (see main.js run-workflow handler).
// Workflows MUST NOT import main.js. All deps come through ctx.

const liFillProspects = require('./li-fill-prospects');
const xFillProspects  = require('./x-fill-prospects');

const WORKFLOWS = [
  liFillProspects,
  xFillProspects,
  // X "list-sweep" stays in main.js for now (legacy inline pipeline).
  // Migrate later by exposing it here with the same shape.
];

const byId = new Map(WORKFLOWS.map(w => [w.id, w]));

function get(id)         { return byId.get(id) || null; }
function list(platform)  {
  if (!platform) return WORKFLOWS;
  return WORKFLOWS.filter(w => w.platform === platform || w.platform === 'both');
}

module.exports = { get, list, WORKFLOWS };

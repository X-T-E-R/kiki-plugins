import { readFileSync, writeFileSync } from 'node:fs';

const stateFile = process.env.COCKPIT_HARNESS_FIXTURE_STATE;
const leases = new Set();
let sequence = Promise.resolve();
let inputBuffer = '';

function record(event) {
  if (!stateFile) return;
  const state = (() => {
    try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { requests: [], releases: [], eof: false }; }
  })();
  state.requests ??= [];
  state.releases ??= [];
  state.requests.push(event);
  writeFileSync(stateFile, JSON.stringify(state));
}

function response(id, result, error) {
  const value = error ? { id, error: { message: error } } : { id, result };
  process.stdout.write(JSON.stringify(value) + '\n');
}

function handle(line) {
  let input;
  try { input = JSON.parse(line); } catch { response('', undefined, 'fixture received invalid JSON'); return; }
  record({ method: input.method, params: input.params });
  if (input.method === 'list') {
    response(input.id, [{ id: `${input.params.engineId}-account`, label: `${input.params.engineId} fixture`, status: 'ready' }]);
    return;
  }
  if (input.method === 'prepare') {
    const leaseId = `lease-${input.params.engineId}-${input.params.instanceId}`;
    const answer = () => {
      leases.add(leaseId);
      response(input.id, {
        leaseId,
        connection: {
          protocol: 'openai-compatible',
          baseUrl: `https://fixture.invalid/${input.params.engineId}`,
          apiKey: `fixture-secret-${leaseId}`,
          modelIds: [`${input.params.engineId}-model`],
        },
      });
    };
    if (input.params.instanceId === 'slow') setTimeout(answer, 100);
    else answer();
    return;
  }
  if (input.method === 'release') {
    if (process.env.COCKPIT_HARNESS_FIXTURE_FAIL_RELEASE === input.params.leaseId) {
      response(input.id, undefined, 'fixture release failed once');
      return;
    }
    leases.delete(input.params.leaseId);
    const state = (() => {
      try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { requests: [], releases: [], eof: false }; }
    })();
    state.releases ??= [];
    state.releases.push(input.params.leaseId);
    writeFileSync(stateFile, JSON.stringify(state));
    response(input.id, { released: true });
    return;
  }
  response(input.id, undefined, 'fixture received an unknown method');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += String(chunk);
  const lines = inputBuffer.split(/\r?\n/);
  inputBuffer = lines.pop() ?? '';
  sequence = sequence.then(async () => {
    for (const line of lines.filter(Boolean)) handle(line);
  });
});
process.stdin.on('end', async () => {
  if (inputBuffer.trim()) sequence = sequence.then(async () => handle(inputBuffer));
  await sequence;
  leases.clear();
  if (stateFile) {
    const state = (() => {
      try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return { requests: [], releases: [], eof: false }; }
    })();
    state.eof = true;
    state.leaseCountAtEof = leases.size;
    writeFileSync(stateFile, JSON.stringify(state));
  }
  process.exit(0);
});

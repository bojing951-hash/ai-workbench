import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const stub = `
const http = require('node:http');
const { appendFileSync } = require('node:fs');
let calls = 0;
http.createServer((req, res) => {
  let status = 404;
  if (req.method === 'GET' && req.url === '/api/health') status = 200;
  if (req.method === 'POST' && req.url === '/api/supervisor/recover') {
    calls += 1;
    status = 200;
  }
  appendFileSync('seen.jsonl', JSON.stringify({ url: req.url, status, pid: process.pid }) + '\\n');
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data: { recoveredRuns: [], recoveredLoops: [{ loopId: 'temp-loop', resumed: calls > 1, reason: calls === 1 ? 'temporary resource unavailable' : '' }] } }));
}).listen(Number(process.argv.at(-1)), '127.0.0.1');
`;

async function reservePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(err => err ? reject(err) : resolve()));
  return port;
}

async function readEvents(root) {
  let lines;
  try {
    lines = await readFile(path.join(root, 'seen.jsonl'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('Supervisor retries a transient failed loop in a successful HTTP response until reconciled', { timeout: 65000 }, async t => {
  const supervisorPath = path.resolve('supervisor/workbench-supervisor.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'wb-supervisor-acceptance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bin'));
  await writeFile(path.join(root, 'bin', 'workbench.js'), stub);

  const supervisor = spawn(process.execPath, [supervisorPath, '--root', root, '--port', String(await reservePort())], {
    cwd: root,
    env: { PATH: process.env.PATH || '', HOME: root },
    stdio: 'ignore',
  });
  const exited = once(supervisor, 'exit');
  let events;
  try {
    const deadline = Date.now() + 29000;
    for (;;) {
      assert.equal(supervisor.exitCode, null, 'supervisor exited before reconciliation');
      events = await readEvents(root);
      const recoveryResponses = events.map((e, i) => e.url === '/api/supervisor/recover' ? i : -1).filter(i => i >= 0);
      const success = recoveryResponses[1] ?? -1;
      const subsequentHealth = success < 0 ? 0 : events.slice(success + 1).filter(e => e.url === '/api/health').length;
      if ((events.filter(e => e.url === '/api/supervisor/recover').length >= 2 && subsequentHealth >= 2) || Date.now() >= deadline) break;
      await delay(125);
    }
  } finally {
    supervisor.kill('SIGTERM');
    await exited;
  }

  const health = events.filter(e => e.url === '/api/health');
  const recover = events.filter(e => e.url === '/api/supervisor/recover');
  assert.ok(health.length >= 3 && health.every(e => e.status === 200), 'fixture must stay healthy');
  assert.equal(new Set(health.map(e => e.pid)).size, 1, 'the healthy child should survive the transient response');
  console.log(JSON.stringify({healthCount:health.length, recoverCount:recover.length, recoverStatus:recover.map(e=>e.status), stableChild: new Set(health.map(e => e.pid)).size===1})); assert.deepEqual(recover.map(e => e.status), [200, 200], 'retry transient per-loop failure marked resumed:false in an HTTP-200 receipt');
  const successIndex = events.indexOf(recover[1]);
  assert.ok(events.slice(successIndex + 1).filter(e => e.url === '/api/health').length >= 2,
    'observe at least two more health checks after successful reconciliation');
});

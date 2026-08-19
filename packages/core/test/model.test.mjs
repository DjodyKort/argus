import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { complete } from '../src/model.mjs';

// Stub servers rather than mocks: the risky part of an adapter is the wire format, and a mock of your
// own assumptions cannot tell you the assumption was wrong.

const servers = [];

const stub = async (handler) => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => handler(req, JSON.parse(body || '{}'), res));
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

after(() => {
  for (const server of servers) {
    server.close();
  }
});

test('the openai-compatible route sends and reads the expected shape', async () => {
  let seen;
  const url = await stub((req, body, res) => {
    seen = { path: req.url, auth: req.headers.authorization, body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"checks":[],"unverified":[]}' } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
    );
  });

  const answer = await complete({
    route: 'local-primary',
    baseUrl: url,
    apiKey: 'k',
    model: 'some-model',
    system: 'sys',
    user: 'usr',
  });

  assert.equal(seen.path, '/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer k');
  // System and user must arrive as separate roles: folding them together loses the distinction the
  // prohibitions rely on.
  assert.deepEqual(seen.body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(seen.body.messages[0].content, 'sys');
  assert.equal(answer.text, '{"checks":[],"unverified":[]}');
  assert.equal(answer.usage.prompt_tokens, 11);
});

test('a gateway needing no key sends no authorization header', async () => {
  let seen;
  const url = await stub((req, body, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });

  await complete({ route: 'local-fallback', baseUrl: url, model: 'm', system: 's', user: 'u' });
  assert.equal(seen.authorization, undefined);
});

test('the anthropic route sends its own headers and joins content parts', async () => {
  let seen;
  const url = await stub((req, body, res) => {
    seen = { path: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }],
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );
  });

  const answer = await complete({ route: 'api', baseUrl: url, apiKey: 'sk-test', model: 'm', system: 's', user: 'u' });

  assert.equal(seen.path, '/v1/messages');
  assert.equal(seen.key, 'sk-test');
  assert.ok(seen.version);
  // Anthropic takes system as a top-level field, not a message.
  assert.equal(seen.body.system, 's');
  assert.equal(seen.body.messages.length, 1);
  assert.equal(answer.text, 'part one part two');
});

test('an error status carries the body, because that is where a refusal explains itself', async () => {
  const url = await stub((req, body, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'autonomous work stopped: 92% of included headroom used' } }));
  });

  await assert.rejects(
    () => complete({ route: 'local-primary', baseUrl: url, model: 'm', system: 's', user: 'u' }),
    /429.*included headroom/s,
  );
});

test('a non-JSON body fails with the body rather than a parser stack trace', async () => {
  const url = await stub((req, body, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>gateway login page</html>');
  });

  await assert.rejects(
    () => complete({ route: 'local-primary', baseUrl: url, model: 'm', system: 's', user: 'u' }),
    /was not JSON: <html>gateway login page/,
  );
});

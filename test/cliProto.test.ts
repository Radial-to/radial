import { test } from 'node:test';
import assert from 'node:assert';
import * as proto from '../src/main/cliProto';

test('decoder reassembles JSON lines across chunk boundaries and skips junk', () => {
  const got: Record<string, unknown>[] = [];
  const feed = proto.makeDecoder((m) => got.push(m));
  feed('{"op":"a"}\n{"op":"b",');
  feed('"x":1}\nnot json\n\n');
  feed('{"op":"c"}');
  assert.deepEqual(got, [{ op: 'a' }, { op: 'b', x: 1 }]);
  feed('\n');
  assert.deepEqual(got.map((m) => m.op), ['a', 'b', 'c']);
});

test('encode ends every frame with a newline', () => {
  assert.equal(proto.encode({ op: 'reply', reqId: '1', ok: true }), '{"op":"reply","reqId":"1","ok":true}\n');
});

test('exit codes: ok 0, ambiguity 2, not found 3, unreachable 4, refusals 6, other errors 1', () => {
  assert.equal(proto.exitCodeFor({ ok: true }), 0);
  assert.equal(proto.exitCodeFor({ ok: false, code: 'ambiguous' }), 2);
  assert.equal(proto.exitCodeFor({ ok: false, code: 'bad-request' }), 2);
  assert.equal(proto.exitCodeFor({ ok: false, code: 'not-found' }), 3);
  assert.equal(proto.exitCodeFor({ ok: false, code: 'unreachable' }), 4);
  assert.equal(proto.exitCodeFor({ ok: false, code: 'timeout' }), 4);
  for (const c of ['needs-yes', 'not-open', 'no-dev-server', 'no-engine', 'no-browser', 'not-asking']) assert.equal(proto.exitCodeFor({ ok: false, code: c }), 6, c);
  assert.equal(proto.exitCodeFor({ ok: false, code: 'error' }), 1);
  assert.equal(proto.exitCodeFor({ ok: false, code: 'something-new' }), 1);
  assert.equal(proto.exitCodeFor(null), 4);
});

test('err() keeps known codes and downgrades unknown ones to error', () => {
  assert.deepEqual(proto.err('not-open', 'closed'), { ok: false, code: 'not-open', error: 'closed' });
  // @ts-expect-error err() narrows an unknown code at runtime (CODES.includes) and downgrades it to 'error'
  assert.equal(proto.err('made-up', 'x').code, 'error');
  assert.deepEqual(proto.err('not-found', 'x', { repoDir: '/a' }).repoDir, '/a');
});

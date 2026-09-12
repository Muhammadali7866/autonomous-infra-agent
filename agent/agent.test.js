const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractJsonObject,
  parseDecision,
  validateDecision,
} = require('./agent');

test('extracts plain JSON', () => {
  assert.equal(extractJsonObject('{"action":"none"}'), '{"action":"none"}');
});

test('extracts JSON wrapped in Markdown', () => {
  const raw = '```json\n{"action":"scale_up","replicas":2}\n```';
  assert.equal(extractJsonObject(raw), '{"action":"scale_up","replicas":2}');
});

test('extracts JSON surrounded by explanatory text', () => {
  const raw = 'Decision follows: {"action":"alert","confidence":0.9} End.';
  assert.deepEqual(JSON.parse(extractJsonObject(raw)), {
    action: 'alert',
    confidence: 0.9,
  });
});

test('parses and normalizes a valid decision', () => {
  assert.deepEqual(parseDecision(JSON.stringify({
    action: 'scale_up',
    replicas: 3,
    confidence: 0.8,
    reasoning: 'Latency is rising.',
    predicted_issue: 'Requests may time out.',
  })), {
    action: 'scale_up',
    replicas: 3,
    confidence: 0.8,
    reasoning: 'Latency is rising.',
    predicted_issue: 'Requests may time out.',
  });
});

test('rejects invalid action and replica values', () => {
  assert.throws(() => validateDecision({
    action: 'delete_all',
    confidence: 0.8,
  }), /Invalid action/);

  assert.throws(() => validateDecision({
    action: 'scale_up',
    replicas: 9,
    confidence: 0.8,
  }), /Replicas must be an integer/);
});

test('rejects malformed model output', () => {
  assert.throws(() => parseDecision('not JSON'), /Invalid LLM JSON/);
  assert.throws(() => parseDecision(JSON.stringify({
    action: 'none',
    confidence: 2,
  })), /Confidence must be/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSettings } from '../src/core/settings.ts';

test('Queue defaults to enabled and preserves explicit false across reloads', () => {
  for (const value of [undefined, null, {}, { enabled: true }, { enabled: 'false' }])
    assert.equal(parseSettings(value).enabled, true);
  assert.equal(parseSettings(JSON.parse(JSON.stringify({ enabled: false }))).enabled, false);
});

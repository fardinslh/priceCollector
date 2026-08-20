import assert from 'node:assert/strict';
import test from 'node:test';
import { FixedWindowRateLimiter } from '../src/utils/rateLimiter.js';
import { makeCallbackData, resolveCallbackData } from '../src/utils/telegramCallback.js';

test('Persian callback data stays inside Telegram byte limit', () => {
  const data = makeCallbackData(
    'alert',
    'گوشی موبایل سامسونگ گلکسی اس بیست و چهار اولترا',
    29_678_000
  );

  assert.ok(Buffer.byteLength(data, 'utf8') <= 64);
  assert.match(data, /^alert:[a-f0-9]{16}$/);
  assert.deepEqual(resolveCallbackData('alert', data), {
    query: 'گوشی موبایل سامسونگ گلکسی اس بیست و چهار اولترا',
    price: 29_678_000,
  });
});

test('rate limiter resets after its fixed window', () => {
  const limiter = new FixedWindowRateLimiter(2, 1_000);
  assert.equal(limiter.consume('user', 0), true);
  assert.equal(limiter.consume('user', 10), true);
  assert.equal(limiter.consume('user', 20), false);
  assert.equal(limiter.consume('user', 1_000), true);
});

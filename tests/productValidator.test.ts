import assert from 'node:assert/strict';
import test from 'node:test';
import { deterministicFilterAndRank, matchesGenerationAndNumber } from '../src/services/productValidator.js';

test('AirPods generation must be present in the candidate title', () => {
  assert.equal(matchesGenerationAndNumber('هدفون بی سیم اپل مدل ایرپاد پرو', 'AirPods Pro 2'), false);
  assert.equal(matchesGenerationAndNumber('Apple AirPods Pro 2nd Generation USB-C', 'AirPods Pro 2'), true);
  assert.equal(matchesGenerationAndNumber('هدفون ایرپاد پرو ۲ اپل', 'ایرپاد پرو ۲'), true);
});

test('ranker rejects a cheaper generic AirPods listing for a generation-specific query', () => {
  const result = deterministicFilterAndRank(
    [
      { title: 'هدفون بی سیم اپل مدل ایرپاد پرو', price: 19_460_000, status: 'available' },
      { title: 'هدفون بی سیم اپل مدل ایرپاد پرو 2 تایپ سی', price: 28_690_000, status: 'available' },
    ],
    'AirPods Pro 2'
  );

  assert.equal(result?.price, 28_690_000);
});

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceUsage, resolvePricingWindow, validatePricingRequest } from '../lib/pricing.js'

const usage = { inputTokens: 1_000_000, cacheCreationTokens: 100_000, cacheReadTokens: 2_000_000, outputTokens: 500_000 }

test('DeepSeek pricing resolves UTC peak windows and disjoint token fields', () => {
  const priced = priceUsage({
    tableId: 'deepseek-v4-2026-08-13',
    at: '2026-08-19T02:30:00.000Z',
    model: 'deepseek-v4-flash',
    usage
  })
  assert.equal(priced.window, 'peak')
  assert.equal(priced.tokens.input, 1_100_000)
  assert.ok(Math.abs(priced.costUsd - (1.1 * 0.44 + 2 * 0.014 + 0.5 * 1.32)) < 1e-12)
  assert.equal(resolvePricingWindow('deepseek-v4-2026-08-13', '2026-08-19T04:00:00Z'), 'offPeak')
})

test('Zen free routes price exactly zero', () => {
  const priced = priceUsage({
    tableId: 'opencode-zen-free-2026-08-19',
    at: '2026-08-19T12:00:00Z',
    model: 'custom:nemotron-3-5-lightning-free-OpenCode-Zen-free-10',
    usage
  })
  assert.equal(priced.model, 'nemotron-3.5-lightning-free')
  assert.equal(priced.costUsd, 0)
})

test('pricing refuses stale timestamps and unknown paid routes', () => {
  assert.throws(() => validatePricingRequest({
    tableId: 'deepseek-v4-2026-08-13', at: '2026-08-12T23:59:59Z', model: 'deepseek-v4-pro'
  }), /not effective/)
  assert.throws(() => validatePricingRequest({
    tableId: 'deepseek-v4-2026-08-13', at: '2026-08-19T00:00:00Z', model: 'unknown-paid-model'
  }), /not in/)
})

test('native Droid records observed Factory credits without a USD fiction', () => {
  const priced = priceUsage({
    tableId: 'factory-credits-observed-v1',
    at: '2026-08-19T00:00:00Z',
    model: 'native-droid',
    native: true,
    usage: { factoryCredits: 42 }
  })
  assert.equal(priced.observedFactoryCredits, 42)
  assert.equal(priced.costUsd, null)
  assert.throws(() => priceUsage({
    tableId: 'factory-credits-observed-v1', at: '2026-08-19T00:00:00Z', model: 'native-droid', native: true, usage: {}
  }), /factoryCredits/)
})

const SOURCE_DEEPSEEK = 'https://api-docs.deepseek.com/quick_start/pricing/'
const SOURCE_ZEN = 'https://opencode.ai/docs/zen/'
const SOURCE_FACTORY = 'https://docs.factory.ai/api-reference/analytics'

const TABLES = {
  'deepseek-v4-2026-08-13': {
    id: 'deepseek-v4-2026-08-13',
    effectiveAt: '2026-08-13T00:00:00.000Z',
    source: SOURCE_DEEPSEEK,
    billingUnit: 'USD',
    models: {
      'deepseek-v4-flash': {
        peak: { input: 0.44, cacheRead: 0.014, output: 1.32 },
        offPeak: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      },
      'deepseek-v4-pro': {
        peak: { input: 1.32, cacheRead: 0.044, output: 3.96 },
        offPeak: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      }
    }
  },
  'opencode-zen-free-2026-08-19': {
    id: 'opencode-zen-free-2026-08-19',
    effectiveAt: '2026-08-19T00:00:00.000Z',
    source: SOURCE_ZEN,
    billingUnit: 'USD',
    models: [
      'hy3-free',
      'laguna-s-2.1-free',
      'nemotron-3.5-lightning-free',
      'nemotron-3-ultra-free'
    ]
  },
  'factory-credits-observed-v1': {
    id: 'factory-credits-observed-v1',
    effectiveAt: '2026-08-18T00:00:00.000Z',
    source: SOURCE_FACTORY,
    billingUnit: 'Factory Standard Credits'
  }
}

function getPricingTable (id) {
  const table = TABLES[id]
  if (!table) throw new Error(`unknown pricing table: ${id}`)
  return structuredClone(table)
}

function cleanModel (model) {
  const cleaned = String(model ?? '')
    .replace(/^custom:/, '')
    .replace(/-OpenCode-Zen-free-\d+$/, '')
  const aliases = {
    'laguna-s-2-1-free': 'laguna-s-2.1-free',
    'nemotron-3-5-lightning-free': 'nemotron-3.5-lightning-free'
  }
  return aliases[cleaned] ?? cleaned
}

function checkedDate (at, table) {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) throw new Error(`invalid pricing timestamp: ${at}`)
  if (date < new Date(table.effectiveAt)) {
    throw new Error(`pricing table ${table.id} is not effective at ${date.toISOString()}`)
  }
  return date
}

function resolvePricingWindow (tableId, at) {
  const table = getPricingTable(tableId)
  const date = checkedDate(at, table)
  if (tableId !== 'deepseek-v4-2026-08-13') return 'standard'
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? 'peak' : 'offPeak'
}

function validatePricingRequest ({ tableId, at, model, native = false }) {
  const table = getPricingTable(tableId)
  checkedDate(at, table)
  const normalized = cleanModel(model)
  if (tableId === 'factory-credits-observed-v1') {
    if (!native) throw new Error(`${tableId} only prices native Droid routes`)
  } else if (tableId === 'opencode-zen-free-2026-08-19') {
    if (!table.models.includes(normalized)) throw new Error(`model is not in ${tableId}: ${model}`)
  } else if (!table.models[normalized]) {
    throw new Error(`model is not in ${tableId}: ${model}`)
  }
  return { table, normalized }
}

function priceUsage ({ tableId, at, model, usage, native = false }) {
  if (!usage || typeof usage !== 'object') throw new Error('usage is required for pricing')
  const { table, normalized } = validatePricingRequest({ tableId, at, model, native })
  const window = resolvePricingWindow(tableId, at)
  const common = {
    tableId,
    effectiveAt: table.effectiveAt,
    source: table.source,
    observedAt: new Date(at).toISOString(),
    model: native ? 'native-droid' : normalized,
    window,
    billingUnit: table.billingUnit
  }
  if (tableId === 'factory-credits-observed-v1') {
    const credits = usage.factoryCredits
    if (typeof credits !== 'number' || !Number.isFinite(credits) || credits < 0) {
      throw new Error('native Droid usage is missing non-negative factoryCredits')
    }
    return { ...common, observedFactoryCredits: credits, costUsd: null }
  }
  const rates = tableId === 'opencode-zen-free-2026-08-19'
    ? { input: 0, cacheRead: 0, output: 0 }
    : table.models[normalized][window]
  const tokens = {
    input: (usage.inputTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
    cacheRead: usage.cacheReadTokens ?? 0,
    output: usage.outputTokens ?? 0
  }
  for (const [name, value] of Object.entries(tokens)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`invalid ${name} token count`)
  }
  const costUsd = (tokens.input * rates.input + tokens.cacheRead * rates.cacheRead + tokens.output * rates.output) / 1_000_000
  return { ...common, ratesPerMillionTokens: rates, tokens, costUsd }
}

export { getPricingTable, priceUsage, resolvePricingWindow, validatePricingRequest }

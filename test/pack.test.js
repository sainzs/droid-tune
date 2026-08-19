import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { sha256String, sha256File, writeEvidencePack } from '../lib/pack.js'

function sha (buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function tmpBase () {
  return mkdtemp(path.join(os.tmpdir(), 'droidtune-pack-test-'))
}

async function fixtureInputs (base) {
  const instruction = path.join(base, 'instruction.md')
  const testsDir = path.join(base, 'tests-in')
  await writeFile(instruction, '# Task\n\nDo the thing.\n')
  await mkdir(path.join(testsDir, 'a'), { recursive: true })
  await writeFile(path.join(testsDir, 'a', 'b.sh'), '#!/bin/sh\nexit 0\n')
  await writeFile(path.join(testsDir, 'c.test.js'), 'export default 1\n')
  const ledger = path.join(base, 'events.log')
  await writeFile(ledger, '{"seq":1}\n{"seq":2}\n')
  const transcript = path.join(base, 'transcript.log')
  await writeFile(transcript, '{"type":"message"}\n')
  return { instruction, testsDir, ledger, transcript }
}

test('full pack writes every artifact and manifest hashes match recomputation', async () => {
  const base = await tmpBase()
  try {
    const out = path.join(base, 'pack')
    const { instruction, testsDir, ledger, transcript } = await fixtureInputs(base)
    const manifest = await writeEvidencePack(out, {
      trialId: 'trial-001',
      provenance: { droidVersion: '0.197.0', modelRoute: 'core' },
      instructionPath: instruction,
      testsDir,
      results: { outcome: 'VERIFIED_PASS', pass: 2, fail: 0 },
      configSnapshot: { model: 'native-droid' },
      ledgerPath: ledger,
      transcriptPath: transcript,
      patchDiff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
      usage: { inputTokens: 10, outputTokens: 20 },
      pricing: { table: 'v1', rate: 0.5 },
      errors: { none: true }
    })
    const expected = {
      'instruction.md': ['# Task\n\nDo the thing.\n', null],
      'results.json': ['{"outcome":"VERIFIED_PASS","pass":2,"fail":0}', null],
      'config.snapshot.json': ['{"model":"native-droid"}', null],
      'events.jsonl': [null, ledger],
      'transcript.jsonl': [null, transcript],
      'patch.diff': ['--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n', null],
      'usage.json': ['{"inputTokens":10,"outputTokens":20}', null],
      'pricing.json': ['{"table":"v1","rate":0.5}', null],
      'errors.json': ['{"none":true}', null],
      'tests/a/b.sh': ['#!/bin/sh\nexit 0\n', null],
      'tests/c.test.js': ['export default 1\n', null]
    }
    for (const [rel, [text, src]] of Object.entries(expected)) {
      const rec = manifest.files[rel]
      assert.ok(rec, `manifest lists ${rel}`)
      const buf = src ? await readFile(src) : Buffer.from(text, 'utf8')
      assert.equal(rec.sha256, sha(buf))
      assert.equal(rec.bytes, buf.byteLength)
      const onDisk = await readFile(path.join(out, rel))
      assert.deepEqual(onDisk, buf, `${rel} copied verbatim`)
    }
    assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(expected).sort())
    assert.equal(manifest.trialId, 'trial-001')
    assert.equal(manifest.provenance.droidVersion, '0.197.0')
    assert.ok(!isNaN(Date.parse(manifest.createdAt)))
    assert.ok(!('manifest.json' in manifest.files))
    const onDiskManifest = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8'))
    assert.deepEqual(onDiskManifest, manifest)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('null optional artifacts are omitted from disk and manifest', async () => {
  const base = await tmpBase()
  try {
    const out = path.join(base, 'pack')
    const { instruction, testsDir } = await fixtureInputs(base)
    const manifest = await writeEvidencePack(out, {
      trialId: 'trial-002',
      provenance: { droidVersion: '0.197.0' },
      instructionPath: instruction,
      testsDir,
      results: { outcome: 'NO_SUBMISSION' },
      configSnapshot: null,
      ledgerPath: null,
      transcriptPath: null,
      patchDiff: null,
      usage: null,
      pricing: null,
      errors: null
    })
    const names = Object.keys(manifest.files)
    assert.ok(!names.some(n => n.includes('config.snapshot')))
    assert.ok(!names.some(n => n.includes('events.jsonl')))
    assert.ok(!names.some(n => n.includes('transcript.jsonl')))
    assert.ok(!names.some(n => n.includes('patch.diff')))
    assert.ok(!names.some(n => n.includes('usage.json')))
    assert.ok(!names.some(n => n.includes('pricing.json')))
    assert.ok(!names.some(n => n.includes('errors.json')))
    const disk = await readdir(out)
    assert.ok(!disk.includes('config.snapshot.json'))
    assert.ok(!disk.includes('events.jsonl'))
    assert.ok(!disk.includes('transcript.jsonl'))
    assert.ok(!disk.includes('patch.diff'))
    assert.ok(!disk.includes('usage.json'))
    assert.ok(!disk.includes('pricing.json'))
    assert.ok(!disk.includes('errors.json'))
    assert.deepEqual(names.sort(), ['instruction.md', 'results.json', 'tests/a/b.sh', 'tests/c.test.js'])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('empty patchDiff string writes no patch.diff', async () => {
  const base = await tmpBase()
  try {
    const out = path.join(base, 'pack')
    const { instruction, testsDir } = await fixtureInputs(base)
    const manifest = await writeEvidencePack(out, {
      trialId: 'trial-003',
      provenance: { droidVersion: '0.197.0' },
      instructionPath: instruction,
      testsDir,
      results: { outcome: 'VERIFIED_FAIL' },
      patchDiff: ''
    })
    assert.ok(!('patch.diff' in manifest.files))
    assert.ok(!(await readdir(out)).includes('patch.diff'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('second writeEvidencePack into same dir throws', async () => {
  const base = await tmpBase()
  try {
    const out = path.join(base, 'pack')
    const { instruction, testsDir } = await fixtureInputs(base)
    const common = {
      trialId: 'trial-004',
      provenance: { droidVersion: '0.197.0' },
      instructionPath: instruction,
      testsDir,
      results: { outcome: 'VERIFIED_PASS' }
    }
    await writeEvidencePack(out, common)
    await assert.rejects(
      writeEvidencePack(out, common),
      /not empty/
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('missing instructionPath throws with clear message', async () => {
  const base = await tmpBase()
  try {
    const out = path.join(base, 'pack')
    const { testsDir } = await fixtureInputs(base)
    const missing = path.join(base, 'nope-instruction.md')
    await assert.rejects(
      writeEvidencePack(out, {
        trialId: 'trial-005',
        provenance: { droidVersion: '0.197.0' },
        instructionPath: missing,
        testsDir,
        results: { outcome: 'NO_SUBMISSION' }
      }),
      /does not exist/
    )
    assert.equal((await readdir(base)).includes('pack'), false, 'no partial pack dir left behind')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('missing testsDir throws with clear message', async () => {
  const base = await tmpBase()
  try {
    const out = path.join(base, 'pack')
    const { instruction } = await fixtureInputs(base)
    await assert.rejects(
      writeEvidencePack(out, {
        trialId: 'trial-006',
        provenance: { droidVersion: '0.197.0' },
        instructionPath: instruction,
        testsDir: path.join(base, 'nope-tests'),
        results: { outcome: 'NO_SUBMISSION' }
      }),
      /does not exist/
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('nested tests dir copies and hashes as tests/<relativepath>', async () => {
  const base = await tmpBase()
  try {
    const out = path.join(base, 'pack')
    const { instruction } = await fixtureInputs(base)
    const deep = path.join(base, 'tests-in-deep')
    await mkdir(path.join(deep, 'a', 'b', 'c'), { recursive: true })
    await writeFile(path.join(deep, 'a', 'b', 'c', 'deep.test.sh'), 'echo deep\n')
    const manifest = await writeEvidencePack(out, {
      trialId: 'trial-007',
      provenance: { droidVersion: '0.197.0' },
      instructionPath: instruction,
      testsDir: deep,
      results: { outcome: 'VERIFIED_PASS' }
    })
    assert.ok(manifest.files['tests/a/b/c/deep.test.sh'])
    const onDisk = await readFile(path.join(out, 'tests', 'a', 'b', 'c', 'deep.test.sh'))
    assert.equal(manifest.files['tests/a/b/c/deep.test.sh'].sha256, sha(onDisk))
    assert.equal(manifest.files['tests/a/b/c/deep.test.sh'].bytes, onDisk.byteLength)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('sha256String and sha256File agree on identical bytes', async () => {
  const base = await tmpBase()
  try {
    const f = path.join(base, 'x.bin')
    const buf = Buffer.from([0, 1, 2, 3, 254, 255])
    await writeFile(f, buf)
    assert.equal(sha256String('abc'), sha(Buffer.from('abc')))
    assert.equal(await sha256File(f), sha(buf))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

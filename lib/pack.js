import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'

export function sha256String (s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

export async function sha256File (p) {
  return sha256String(await readFile(p))
}

export async function writeEvidencePack (dir, artifacts, opts = {}) {
  const {
    trialId,
    provenance,
    instructionPath,
    testsDir,
    results,
    configSnapshot,
    ledgerPath,
    transcriptPath,
    patchDiff,
    usage,
    pricing,
    errors
  } = artifacts
  const allowExisting = new Set(Array.isArray(opts.allowExisting) ? opts.allowExisting : [])
  if (typeof trialId !== 'string' || trialId === '') {
    throw new Error('writeEvidencePack: trialId must be a non-empty string')
  }
  if (!provenance || typeof provenance !== 'object') {
    throw new Error('writeEvidencePack: provenance must be an object')
  }
  let entries
  try {
    entries = await readdir(dir)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    entries = []
  }
  const unexpected = entries.filter(e => !allowExisting.has(e))
  if (unexpected.length > 0) {
    throw new Error(`writeEvidencePack: target directory already exists and is not empty: ${dir} (${unexpected.join(', ')})`)
  }
  for (const p of [instructionPath, testsDir]) {
    let s
    try {
      s = await stat(p)
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`writeEvidencePack: required path does not exist: ${p}`)
      }
      throw err
    }
    if (!s.isDirectory() && !s.isFile()) {
      throw new Error(`writeEvidencePack: required path is not a regular file or directory: ${p}`)
    }
  }
  await mkdir(dir, { recursive: true })
  const written = {}
  const record = (rel, buf) => {
    written[rel] = { sha256: sha256String(buf), bytes: buf.byteLength }
  }
  const writeArtifact = async (rel, buf) => {
    await writeFile(path.join(dir, rel), buf)
    record(rel, buf)
  }
  const copyFile = async (src, dest) => {
    const buf = await readFile(src)
    const rel = path.relative(dir, dest)
    await writeArtifact(rel, buf)
  }
  await copyFile(instructionPath, path.join(dir, 'instruction.md'))
  await writeArtifact('results.json', Buffer.from(JSON.stringify(results)))
  const testsOut = path.join(dir, 'tests')
  const queue = [{ src: testsDir, dest: testsOut }]
  while (queue.length > 0) {
    const { src, dest } = queue.shift()
    let list
    try {
      list = await readdir(src, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`writeEvidencePack: required path does not exist: ${testsDir}`)
      }
      throw err
    }
    await mkdir(dest, { recursive: true })
    for (const entry of list) {
      if (!entry.isFile()) continue
      await copyFile(path.join(src, entry.name), path.join(dest, entry.name))
    }
    for (const entry of list) {
      if (!entry.isDirectory()) continue
      queue.push({ src: path.join(src, entry.name), dest: path.join(dest, entry.name) })
    }
  }
  if (configSnapshot !== null && configSnapshot !== undefined) {
    await writeArtifact('config.snapshot.json', Buffer.from(JSON.stringify(configSnapshot)))
  }
  if (ledgerPath !== null && ledgerPath !== undefined) {
    await copyFile(ledgerPath, path.join(dir, 'events.jsonl'))
  }
  if (transcriptPath !== null && transcriptPath !== undefined) {
    await copyFile(transcriptPath, path.join(dir, 'transcript.jsonl'))
  }
  if (typeof patchDiff === 'string' && patchDiff !== '') {
    await writeArtifact('patch.diff', Buffer.from(patchDiff))
  }
  if (usage !== null && usage !== undefined) {
    await writeArtifact('usage.json', Buffer.from(JSON.stringify(usage)))
  }
  if (pricing !== null && pricing !== undefined) {
    await writeArtifact('pricing.json', Buffer.from(JSON.stringify(pricing)))
  }
  if (errors !== null && errors !== undefined) {
    await writeArtifact('errors.json', Buffer.from(JSON.stringify(errors)))
  }
  const manifest = {
    trialId,
    createdAt: new Date().toISOString(),
    provenance,
    files: written
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  return manifest
}

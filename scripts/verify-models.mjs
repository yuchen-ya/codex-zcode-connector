// Live acceptance test: sends four small prompts and spends quota in both providers.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadConfig, PROJECT_ROOT } from '../lib/config.js'
import { PROVIDER_ALIASES } from '../lib/model-options.js'

const execute = promisify(execFile)
const config = loadConfig()
const cli = join(PROJECT_ROOT, 'cli.mjs')
const results = []

async function command(args) {
  const result = await execute(process.execPath, [cli, ...args, '--json'], { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}

for (const provider of ['start-plan', 'bigmodel']) {
  for (const model of ['GLM-5.3', 'GLM-5.3-Flash']) {
    const selected = await command(['select', '--provider', provider, '--model', model, '--effort', 'low'])
    assert.equal(selected.provider, PROVIDER_ALIASES[provider])
    assert.equal(selected.model, model)
    assert.equal(selected.effort, 'low')
    const expected = `CODEX_MODEL_CHECK_${randomUUID()}`
    // No provider/model/effort arguments: verifies preservation across New task
    // and the default of max, rather than the draft's reset model or low effort.
    const result = await command(['ask', `连接验证。禁止调用任何工具、读取或修改文件。只输出这一行，不加任何解释或格式：${expected}`])
    assert.equal(result.reply.trim(), expected)
    assert.equal(result.provider, PROVIDER_ALIASES[provider])
    assert.equal(result.model, model)
    assert.equal(result.effort, 'max')
    let record
    assert.match(result.taskId, /^(session|sess)_[A-Za-z0-9_-]+$/)
    const path = join(config.home, 'cli', 'rollout', `model-io-${result.taskId}.jsonl`)
    for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
      const candidate = JSON.parse(line)
      if (candidate.querySource === 'main_turn' && candidate.response?.text?.trim() === expected) record = candidate
    }
    assert.ok(record, 'Expected reply was not found in the native transcript')
    assert.equal(record.model.providerId, PROVIDER_ALIASES[provider])
    assert.equal(record.model.modelId, model)
    results.push({ provider: result.provider, model, effort: result.effort, sessionId: record.sessionId, passed: true })
    console.log(`PASS ${provider} / ${model}: low -> max, retained through New task, native transcript matches`)
  }
}
const runtime = config.stateDir
mkdirSync(runtime, { recursive: true })
writeFileSync(join(runtime, 'model-validation.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n')

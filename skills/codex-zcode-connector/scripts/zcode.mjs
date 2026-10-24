#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'))
const child = spawn(settings.node, [settings.cli, ...process.argv.slice(2)], {
  env: { ...process.env, ...settings.env }, stdio: 'inherit', windowsHide: true,
})
child.once('error', error => { console.error(`Cannot start connector: ${error.message}. Reinstall after moving Node or the connector.`); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })

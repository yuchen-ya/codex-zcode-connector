import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { codexEntry, updateZCodeConfig, zcodeConfigSection } from './config-file.js'

const OWNER = 'codex-zcode-connector'
const SKILL_FILES = ['SKILL.md', 'scripts/zcode.mjs', 'settings.json']

function locations() {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  if (!isAbsolute(home)) throw new Error('CODEX_HOME must be an absolute path')
  const skill = join(home, 'skills', OWNER)
  for (const path of [skill, join(skill, 'scripts')]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to modify linked skill path: ${path}`)
  }
  return { home, skill, manifest: join(skill, 'install.json'), config: join(home, 'config.toml') }
}

function readManifest(path) {
  if (!existsSync(path)) return null
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.owner !== OWNER || !manifest.files || Object.keys(manifest.files).some(key => !SKILL_FILES.includes(key))) throw new Error('Skill installation is not owned by this connector')
  return manifest
}

function assertUnmodified(skill, manifest) {
  for (const [file, content] of Object.entries(manifest.files)) {
    const path = join(skill, file)
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || readFileSync(path, 'utf8') !== content)) throw new Error(`Preserved modified skill file: ${path}. Move it aside before reinstalling.`)
  }
}

function configOwnership(text, serverPath) {
  if (/^\s*\[mcp_servers\.(?:"zcode"|'zcode')/m.test(text)) return 'other'
  const block = text.match(/^[ \t]*\[mcp_servers\.zcode\][^\n]*\n([\s\S]*?)(?=^[ \t]*\[|$(?![\s\S]))/m)
  if (!block) return 'absent'
  return block[1].includes(`args = [${JSON.stringify(serverPath)}]`) ? 'owned' : 'other'
}

function writeConfig(path, before, after) {
  if (before === after) return
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (current !== before) throw new Error('Codex configuration changed during installation; retry after the other edit finishes')
  const section = zcodeConfigSection(before)
  if (section) {
    const backups = join(dirname(path), 'backups', 'codex-zcode-connector')
    mkdirSync(backups, { recursive: true, mode: 0o700 })
    writeFileSync(join(backups, `zcode-${randomUUID()}.toml`), section, { mode: 0o600 })
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, after, { mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

export function installConnector(config, { mcp = false } = {}) {
  const paths = locations()
  const previous = readManifest(paths.manifest)
  if (existsSync(paths.skill) && !previous) throw new Error(`A skill already exists at ${paths.skill}; refusing to overwrite it`)
  if (previous) assertUnmodified(paths.skill, previous)
  const serverPath = join(PROJECT_ROOT, 'mcp', 'server.mjs')
  const original = existsSync(paths.config) ? readFileSync(paths.config, 'utf8') : ''
  const ownership = configOwnership(original, previous?.serverPath ?? serverPath)
  if (mcp && ownership === 'other') throw new Error('MCP server zcode is owned by another installation; preserved')
  const settings = { node: process.execPath, cli: join(PROJECT_ROOT, 'cli.mjs'), env: {
    ZCODE_WORKSPACE: config.workspace, ZCODE_HOME: config.home, ZCODE_DEBUG_PORT: String(config.debugPort), ZCODE_STATE_DIR: config.stateDir,
  } }
  const files = {
    'SKILL.md': readFileSync(join(PROJECT_ROOT, 'skills', OWNER, 'SKILL.md'), 'utf8'),
    'scripts/zcode.mjs': readFileSync(join(PROJECT_ROOT, 'skills', OWNER, 'scripts', 'zcode.mjs'), 'utf8'),
    'settings.json': JSON.stringify(settings, null, 2) + '\n',
  }
  mkdirSync(join(paths.skill, 'scripts'), { recursive: true })
  mkdirSync(config.workspace, { recursive: true })
  for (const [file, content] of Object.entries(files)) writeFileSync(join(paths.skill, file), content)
  writeFileSync(paths.manifest, JSON.stringify({ owner: OWNER, serverPath, files }, null, 2))
  const entry = mcp ? codexEntry({ nodePath: process.execPath, serverPath, workspace: config.workspace, home: config.home, debugPort: config.debugPort, stateDir: config.stateDir }) : ''
  if (mcp || ownership === 'owned') writeConfig(paths.config, original, updateZCodeConfig(original, entry))
  return `Installed skill: ${paths.skill}\nMCP: ${mcp ? 'enabled (zcode_task only)' : ownership === 'other' ? 'unrelated entry preserved' : 'disabled; CLI skill mode'}\nWorkspace: ${config.workspace}\nReload Codex. Keep this installation directory in place.`
}

export function uninstallConnector() {
  const paths = locations()
  const manifest = readManifest(paths.manifest)
  const original = existsSync(paths.config) ? readFileSync(paths.config, 'utf8') : ''
  const ownership = configOwnership(original, manifest?.serverPath ?? join(PROJECT_ROOT, 'mcp', 'server.mjs'))
  if (ownership === 'owned') writeConfig(paths.config, original, updateZCodeConfig(original, ''))
  const preserved = []
  if (manifest) {
    for (const [file, content] of Object.entries(manifest.files)) {
      const path = join(paths.skill, file)
      if (!existsSync(path)) continue
      if (lstatSync(path).isSymbolicLink() || readFileSync(path, 'utf8') !== content) preserved.push(path)
      else unlinkSync(path)
    }
    if (!preserved.length) unlinkSync(paths.manifest)
    for (const directory of [join(paths.skill, 'scripts'), paths.skill]) {
      if (existsSync(directory) && readdirSync(directory).length === 0) rmdirSync(directory)
    }
  }
  return `Connector integration removed; reload Codex.\nZCode, workspaces, account data and running tasks are preserved.${ownership === 'other' ? '\nUnrelated MCP entry preserved.' : ''}${preserved.length ? '\nModified files preserved:\n' + preserved.join('\n') : ''}`
}

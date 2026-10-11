// v7.4 (X-1222, K3): censo real do processo, carregado com `node --import <este arquivo>` ANTES do launcher ou do core.
// Registra (uma linha JSON por evento em PIXSETTLE_PROCESS_AUDIT): todo processo filho criado pelo child_process (spawn,
// fork, exec, execFile e as versões síncronas), todo servidor que começa a ouvir (net.Server.listen, inclusive o HTTP do
// Fastify) e, na saída, os recursos ativos do Node (process.getActiveResourcesInfo). Nunca grava o ambiente dos filhos
// (onde ficaria a chave): só o executável e os argumentos.
import { syncBuiltinESMExports, createRequire } from 'node:module'
import { appendFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const cp = require('node:child_process')
const net = require('node:net')
const file = process.env.PIXSETTLE_PROCESS_AUDIT
const log = ev => { if (file) appendFileSync(file, JSON.stringify({ pid: process.pid, ...ev }) + '\n') }

for (const name of ['spawn', 'fork', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync']) {
  const orig = cp[name]
  cp[name] = function audited(...args) {
    log({ ev: 'child', fn: name, file: String(args[0]), args: Array.isArray(args[1]) ? args[1].map(String) : [] })
    return orig.apply(this, args)
  }
}
syncBuiltinESMExports() // `import { spawn } from 'node:child_process'` do launcher passa a ver a versão auditada

const listen = net.Server.prototype.listen
net.Server.prototype.listen = function auditedListen(...args) {
  log({ ev: 'listen' })
  return listen.apply(this, args)
}

process.on('exit', code => log({ ev: 'exit', code, resources: process.getActiveResourcesInfo() }))
log({ ev: 'start', script: String(process.argv[1] ?? '') })

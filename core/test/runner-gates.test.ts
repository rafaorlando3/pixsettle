import {it,expect} from 'vitest'
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
const base={chainId:42431,rpc:'https://rpc.moderato.tempo.xyz',runId:'test',operations:{}}
function run(state:any,locked=false){
 const root=mkdtempSync(join(tmpdir(),'pixsettle-gate-')),cwd=join(root,'core'),priv=join(root,'private')
 mkdirSync(cwd);mkdirSync(priv);writeFileSync(join(priv,'state.json'),JSON.stringify(state))
 if(locked)writeFileSync(join(priv,'run.lock'),'owned-by-live-or-unknown-process')
 const r=spawnSync(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('scripts/native-lab.ts')],{cwd,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH!,HOME:'/tmp'}})
 const result={status:r.status,text:r.stdout+r.stderr,keysCreated:existsSync(join(priv,'testnet-only-keys.json')),lock:existsSync(join(priv,'run.lock'))?readFileSync(join(priv,'run.lock'),'utf8'):null}
 rmSync(root,{recursive:true,force:true});return result
}
it('completed journal exits without keys or chain effects',()=>{const r=run({...base,completed:true});expect(r.status).toBe(0);expect(r.text).toContain('no_effects_submitted');expect(r.keysCreated).toBe(false);expect(r.lock).toBeNull()})
it('uncertain journal stops before keys and network',()=>{const r=run({...base,operations:{one:{status:'uncertain'}}});expect(r.status).toBe(1);expect(r.text).toContain('unresolved_operation');expect(r.keysCreated).toBe(false)})
it('started journal also stops before keys and network',()=>{const r=run({...base,operations:{one:{status:'started'}}});expect(r.status).toBe(1);expect(r.text).toContain('unresolved_operation');expect(r.keysCreated).toBe(false)})
it('wrong network stops even if journal says completed',()=>{const r=run({...base,chainId:1,completed:true});expect(r.status).toBe(1);expect(r.text).toContain('state_network_mismatch');expect(r.keysCreated).toBe(false)})
it('existing lock is preserved with explicit reason',()=>{const r=run(base,true);expect(r.status).toBe(1);expect(r.text).toContain('lock_unavailable_check_live_process');expect(r.lock).toBe('owned-by-live-or-unknown-process');expect(r.keysCreated).toBe(false)})

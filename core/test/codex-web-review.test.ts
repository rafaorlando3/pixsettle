// Prova de revisão isolada: expiração da credencial de leitura, contrato 5.2.
import { it, expect, afterEach } from 'vitest'
import { setup } from './helpers.js'
import { buildApp } from '../src/app.js'
import { registerWeb } from '../src/web.js'
import { registerDemo } from '../src/demo.js'

let env: Awaited<ReturnType<typeof setup>>
afterEach(async () => { await env?.drop() })

it('R3: sessao expirada nao continua liberando dados e QR do checkout', async () => {
  env=await setup()
  const app=buildApp(env.ctx,{asaasWebhookToken:'test-only',diagnosticsToken:'test-only'})
  const explorer='https://explore.testnet.tempo.xyz'
  registerWeb(app,env.ctx,{tempoRpc:'https://rpc.moderato.tempo.xyz',explorer,demo:true})
  await registerDemo(app,env.ctx,{webhookToken:'test-only',merchantAddress:'0x8ee643c15C603856A76d05020b5ccB0FceA425BF',explorer})
  const r=await app.inject({method:'POST',url:'/demo/api/orders',payload:{amount_minor:10090}})
  expect(r.statusCode).toBe(201)
  const {checkout_token,order_id}=r.json()
  await env.db.query("UPDATE checkout_sessions SET expires_at=now()-interval '1 minute' WHERE order_id=$1",[order_id])
  const data=await app.inject({method:'GET',url:`/api/v1/checkout/${checkout_token}`})
  const qr=await app.inject({method:'GET',url:`/api/v1/checkout/${checkout_token}/qr.svg`})
  console.log('R3_EXPIRATION_EVIDENCE',JSON.stringify({dataStatus:data.statusCode,payloadReturned:!!data.json().pix_payload,qrStatus:qr.statusCode,svgReturned:qr.body.includes('<svg')}))
  expect.soft(data.statusCode).not.toBe(200)
  expect(qr.statusCode).not.toBe(200)
  await app.close()
})

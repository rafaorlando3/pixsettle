// Páginas públicas (checkout do pagador e recibo), QR do Pix e lista de emissores confiáveis.
// Tudo servido do próprio core, sem CDN: a página do recibo confere a cadeia direto na RPC da Tempo.
import type { FastifyInstance } from 'fastify'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import QRCode from 'qrcode'
import type { Ctx } from './context.js'
import { checkoutSession } from './app.js'

export const PUBLIC_DIR = fileURLToPath(new URL('../../web/public/', import.meta.url))
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }

export type WebOptions = { tempoRpc: string; explorer: string; demo: boolean }

export function registerWeb(app: FastifyInstance, ctx: Ctx, opts: WebOptions) {
  const cache = new Map<string, { body: Buffer; type: string }>()
  const asset = (name: string) => {
    let hit = cache.get(name)
    if (!hit) {
      const path = PUBLIC_DIR + name
      if (!/^[a-z0-9-]+\.(html|css|js|svg)$/.test(name) || !existsSync(path)) return null
      hit = { body: readFileSync(path), type: TYPES[name.slice(name.lastIndexOf('.'))]! }
      if (process.env.NODE_ENV === 'production') cache.set(name, hit)
    }
    return hit
  }
  const page = (name: string) => async (_req: any, reply: any) => {
    const a = asset(name)
    if (!a) return reply.code(404).send({ error: { code: 'not_found', message: name } })
    return reply.type(a.type).header('cache-control', 'no-store').send(a.body)
  }

  app.get('/assets/:name', async (req, reply) => {
    const a = asset((req.params as any).name)
    if (!a) return reply.code(404).send({ error: { code: 'not_found', message: 'asset' } })
    return reply.type(a.type).header('cache-control', 'no-cache').send(a.body)
  })
  app.get('/pay/:token', page('pay.html'))
  app.get('/receipt/:id', page('receipt.html'))
  if (opts.demo) {
    app.get('/', async (_req, reply) => reply.redirect('/demo'))
    app.get('/demo', page('demo.html'))
  }

  // QR do Pix para a tela do pagador (mesmo token da sessão de checkout).
  app.get('/api/v1/checkout/:token/qr.svg', async (req, reply) => {
    const s = await checkoutSession(ctx, (req.params as any).token)
    if (!s) return reply.code(404).send({ error: { code: 'not_found', message: 'QR indisponível', details: {} } })
    if (s.expired) return reply.code(410).send({ error: { code: 'checkout_expired', message: 'link de pagamento expirado', details: {} } })
    const t = (await ctx.db.query(`SELECT qr_payload FROM pix_charges WHERE order_id=$1`, [s.orderId])).rows[0]
    if (!t?.qr_payload) return reply.code(404).send({ error: { code: 'not_found', message: 'QR indisponível', details: {} } })
    const svg = await QRCode.toString(t.qr_payload, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
    return reply.type('image/svg+xml').header('cache-control', 'no-store').send(svg)
  })

  // Emissores confiáveis e dados públicos da cadeia para o verificador do navegador.
  app.get('/.well-known/pixsettle.json', async () => ({
    trusted_issuers: [ctx.cfg.issuer],
    pix_provider: { name: ctx.provider.name, env: ctx.provider.env },
    chain: { id: ctx.chain.chainId, token: ctx.chain.token, treasury: ctx.chain.treasury, rpc: opts.tempoRpc, explorer: opts.explorer },
  }))
}

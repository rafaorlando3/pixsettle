// Asaas v3 FALSO para testes do adaptador: formatos conforme docs.asaas.com (27/09/2026). Nada de rede externa.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

type Payment = { id: string; customer: string; billingType: string; value: number; dueDate: string; description: string; externalReference: string | null; status: string; deleted: boolean; paymentDate: string | null; refunds: any[] }

export class FakeAsaas {
  payments = new Map<string, Payment>()
  calls: Array<{ method: string; path: string; key: string; ua: string }> = []
  receiverKey = '$aact_hmlg_receiver'
  payerKey = '$aact_hmlg_payer'
  /** Falhas: 'create_hang_after_commit' cria e não responde a tempo; 'qr_500' falha o QR; 'refund_pending' deixa o estorno pendente. */
  fail = new Set<string>()
  private seq = 0
  private server!: Server
  url = ''

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      const u = new URL(req.url!, 'http://x'); const path = u.pathname.replace(/^\/v3/, '')
      const key = String(req.headers['access_token'] ?? ''); const ua = String(req.headers['user-agent'] ?? '')
      this.calls.push({ method: req.method!, path, key, ua })
      const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (!key) return send(401, { errors: [{ code: 'access_token_not_found', description: "O cabeçalho de autenticação 'access_token' é obrigatório" }] })
      if (!ua) return send(400, { errors: [{ code: 'user_agent_required', description: 'User-Agent obrigatório' }] })
      let m: RegExpMatchArray | null
      if (req.method === 'POST' && path === '/payments') {
        if (typeof body.value !== 'number' || body.billingType !== 'PIX') return send(400, { errors: [{ code: 'invalid_value', description: 'valor inválido' }], customer: 'dado-que-nao-pode-vazar' })
        const id = `pay_${String(++this.seq).padStart(12, '0')}`
        this.payments.set(id, { id, customer: body.customer, billingType: 'PIX', value: body.value, dueDate: body.dueDate, description: body.description, externalReference: body.externalReference ?? null, status: 'PENDING', deleted: false, paymentDate: null, refunds: [] })
        if (this.fail.has('create_hang_after_commit')) { this.fail.delete('create_hang_after_commit'); await new Promise(r => setTimeout(r, 500)) }
        return send(200, this.payments.get(id))
      }
      if (req.method === 'GET' && path === '/payments') {
        const data = [...this.payments.values()].filter(p => !p.deleted && p.externalReference === u.searchParams.get('externalReference'))
        return send(200, { object: 'list', hasMore: false, totalCount: data.length, limit: 100, offset: 0, data })
      }
      if ((m = path.match(/^\/payments\/([^/]+)$/))) {
        const p = this.payments.get(m[1]!); if (!p) return send(404, { errors: [{ code: 'not_found', description: 'Cobrança não encontrada' }] })
        if (req.method === 'GET') { const { refunds, ...rest } = p; return send(200, { ...rest, refunds: null }) } // sem refunds no GET: obriga a consultar /refunds
        if (req.method === 'DELETE') { if (p.status !== 'PENDING') return send(400, { errors: [{ code: 'invalid_action', description: 'Só cobranças pendentes' }] }); p.deleted = true; return send(200, { deleted: true, id: p.id }) }
      }
      if (req.method === 'GET' && (m = path.match(/^\/payments\/([^/]+)\/pixQrCode$/))) {
        if (this.fail.has('qr_500')) { this.fail.delete('qr_500'); return send(500, { errors: [{ code: 'internal', description: 'erro' }] }) }
        const p = this.payments.get(m[1]!)!
        return send(200, { encodedImage: 'iVBOR', payload: `00020101021226730014br.gov.bcb.pix2551pix-h.asaas.com/pixqrcode/cobv/${p.id}5204000053039865802BR`, expirationDate: '2027-09-27T23:59:59Z', description: p.description })
      }
      if (req.method === 'GET' && (m = path.match(/^\/payments\/([^/]+)\/refunds$/))) {
        const p = this.payments.get(m[1]!)!
        return send(200, { object: 'list', hasMore: false, totalCount: p.refunds.length, limit: 100, offset: 0, data: p.refunds })
      }
      if (req.method === 'POST' && (m = path.match(/^\/payments\/([^/]+)\/refund$/))) {
        const p = this.payments.get(m[1]!)!
        const done = p.refunds.filter(r => r.status !== 'CANCELLED').reduce((a, r) => a + r.value, 0)
        if (!['RECEIVED', 'CONFIRMED'].includes(p.status) || done + body.value > p.value + 1e-9) return send(400, { errors: [{ code: 'invalid_action', description: 'estorno não permitido' }] })
        p.refunds.push({ dateCreated: '2026-09-27 10:00:00', status: this.fail.has('refund_pending') ? 'PENDING' : 'DONE', value: body.value, description: body.description, endToEndIdentifier: null, effectiveDate: null })
        if (Math.abs(done + body.value - p.value) < 1e-9 && !this.fail.has('refund_pending')) p.status = 'REFUNDED'
        return send(200, { ...p })
      }
      if (req.method === 'POST' && (m = path.match(/^\/sandbox\/payment\/([^/]+)\/confirm$/))) {
        const p = this.payments.get(m[1]!)!; p.status = 'RECEIVED'; p.paymentDate = '2026-09-27'; return send(200, p)
      }
      if (req.method === 'POST' && path === '/pix/qrCodes/pay') {
        if (key !== this.payerKey) return send(400, { errors: [{ code: 'invalid_action', description: 'conta pagadora sem saldo' }] })
        const p = [...this.payments.values()].find(x => String(body.qrCode?.payload ?? '').includes(`/cobv/${x.id}`))
        if (!p || Math.abs(p.value - body.value) > 1e-9) return send(400, { errors: [{ code: 'invalid_value', description: 'valor diferente do QR' }] })
        p.status = 'RECEIVED'; p.paymentDate = '2026-09-27'
        return send(200, { id: 'txn_1', status: 'DONE', value: body.value, type: 'DEBIT', originType: 'DYNAMIC_QRCODE' })
      }
      return send(404, { errors: [{ code: 'not_found', description: `${req.method} ${path}` }] })
    })
    await new Promise<void>(r => this.server.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v3`
    return this
  }
  /** Estornos pendentes viram concluídos (o Pix de devolução liquidou). */
  settleRefunds() { for (const p of this.payments.values()) { for (const r of p.refunds) if (r.status === 'PENDING') r.status = 'DONE'; const d = p.refunds.filter(r => r.status === 'DONE').reduce((a, r) => a + r.value, 0); if (Math.abs(d - p.value) < 1e-9) p.status = 'REFUNDED' } }
  async stop() { await new Promise<void>(r => this.server.close(() => r())) }
}

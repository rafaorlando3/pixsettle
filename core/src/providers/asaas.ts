// Adaptador do Asaas (API v3), SÓ SANDBOX nesta versão: recusa chave ou URL de produção.
// Referência: docs.asaas.com (cobranças, QR Pix, estornos, sandbox), conferida em 27/09/2026.
import { ProviderError, type PixProvider, type ProviderPayment, type CreatedCharge, type ProviderStatus } from './types.js'

export const ASAAS_SANDBOX_URL = 'https://api-sandbox.asaas.com/v3'

export type AsaasOptions = {
  apiKey: string
  customerId: string
  baseUrl?: string
  userAgent?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** Centavos (inteiro) para o decimal em reais que a API espera, sem ponto flutuante no caminho. */
export function toReais(minor: bigint): number {
  if (minor < 0n) throw new Error('valor negativo')
  return Number(`${minor / 100n}.${(minor % 100n).toString().padStart(2, '0')}`)
}
/** Decimal em reais vindo da API para centavos. Recusa mais de 2 casas (nunca arredonda dinheiro em silêncio). */
export function toMinor(v: unknown): bigint {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ProviderError('invalid_response', null, null, `valor inválido: ${String(v)}`)
  const s = v.toFixed(2)
  if (Math.abs(Number(s) - v) > 1e-9) throw new ProviderError('invalid_response', null, null, `valor com mais de 2 casas: ${v}`)
  return BigInt(s.replace('.', ''))
}

/** Tira do corpo de erro tudo que não for código e descrição (nada de dados pessoais em log ou banco). */
function sanitizeError(body: any) {
  const errors = Array.isArray(body?.errors) ? body.errors.map((e: any) => ({ code: String(e?.code ?? ''), description: String(e?.description ?? '').slice(0, 300) })) : null
  return errors ? { errors } : null
}

const STATUS: Record<string, ProviderStatus> = {
  PENDING: 'PENDING', CONFIRMED: 'CONFIRMED', RECEIVED: 'RECEIVED', OVERDUE: 'OVERDUE', REFUNDED: 'REFUNDED',
  REFUND_REQUESTED: 'REFUND_IN_PROGRESS', REFUND_IN_PROGRESS: 'REFUND_IN_PROGRESS',
}

export class AsaasPixProvider implements PixProvider {
  readonly name = 'asaas' as const
  readonly env = 'sandbox' as const
  private base: string
  private f: typeof fetch

  constructor(private o: AsaasOptions) {
    this.base = (o.baseUrl ?? ASAAS_SANDBOX_URL).replace(/\/$/, '')
    if (!o.apiKey.startsWith('$aact_hmlg_')) throw new Error('chave do Asaas não é de sandbox ($aact_hmlg_); produção não é aceita nesta versão')
    if (/^https:\/\/api\.asaas\.com/.test(this.base)) throw new Error('URL de produção do Asaas recusada nesta versão')
    if (!o.customerId) throw new Error('ASAAS_CUSTOMER_ID ausente')
    this.f = o.fetchImpl ?? fetch
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.f(this.base + path, {
        method,
        headers: { access_token: this.o.apiKey, 'user-agent': this.o.userAgent ?? 'PixSettle/0.1', 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      })
    } catch (e) {
      // Timeout ou rede: não sabemos se o Asaas executou. Quem chama concilia.
      throw new ProviderError('timeout', null, null, `asaas ${method} ${path}: ${(e as Error).name} ${(e as Error).message}`)
    }
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch {
      throw new ProviderError('invalid_response', res.status, null, `asaas ${method} ${path} -> ${res.status}: resposta não é JSON`)
    }
    if (!res.ok) {
      const clean = sanitizeError(json)
      const desc = clean?.errors?.map((e: any) => `${e.code}: ${e.description}`).join('; ') ?? ''
      throw new ProviderError('http', res.status, clean, `asaas ${method} ${path} -> ${res.status} ${desc}`.trim())
    }
    return json as T
  }

  async createCharge(input: { orderId: string; amountMinor: bigint; description: string; dueDate: string }): Promise<CreatedCharge> {
    const p = await this.call<any>('POST', '/payments', {
      customer: this.o.customerId, billingType: 'PIX', value: toReais(input.amountMinor), dueDate: input.dueDate,
      description: input.description.slice(0, 500), externalReference: input.orderId,
    })
    if (typeof p?.id !== 'string') throw new ProviderError('invalid_response', null, null, 'cobrança criada sem id')
    try {
      const qr = await this.getPixQr(p.id)
      return { paymentId: p.id, ...qr }
    } catch (e) {
      // A cobrança EXISTE; perder o QR vira resultado desconhecido e a conciliação busca de novo pelo externalReference.
      throw new ProviderError('timeout', null, null, `cobrança ${p.id} criada, QR indisponível: ${(e as Error).message}`)
    }
  }

  async getPixQr(paymentId: string): Promise<{ qrPayload: string; qrExpiresAt: Date }> {
    const q = await this.call<any>('GET', `/payments/${encodeURIComponent(paymentId)}/pixQrCode`)
    if (typeof q?.payload !== 'string' || !q.payload) throw new ProviderError('invalid_response', null, null, 'QR sem payload')
    const exp = new Date(q.expirationDate)
    if (Number.isNaN(exp.getTime())) throw new ProviderError('invalid_response', null, null, `expirationDate inválida: ${q.expirationDate}`)
    return { qrPayload: q.payload, qrExpiresAt: exp }
  }

  private async refundedMinor(p: any): Promise<bigint> {
    let refunds: any[] | null = Array.isArray(p.refunds) ? p.refunds : null
    if (!refunds && ['RECEIVED', 'CONFIRMED', 'REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS'].includes(p.status)) {
      refunds = (await this.call<any>('GET', `/payments/${encodeURIComponent(p.id)}/refunds?limit=100`))?.data ?? []
    }
    // Só estorno concluído conta como devolvido (DONE); pendente não confirma nada.
    return (refunds ?? []).filter(r => r?.status === 'DONE').reduce((a, r) => a + toMinor(r.value), 0n)
  }

  private async view(p: any): Promise<ProviderPayment> {
    if (typeof p?.id !== 'string' || typeof p?.status !== 'string') throw new ProviderError('invalid_response', null, null, 'cobrança sem id ou status')
    const valueMinor = toMinor(p.value)
    const refundedMinor = await this.refundedMinor(p)
    let status: ProviderStatus = p.deleted === true ? 'DELETED' : STATUS[p.status] ?? 'OTHER'
    // O Asaas não tem estado de estorno parcial: deduzimos pelos estornos concluídos.
    if (refundedMinor > 0n && ['RECEIVED', 'CONFIRMED', 'REFUND_IN_PROGRESS'].includes(status)) status = refundedMinor >= valueMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED'
    return {
      id: p.id, status, rawStatus: String(p.status), billingType: String(p.billingType ?? ''), valueMinor,
      externalReference: p.externalReference ?? null,
      paidAt: null, // o Asaas informa só a data; a regra de prazo trata isso sem inventar hora (contrato 3.4)
      paidDate: p.paymentDate ?? p.clientPaymentDate ?? null,
      refundedMinor,
    }
  }

  async getPayment(paymentId: string): Promise<ProviderPayment> {
    return this.view(await this.call<any>('GET', `/payments/${encodeURIComponent(paymentId)}`))
  }

  async findByExternalReference(orderId: string): Promise<ProviderPayment[]> {
    const r = await this.call<any>('GET', `/payments?externalReference=${encodeURIComponent(orderId)}&limit=100`)
    if (r?.hasMore) throw new ProviderError('invalid_response', null, null, `mais de 100 cobranças com externalReference ${orderId}`)
    return Promise.all((r?.data ?? []).map((p: any) => this.view(p)))
  }

  async deleteCharge(paymentId: string): Promise<void> {
    await this.call('DELETE', `/payments/${encodeURIComponent(paymentId)}`)
  }

  async refund(paymentId: string, amountMinor: bigint, description: string): Promise<{ refundRef: string }> {
    const p = await this.call<any>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { value: toReais(amountMinor), description: description.slice(0, 500) })
    const n = Array.isArray(p?.refunds) ? p.refunds.length : 0
    return { refundRef: `${paymentId}#refund${n}` }
  }
}

/**
 * Pagador de SANDBOX: paga o QR dinâmico com uma segunda conta sandbox (POST /pix/qrCodes/pay).
 * Sem essa conta, usa a confirmação de sandbox do próprio recebedor (POST /sandbox/payment/{id}/confirm).
 */
export class AsaasSandboxPayer {
  constructor(private receiver: AsaasOptions, private payerApiKey?: string, private f: typeof fetch = receiver.fetchImpl ?? fetch) {
    if (payerApiKey && !payerApiKey.startsWith('$aact_hmlg_')) throw new Error('chave do pagador não é de sandbox')
  }
  private async post(key: string, path: string, body: unknown) {
    const base = (this.receiver.baseUrl ?? ASAAS_SANDBOX_URL).replace(/\/$/, '')
    const res = await this.f(base + path, {
      method: 'POST', body: JSON.stringify(body),
      headers: { access_token: key, 'user-agent': this.receiver.userAgent ?? 'PixSettle/0.1', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(this.receiver.timeoutMs ?? 10_000),
    })
    const text = await res.text()
    if (!res.ok) throw new ProviderError('http', res.status, sanitizeError((() => { try { return JSON.parse(text) } catch { return null } })()), `asaas sandbox POST ${path} -> ${res.status}`)
    return text ? JSON.parse(text) : null
  }
  async pay(paymentId: string, qrPayload: string, amountMinor: bigint): Promise<{ via: 'payer_account' | 'sandbox_confirm' }> {
    if (this.payerApiKey) {
      await this.post(this.payerApiKey, '/pix/qrCodes/pay', { qrCode: { payload: qrPayload }, value: toReais(amountMinor), description: 'PixSettle demo (sandbox)' })
      return { via: 'payer_account' }
    }
    await this.post(this.receiver.apiKey, `/sandbox/payment/${encodeURIComponent(paymentId)}/confirm`, {})
    return { via: 'sandbox_confirm' }
  }
}

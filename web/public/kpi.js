// Rótulos dos números do pedido na demo, pelo estado real (revisão do Codex, X-0022):
// nada de "recebido" antes do Pix, nem promessa de envio em pedido vencido ou retido.
export function kpiLabels(o) {
  const hasTx = !!o.settlement?.tx_hash
  if (o.hold_reason) return { brl: o.status === 'awaiting_payment' ? 'Amount charged (BRL)' : 'Pix received (BRL)', net: 'On hold, nothing sent', sent: false, res: 'No reserve (on hold)', reserve: false }
  switch (o.status) {
    case 'created':
    case 'awaiting_payment': return { brl: 'Amount charged (BRL)', net: 'Merchant would get, if paid (pathUSD)', sent: true, res: 'Reserve if paid (projected)', reserve: true }
    case 'expired': return { brl: 'Charged, never paid (BRL)', net: 'Expired, nothing sent', sent: false, res: 'No reserve (expired)', reserve: false }
    case 'late_paid': return { brl: 'Pix received late (BRL)', net: 'Not sent: late payment goes to refund', sent: false, res: 'No reserve (not settled)', reserve: false }
    case 'paid':
    case 'settling': return { brl: 'Pix received (BRL)', net: 'Merchant will get (pathUSD)', sent: true, res: 'Reserve from this order (simulated)', reserve: true }
    case 'settled': return { brl: 'Pix received (BRL)', net: 'Merchant got (pathUSD)', sent: true, res: 'Reserve from this order (simulated)', reserve: true }
    case 'refunded': return hasTx
      ? { brl: 'Pix received, later refunded (BRL)', net: 'Merchant got (pathUSD)', sent: true, res: 'Reserve from this order (simulated)', reserve: true }
      : { brl: 'Pix received, refunded (BRL)', net: 'Refunded, nothing sent', sent: false, res: 'No reserve (not settled)', reserve: false }
    default: return { brl: 'Amount (BRL)', net: 'Merchant amount (pathUSD)', sent: false, res: 'Reserve (simulated)', reserve: false }
  }
}

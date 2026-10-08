#!/usr/bin/env bash
# Smoke pós-deploy do piloto/copiloto. Uso: bash scripts/smoke-pilot.sh https://host [max_ms_frio=5000]
# Sai com 1 em qualquer falha (para o rollback automático do deploy). Não usa chave nem token.
set -u
BASE=${1:?url}; MAXMS=${2:-5000}; fail=0; ok=0
chk(){ if [ "$1" = ok ]; then ok=$((ok+1)); echo "ok   $2"; else fail=$((fail+1)); echo "FALHA $2"; fi; }
t0=$(date +%s%3N); code=$(curl -s -o /tmp/smoke-demo.html -w '%{http_code}' --max-time 30 "$BASE/demo"); t1=$(date +%s%3N); ms=$((t1-t0))
[ "$code" = 200 ] && chk ok "/demo 200 em ${ms} ms" || chk x "/demo HTTP $code em ${ms} ms"
[ $ms -le $MAXMS ] && chk ok "/demo a frio <= ${MAXMS} ms" || chk x "/demo a frio ${ms} ms > ${MAXMS} ms"
code=$(curl -s -o /tmp/smoke-pilot.html -w '%{http_code}' --max-time 30 "$BASE/pilot"); [ "$code" = 200 ] && chk ok "/pilot 200" || chk x "/pilot HTTP $code"
S=$(curl -s --max-time 30 "$BASE/pilot/api/summary"); echo "$S" > /tmp/smoke-summary.json
python3 - "$S" <<'PY' && chk ok "resumo do piloto coerente" || chk x "resumo do piloto incoerente (ver /tmp/smoke-summary.json)"
import json,sys
s=json.loads(sys.argv[1]); e=s['events']; c=s['exceptions']; o=s['orders']; m=s.get('copilot_model',{})
assert e['total']>0, 'sem eventos'
assert e['errors']==0, f"erros de processamento: {e['errors']}"
assert e['pending']==0, f"eventos pendentes: {e['pending']}"
assert c['exceptions']>0, 'sem exceções'
assert c['model_pending']==0 and c['model_jobs_pending']==0, 'jobs do modelo pendentes'
assert o['orders']>0 and o['paid']>0, 'sem pedidos pagos'
print(f"  eventos={e['total']} processados={e['processed']} pedidos={o['orders']} pagos={o['paid']} R$={int(o['paid_minor'])/100:.2f} excecoes={c['exceptions']} auto={c['auto_applied']} humano={c['awaiting_human']} modelo={c['by_model']} model_error={c['model_error']} model_off={c['model_off']} copiloto={m.get('mode')}/{m.get('name')} motivo={m.get('reason')}")
PY
code=$(curl -s -o /tmp/smoke-exc.json -w '%{http_code}' --max-time 30 "$BASE/pilot/api/exceptions?limit=5"); [ "$code" = 200 ] && chk ok "/pilot/api/exceptions 200" || chk x "/pilot/api/exceptions HTTP $code"
grep -q -i -E 'cpf|@gmail|@hotmail|telefone|phone' /tmp/smoke-exc.json && chk x "possível dado pessoal na lista de exceções" || chk ok "lista de exceções sem padrão de dado pessoal"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST -H 'content-type: application/x-pixsettle-batch+json' -H 'x-pilot-signature: sha256=00' --data '{"source":"odin","batch_id":"smoke","events":[]}' "$BASE/pilot/v1/events"); [ "$code" = 401 ] && chk ok "ingestão sem assinatura válida = 401" || chk x "ingestão sem assinatura devolveu $code (esperado 401)"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$BASE/pilot/v1/process"); [ "$code" = 401 ] && chk ok "reprocessar sem token = 401" || chk x "reprocessar sem token devolveu $code (esperado 401)"
echo "smoke: $ok ok, $fail falhas"; [ $fail -eq 0 ]

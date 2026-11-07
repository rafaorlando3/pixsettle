"""Synthetic reconciliation lab. No provider, bank, key, wallet, or chain I/O."""
import copy
import datetime as dt
import hashlib
import json
import re

VERSION = "challenge-event/v1"
FIXTURE = {"tenant": "synthetic-only", "order": "PS-DEMO-001", "currency": "BRL", "scale": 2,
           "amount_minor": 10000, "created_at": "2030-01-01T12:00:00Z", "expires_at": "2030-01-01T12:10:00Z"}
class Invalid(ValueError):
    def __init__(self, code, field, message):
        self.code, self.field, self.message = code, field, message
        super().__init__(message)

def reject(code, field, message):
    raise Invalid(code, field, message)

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)

def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()

def validate(request):
    if type(request) is not dict or set(request) != {"events"}:
        reject("request_shape", "request", "Envie somente o objeto events; campos extras não são aceitos.")
    events = request["events"]
    if type(events) is not list or not 1 <= len(events) <= 6:
        reject("events_count", "events", "Use de 1 a 6 eventos sintéticos.")
    fields = {"event_id", "kind", "amount_minor", "currency", "reference", "occurred_at", "payment_id"}
    for i, e in enumerate(events):
        field = "events[" + str(i) + "]"
        if type(e) is not dict or set(e) != fields:
            reject("event_shape", field, "O evento precisa dos sete campos documentados, sem campos extras.")
        for k in ["event_id", "kind", "currency", "reference", "occurred_at", "payment_id"]:
            if type(e[k]) is not str:
                reject("field_type", field + "." + k, "Este campo precisa ser texto sintético.")
        if not re.fullmatch(r"DEMO-EVT-[0-9]{1,4}", e["event_id"]):
            reject("event_id_format", field + ".event_id", "Use DEMO-EVT- seguido de 1 a 4 dígitos.")
        if e["kind"] not in ["payment", "refund"]:
            reject("event_kind", field + ".kind", "Tipo permitido: payment ou refund.")
        if e["currency"] != "BRL":
            reject("currency", field + ".currency", "O laboratório aceita somente BRL com escala 2 (centavos).")
        if type(e["amount_minor"]) is not int or not 1 <= e["amount_minor"] <= 100000000:
            reject("amount_range", field + ".amount_minor", "Use um inteiro entre 1 e 100000000 centavos; sem decimais, negativos ou booleanos.")
        if e["reference"] != "" and not re.fullmatch(r"PS-DEMO-[0-9]{3}", e["reference"]):
            reject("reference_format", field + ".reference", "Use PS-DEMO- seguido de 3 dígitos ou vazio para simular vínculo ausente. Não insira dados pessoais.")
        if e["payment_id"] != "" and not re.fullmatch(r"DEMO-EVT-[0-9]{1,4}", e["payment_id"]):
            reject("payment_id_format", field + ".payment_id", "Vínculo permitido: DEMO-EVT- seguido de 1 a 4 dígitos ou vazio.")
        if e["kind"] == "payment" and e["payment_id"]:
            reject("payment_link", field + ".payment_id", "Um pagamento inicial não pode apontar para outro pagamento.")
        try:
            if not re.fullmatch(r"2030-01-01T12:[0-5][0-9]:[0-5][0-9]Z", e["occurred_at"]):
                raise ValueError()
            dt.datetime.strptime(e["occurred_at"], "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            reject("time_range", field + ".occurred_at", "Use UTC em 01/01/2030 entre 12:00:00Z e 12:59:59Z. Data inválida ou fora da janela.")
    return copy.deepcopy(request)

def evaluate(request, source_sha):
    req = validate(request)
    seen, decisions, paid, refunded = {}, [], None, False
    baseline_releases = 0
    for e in req["events"]:
        body_hash = digest(e)
        reasons, decision = [], "held"
        before = {"matched_payment": paid, "refunded": refunded}
        if e["kind"] == "payment":
            baseline_releases += 1
        if e["event_id"] in seen:
            if seen[e["event_id"]] == body_hash:
                reasons = [{"code": "duplicate", "message": "Evento idêntico já recebido: nenhum novo efeito simulado."}]
            else:
                decision = "exception"
                reasons = [{"code": "identity_conflict", "message": "A mesma identidade chegou com outro conteúdo; conflito exige conferência."}]
        else:
            seen[e["event_id"]] = body_hash
            if e["reference"] != FIXTURE["order"]:
                reasons.append({"code": "missing_link", "message": "Referência sem pedido vinculado; valor igual não substitui o vínculo."})
            if e["amount_minor"] != FIXTURE["amount_minor"]:
                reasons.append({"code": "amount_mismatch", "message": "Valor diferente do pedido de 10000 centavos (R$ 100,00)."})
            if e["kind"] == "payment":
                if e["occurred_at"] >= FIXTURE["expires_at"]:
                    reasons.append({"code": "expired", "message": "Recebimento na expiração ou depois dela: prazo termina antes de 12:10:00Z."})
                if paid:
                    reasons.append({"code": "already_paid", "message": "Pedido já casado com outro evento; não liberar duas vezes."})
                if not reasons:
                    decision, paid = "matched", e["event_id"]
                    reasons = [{"code": "exact_match", "message": "Referência, moeda, valor e prazo conferem; uma única liberação sintética."}]
                elif any(r["code"] == "missing_link" for r in reasons):
                    decision = "exception"
            else:
                decision = "exception"
                if not paid or e["payment_id"] != paid:
                    reasons.append({"code": "refund_link", "message": "Devolução sem vínculo exato com um pagamento casado."})
                elif refunded:
                    reasons.append({"code": "already_refunded", "message": "Devolução já registrada para este pagamento; sem segundo efeito."})
                elif e["occurred_at"] < next(x["occurred_at"] for x in req["events"] if x["event_id"] == paid):
                    reasons.append({"code": "refund_before_payment", "message": "A devolução não pode ocorrer antes do pagamento vinculado."})
                elif not reasons:
                    refunded = True
                    reasons = [{"code": "refund_after_paid", "message": "Devolução após pagamento: registrar exceção e obrigação simulada de conferência. Não desfaz transferência externa."}]
        decisions.append({"event_id": e["event_id"], "decision": decision, "reasons": reasons,
                          "before": before, "after": {"matched_payment": paid, "refunded": refunded}})
    final = decisions[-1]
    receipt = {"schema": "challenge-receipt/v1", "policy": VERSION, "source_sha": source_sha,
               "synthetic": True, "financial_effect": False, "fixture": copy.deepcopy(FIXTURE),
               "processing_order": "arrival_order", "request": req, "decisions": decisions, "summary": {"decision": final["decision"],
               "last_event_decision": final["decision"],
               "order_status": "refund_exception" if refunded else "matched" if paid else "unpaid_exception" if any(d["decision"] == "exception" for d in decisions) else "unpaid_held",
               "reasons": final["reasons"], "matched_payment": paid, "refund_recorded": refunded,
               "simulated_release_count": int(paid is not None), "naive_notification_release_count": baseline_releases}}
    return {"receipt": receipt, "sha256": digest(receipt)}

def verify(envelope, source_sha):
    if type(envelope) is not dict or set(envelope) != {"receipt", "sha256"}:
        reject("receipt_shape", "receipt", "Envie receipt e sha256 do recibo exportado.")
    r = envelope["receipt"]
    if type(r) is not dict or type(envelope["sha256"]) is not str or not re.fullmatch(r"[a-f0-9]{64}", envelope["sha256"]):
        reject("receipt_shape", "receipt", "Recibo ou hash inválido.")
    if r.get("source_sha") != source_sha:
        return {"verified": False, "code": "version_mismatch", "message": "Recibo de outra versão; use o verificador do commit indicado."}
    try: expected = evaluate(r.get("request"), source_sha)
    except Invalid:
        return {"verified": False, "code": "tampered_or_inconsistent", "message": "Evento inválido no recibo; conteúdo recusado."}
    ok = canonical(envelope) == canonical(expected)
    return {"verified": ok, "code": "reproduced" if ok else "tampered_or_inconsistent",
            "message": "Hash e todas as decisões reproduzidos com esta política. Recibo sintético; não prova pagamento ou assinatura bancária." if ok else "Conteúdo, hash ou decisão divergente: recibo recusado."}

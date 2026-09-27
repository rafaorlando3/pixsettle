#!/usr/bin/env python3
"""Verificador INDEPENDENTE dos vetores do recibo (outra linguagem, outras bibliotecas).

Não importa nada do código TypeScript. JCS (RFC 8785) reimplementado aqui para o subconjunto
usado nos recibos (objetos, listas, strings, inteiros, booleanos, null); keccak da pycryptodome;
recuperação secp256k1 da eth-keys. Uso: python3 verify_receipt_vectors.py [caminho do json]
"""
import hashlib, json, sys
from Crypto.Hash import keccak
from eth_keys import keys

def jcs_string(s: str) -> str:
    out = ['"']
    for ch in s:
        o = ord(ch)
        if ch == '"': out.append('\\"')
        elif ch == '\\': out.append('\\\\')
        elif ch == '\b': out.append('\\b')
        elif ch == '\f': out.append('\\f')
        elif ch == '\n': out.append('\\n')
        elif ch == '\r': out.append('\\r')
        elif ch == '\t': out.append('\\t')
        elif o < 0x20: out.append('\\u%04x' % o)
        else: out.append(ch)  # sem escapar / nem não-ASCII (inclui U+2028), como o ES6
    out.append('"')
    return ''.join(out)

def utf16_key(k: str):
    return k.encode('utf-16-be')  # ordem por unidades de código UTF-16

def jcs(v) -> str:
    if v is None: return 'null'
    if v is True: return 'true'
    if v is False: return 'false'
    if isinstance(v, int):
        if abs(v) > 2**53 - 1: raise ValueError('inteiro fora do intervalo seguro')
        return str(v)
    if isinstance(v, float): raise ValueError('float não permitido')
    if isinstance(v, str): return jcs_string(v)
    if isinstance(v, list): return '[' + ','.join(jcs(x) for x in v) + ']'
    if isinstance(v, dict):
        return '{' + ','.join(jcs_string(k) + ':' + jcs(v[k]) for k in sorted(v.keys(), key=utf16_key)) + '}'
    raise ValueError(f'tipo não suportado: {type(v)}')

def message(p, digest):
    return f"PixSettle receipt v1\nprovider_env={p['provider_env']}\nchain_env={p['chain_env']}\nchain_id={p['chain_id']}\ndigest={digest}"

def eip191_hash(msg: str) -> bytes:
    b = msg.encode('utf-8')
    k = keccak.new(digest_bits=256); k.update(b'\x19Ethereum Signed Message:\n' + str(len(b)).encode() + b)
    return k.digest()

def recover(msg: str, sig_hex: str) -> str:
    sig = bytes.fromhex(sig_hex[2:])
    r, s, v = sig[:32], sig[32:64], sig[64]
    v = v - 27 if v >= 27 else v
    return keys.Signature(r + s + bytes([v])).recover_public_key_from_msg_hash(eip191_hash(msg)).to_checksum_address()

def verify(env, trusted):
    p = env['payload']
    d = hashlib.sha256(jcs(p).encode('utf-8')).hexdigest()
    if d != env['digest']['hex']: return 'digest_mismatch'
    rec = recover(message(p, d), env['signature']['value'])
    if rec.lower() != env['signature']['signer'].lower(): return 'bad_signature'
    if rec.lower() != p['issuer']['address'].lower(): return 'issuer_mismatch'
    if rec.lower() not in [t.lower() for t in trusted]: return 'untrusted_issuer'
    return 'ok'

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else 'contract/vectors/receipt-v1.json'
    V = json.load(open(path, encoding='utf-8'))
    fails = 0
    for c in V['valid']:
        p = c['envelope']['payload']
        checks = {
            'jcs': jcs(p) == c['jcs'],
            'digest': hashlib.sha256(c['jcs'].encode('utf-8')).hexdigest() == c['digest_hex'],
            'message': message(p, c['digest_hex']) == c['message'],
            'verify': verify(c['envelope'], V['trusted_issuers']) == 'ok',
        }
        ok = all(checks.values()); fails += not ok
        print(('OK  ' if ok else 'FAIL'), 'válido', c['name'], '' if ok else checks)
    for c in V['invalid']:
        got = verify(c['envelope'], V['trusted_issuers'])
        ok = got == c['expect']; fails += not ok
        print(('OK  ' if ok else 'FAIL'), 'inválido', c['name'], f'esperado={c["expect"]} obtido={got}')
    # chave duplicada: o json do Python fica com a última em silêncio; detectar explicitamente
    dup = []
    json.loads(V['duplicate_key_json']['text'], object_pairs_hook=lambda pairs: dup.extend(k for k in [x for x, _ in pairs] if [x for x, _ in pairs].count(k) > 1) or dict(pairs))
    ok = bool(dup); fails += not ok
    print(('OK  ' if ok else 'FAIL'), 'chave duplicada detectada', sorted(set(dup)))
    print('resultado:', 'TODOS OK' if fails == 0 else f'{fails} FALHA(S)')
    sys.exit(1 if fails else 0)

if __name__ == '__main__':
    main()

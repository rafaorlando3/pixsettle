"""Bounded stateless demo API; loopback-only. No outbound I/O or access log."""
import re
import ipaddress
import collections
import hashlib
import hmac
import json
import os
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from pathlib import Path
from engine import evaluate, verify, Invalid, FIXTURE, VERSION
ROOT = Path(__file__).resolve().parent
SHA = os.environ.get("CHALLENGE_SHA", "development")
TRUST_LOCAL_PROXY = os.environ.get("TRUST_LOCAL_PROXY") == "1"
LIMIT = 16384
SALT = secrets.token_bytes(32)
LOCK = threading.Lock()
VISITORS = collections.OrderedDict()
GLOBAL = collections.deque()
RECEIPTS = collections.OrderedDict()
MAX_CONNECTIONS = threading.BoundedSemaphore(24)
REQUEST_DEADLINE_SECONDS = 8
INTERNAL_ERRORS = 0

def rate(ip):
    now = time.monotonic()
    key = hmac.new(SALT, ip.encode(), hashlib.sha256).digest()
    with LOCK:
        while GLOBAL and GLOBAL[0] <= now - 60: GLOBAL.popleft()
        stale = [k for k, v in VISITORS.items() if v[-1] <= now - 60]
        for k in stale: del VISITORS[k]
        q = VISITORS.get(key, collections.deque())
        while q and q[0] <= now - 60: q.popleft()
        if len(GLOBAL) >= 180 or len(q) >= 30: return False
        if key not in VISITORS and len(VISITORS) >= 512: VISITORS.popitem(last=False)
        q.append(now); VISITORS[key] = q; VISITORS.move_to_end(key); GLOBAL.append(now)
        return True

def parse_json(b):
    def pairs(items):
        d = {}
        for k,v in items:
            if k in d: raise ValueError("duplicate_key")
            d[k] = v
        return d
    return json.loads(b.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite")))

class Handler(BaseHTTPRequestHandler):
    server_version = "PixSettleLab"
    sys_version = ""
    def setup(self):
        self.request.settimeout(5)
        super().setup()
        self._expired = False
        self._timer = threading.Timer(REQUEST_DEADLINE_SECONDS, self.expire)
        self._timer.daemon = True
        self._timer.start()
    def expire(self):
        self._expired = True
        body=b'{"ok":false,"error":{"code":"request_deadline","message":"Prazo total da requisicao esgotado; nenhum novo evento sera processado."}}'
        try:
            self.request.sendall(b"HTTP/1.1 408 Request Timeout\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "+str(len(body)).encode()+b"\r\n\r\n"+body)
        except OSError: pass
        try: self.request.shutdown(socket.SHUT_RDWR)
        except OSError: pass
    def finish(self):
        self._timer.cancel()
        try: super().finish()
        except (BrokenPipeError,ConnectionResetError): pass
    def log_message(self, *a): pass
    def respond(self, status, body, mime="application/json; charset=utf-8", extra=None):
        if self._expired: return
        if isinstance(body, dict): body = json.dumps(body, ensure_ascii=True, allow_nan=False).encode()
        elif isinstance(body, str): body = body.encode()
        self.send_response(status)
        headers = {"Content-Type": mime, "Content-Length": str(len(body)), "Connection": "close",
          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
          "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()"}
        headers.update(extra or {})
        for k,v in headers.items(): self.send_header(k, v)
        self.end_headers()
        try:
            if self.command != "HEAD": self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError): pass
        self.close_connection = True
    def error(self, status, code, message, field=None):
        self.respond(status, {"ok": False, "error": {"code": code, "message": message, "field": field}}, extra={"Retry-After": "60"} if status==429 else None)
    def send_error(self, code, message=None, explain=None):
        self.error(code,"http_request_refused","Requisição HTTP recusada. Confira método, tamanho e formato.")
    def allowed(self):
        source = self.client_address[0]
        if TRUST_LOCAL_PROXY:
            values = self.headers.get_all("X-Real-IP", [])
            try:
                if not ipaddress.ip_address(source).is_loopback or len(values) != 1: raise ValueError()
                source = str(ipaddress.ip_address(values[0]))
            except ValueError:
                self.error(400,"proxy_identity","Origem do proxy ausente ou inválida. Nenhum evento processado.")
                return False
        if not rate(source):
            self.error(429,"rate_limit","Limite de 30 requisições por minuto por origem ou 180 no total. Aguarde 60 segundos.")
            return False
        return True
    def do_HEAD(self): self.do_GET()
    def do_GET(self):
        from urllib.parse import urlsplit
        try: self.path = urlsplit(self.path).path
        except ValueError: return self.error(400,"request_target","Caminho HTTP inválido.")
        if not self.allowed(): return
        if self.path == "/api/version":
            return self.respond(200,{"schema": VERSION, "source_sha": SHA, "synthetic": True, "financial_effect": False,
              "fixture": FIXTURE, "state": "stateless_replay", "max_events": 6, "max_body_bytes": LIMIT,
              "rate_limits": {"per_source_minute": 30, "global_minute": 180}, "trusted_local_proxy": TRUST_LOCAL_PROXY, "receipt_ttl_seconds": 900, "request_deadline_seconds": REQUEST_DEADLINE_SECONDS, "internal_error_count": INTERNAL_ERRORS,
              "privacy": "Only synthetic references accepted; no cookies, analytics or application access logs. Network host may process transport metadata."})
        if self.path.startswith("/api/receipts/"):
            key = self.path[len("/api/receipts/"):]
            import re
            if not re.fullmatch("[a-f0-9]{64}",key): return self.error(404,"not_found","Recibo não encontrado.")
            with LOCK:
                found = RECEIPTS.get(key)
            if found and time.monotonic()-found[0] < 900: return self.respond(200,found[1])
            return self.error(404,"receipt_expired","Recibo ausente ou expirado após 15 minutos/reinício. Verifique o arquivo exportado.")
        paths={"/":("static/index.html","text/html; charset=utf-8"), "/index.html":("static/index.html","text/html; charset=utf-8"), "/app.js":("static/app.js","text/javascript; charset=utf-8"),
          "/style.css":("static/style.css","text/css; charset=utf-8"), "/source/engine.py":("engine.py","text/plain; charset=utf-8")}
        entry=paths.get(self.path)
        if not entry: return self.error(404,"not_found","Caminho não disponível no laboratório.")
        self.respond(200,(ROOT/entry[0]).read_bytes(),entry[1])
    def do_POST(self):
        if not self.allowed(): return
        if self.path not in ["/api/evaluate","/api/verify"]: return self.error(404,"not_found","Endpoint não disponível.")
        if self.headers.get("Transfer-Encoding"): return self.error(400,"transfer_encoding","Use Content-Length, sem Transfer-Encoding.")
        lengths=self.headers.get_all("Content-Length",[])
        if len(lengths)!=1 or re.fullmatch(r"[0-9]{1,6}", lengths[0]) is None: return self.error(400,"content_length","Content-Length único e válido é obrigatório.")
        size=int(lengths[0])
        if size>LIMIT: return self.error(413,"body_too_large","Corpo acima de 16384 bytes; reduza os eventos.")
        if size<2: return self.error(400,"empty_body","Envie um objeto JSON completo.")
        if self.headers.get("Content-Type","").split(";")[0].strip().lower()!="application/json":
            return self.error(415,"content_type","Envie application/json.")
        origin=self.headers.get("Origin")
        if origin:
            from urllib.parse import urlsplit
            try: same=urlsplit(origin).netloc.lower()==self.headers.get("Host", "").lower() and urlsplit(origin).scheme in ["http","https"]
            except ValueError: same=False
            if not same: return self.error(403,"origin","Use o formulário no próprio laboratório.")
        try:
            raw=self.rfile.read(size)
            if len(raw)!=size: return self.error(400,"incomplete_body","JSON incompleto; nenhum evento processado.")
            data=parse_json(raw)
            if self.path=="/api/verify": return self.respond(200,verify(data,SHA))
            out=evaluate(data,SHA)
            with LOCK:
                now=time.monotonic()
                for k in [k for k,v in RECEIPTS.items() if now-v[0]>=900]: del RECEIPTS[k]
                RECEIPTS[out["sha256"]]=(now,out)
                while len(RECEIPTS)>256: RECEIPTS.popitem(last=False)
            self.respond(200,out)
        except Invalid as e: self.error(422,e.code,e.message,e.field)
        except (ValueError,UnicodeError,RecursionError): self.error(400,"invalid_json","JSON inválido, profundo, chave repetida ou número não finito; nenhum evento processado.")
        except (TimeoutError,socket.timeout): self.error(408,"request_timeout","Tempo esgotado ao receber o corpo; nenhum evento processado.")
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception:
            global INTERNAL_ERRORS
            with LOCK: INTERNAL_ERRORS += 1
            self.error(503,"unavailable","Laboratório temporariamente indisponível. Nenhuma liberação financeira foi executada.")
    def do_OPTIONS(self): self.error(405,"method","Use GET ou POST nos caminhos documentados.")
    def do_PUT(self): self.do_OPTIONS()
    def do_DELETE(self): self.do_OPTIONS()

class Server(ThreadingMixIn,HTTPServer):
    def handle_error(self, request, address):
        global INTERNAL_ERRORS
        with LOCK: INTERNAL_ERRORS += 1
    daemon_threads=True
    request_queue_size=24
    def process_request(self,request,address):
        if not MAX_CONNECTIONS.acquire(blocking=False):
            body=b'{"ok":false,"error":{"code":"busy","message":"Laboratorio ocupado. Tente novamente em alguns segundos."}}'
            try: request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nConnection: close\r\nRetry-After: 2\r\nContent-Length: "+str(len(body)).encode()+b"\r\n\r\n"+body)
            finally: self.shutdown_request(request)
            return
        try: super().process_request(request,address)
        except Exception:
            MAX_CONNECTIONS.release(); raise
    def process_request_thread(self,request,address):
        try: super().process_request_thread(request,address)
        finally: MAX_CONNECTIONS.release()

if __name__=="__main__":
    Server(("127.0.0.1",int(os.environ.get("CHALLENGE_PORT","18766"))),Handler).serve_forever()

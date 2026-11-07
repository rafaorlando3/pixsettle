import copy
import concurrent.futures
import http.client
import json
import socket
import threading
import time
import unittest
from unittest import mock
from engine import evaluate,verify,Invalid,FIXTURE,digest
import server
SHA="a"*40

def event(**kw):
    e={"event_id":"DEMO-EVT-1","kind":"payment","amount_minor":10000,"currency":"BRL","reference":"PS-DEMO-001","occurred_at":"2030-01-01T12:01:00Z","payment_id":""}
    e.update(kw);return e

def result(*events):return evaluate({"events":list(events)},SHA)
def summary(*events):return result(*events)["receipt"]["summary"]
class Policy(unittest.TestCase):
 def test_valid_control(self):
    s=summary(event());self.assertEqual(s["decision"],"matched");self.assertEqual(s["simulated_release_count"],1)
 def test_duplicate_is_not_second_release(self):
    s=summary(event(),event());self.assertEqual(s["decision"],"held");self.assertEqual(s["reasons"][0]["code"],"duplicate");self.assertEqual(s["simulated_release_count"],1);self.assertEqual(s["naive_notification_release_count"],2)
 def test_amount_mismatch_both_sides(self):
    for n in [9999,10001]:self.assertEqual(summary(event(amount_minor=n))["reasons"][0]["code"],"amount_mismatch")
 def test_expiration_exclusive_boundary(self):
    for at,decision in [("12:09:59","matched"),("12:10:00","held"),("12:10:01","held")]:self.assertEqual(summary(event(occurred_at="2030-01-01T"+at+"Z"))["decision"],decision)
 def test_missing_link_not_matched_by_value(self):
    for ref in ["","PS-DEMO-002"]:self.assertEqual(summary(event(reference=ref))["decision"],"exception")
 def test_refund_after_paid_retains_history(self):
    s=summary(event(),event(event_id="DEMO-EVT-2",kind="refund",payment_id="DEMO-EVT-1",occurred_at="2030-01-01T12:02:00Z"));self.assertTrue(s["refund_recorded"]);self.assertEqual(s["simulated_release_count"],1);self.assertEqual(s["decision"],"exception")
 def test_unlinked_refund_no_effect(self):
    s=summary(event(kind="refund"));self.assertFalse(s["refund_recorded"]);self.assertEqual(s["decision"],"exception")
 def test_refund_wrong_link_no_effect(self):
    s=summary(event(),event(event_id="DEMO-EVT-2",kind="refund",payment_id="DEMO-EVT-9"));self.assertFalse(s["refund_recorded"])
 def test_refund_wrong_amount_no_effect(self):
    s=summary(event(),event(event_id="DEMO-EVT-2",kind="refund",payment_id="DEMO-EVT-1",amount_minor=9999));self.assertFalse(s["refund_recorded"])
 def test_refund_before_payment_rejected(self):
    s=summary(event(),event(event_id="DEMO-EVT-2",kind="refund",payment_id="DEMO-EVT-1",occurred_at="2030-01-01T12:00:00Z"));self.assertFalse(s["refund_recorded"]);self.assertIn("refund_before_payment",[x["code"] for x in s["reasons"]])
 def test_second_refund_no_second_effect(self):
    ref=event(event_id="DEMO-EVT-2",kind="refund",payment_id="DEMO-EVT-1",occurred_at="2030-01-01T12:02:00Z")
    s=summary(event(),ref,{**ref,"event_id":"DEMO-EVT-3"});self.assertTrue(s["refund_recorded"]);self.assertEqual(s["reasons"][0]["code"],"already_refunded")
 def test_conflicting_identity_preserves_original(self):
    s=summary(event(),event(amount_minor=1));self.assertEqual(s["decision"],"exception");self.assertEqual(s["reasons"][0]["code"],"identity_conflict");self.assertEqual(s["simulated_release_count"],1)
 def test_new_identity_does_not_pay_twice(self):
    s=summary(event(),event(event_id="DEMO-EVT-2"));self.assertEqual(s["simulated_release_count"],1);self.assertEqual(s["reasons"][0]["code"],"already_paid")
 def test_combined_reasons_visible(self):
    s=summary(event(reference="",amount_minor=1,occurred_at="2030-01-01T12:11:00Z"));self.assertEqual({r["code"] for r in s["reasons"]},{"missing_link","amount_mismatch","expired"})
 def test_malformed_amount_matrix(self):
    for n in [-1,0,100000001,1.5,True,"10000",None,float("inf"),10**200]:
      with self.subTest(n=str(n)):
       with self.assertRaises(Invalid):result(event(amount_minor=n))
 def test_malicious_and_personal_references_refused(self):
    for ref in ["<script>alert(1)</script>","https://example.org","x@y.com","12345678900","PS-DEMO-001\n","PS-DEMO-001 " ,"x"*4096]:
      with self.subTest(ref=ref[:20]):
       with self.assertRaises(Invalid):result(event(reference=ref))
 def test_absurd_dates_refused(self):
    for at in ["2030-02-30T12:00:00Z","2030-01-01T12:99:00Z","2030-01-01T12:00:60Z","2030-01-01T11:59:59Z","2030-01-01T13:00:00Z","2030-01-01T12:00:00-03:00", "NaN"]:
      with self.subTest(at=at):
       with self.assertRaises(Invalid):result(event(occurred_at=at))
 def test_strict_shape_and_types(self):
    for req in [{},{"events":[]},{"events":[event()]*7},{"events":[{**event(),"extra":1}]},{"events":[None]},{"events":True},{"events":[event(currency="USD")]},{"events":[event(event_id=1)]},{"events":[event(payment_id="DEMO-EVT-2")]},{"events":[event(kind="withdrawal")]}]:
      with self.assertRaises(Invalid):evaluate(req,SHA)
 def test_receipt_reproduces_whole_decision(self):
    out=result(event());self.assertTrue(verify(out,SHA)["verified"])
 def test_hash_only_rewrite_cannot_fake_decision(self):
    out=result(event(amount_minor=1));out["receipt"]["summary"]["decision"]="matched";out["sha256"]=digest(out["receipt"]);self.assertFalse(verify(out,SHA)["verified"])
 def test_tampered_input_and_hash_refused(self):
    out=result(event());out["receipt"]["request"]["events"][0]["amount_minor"]=9999;self.assertFalse(verify(out,SHA)["verified"])
 def test_other_version_inconclusive(self):self.assertEqual(verify(result(event()),"b"*40)["code"],"version_mismatch")
 def test_no_mutation_and_deterministic_reset(self):
    req={"events":[event(),event()]};before=copy.deepcopy(req);a=evaluate(req,SHA);self.assertEqual(req,before);self.assertEqual(evaluate(req,SHA),a);self.assertEqual(summary(event())["decision"],"matched")
 def test_concurrent_visitors_independent(self):
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
     all_results=list(pool.map(lambda _:summary(event()),range(40)))
    self.assertTrue(all(s["simulated_release_count"]==1 for s in all_results))

class RevisedPolicy(unittest.TestCase):
 def test_duplicate_refund_preserves_order_state(self):
    r=event(event_id="DEMO-EVT-2",kind="refund",payment_id="DEMO-EVT-1",occurred_at="2030-01-01T12:02:00Z")
    out=result(event(),r,r);s=out["receipt"]["summary"]
    self.assertEqual(s["last_event_decision"],"held");self.assertEqual(s["order_status"],"refund_exception");self.assertIn("nenhum novo efeito",s["reasons"][0]["message"]);self.assertTrue(verify(out,SHA)["verified"])
 def test_second_held_event_keeps_matched_order(self):
    s=summary(event(),event(event_id="DEMO-EVT-2"));self.assertEqual(s["order_status"],"matched");self.assertEqual(s["last_event_decision"],"held")
 def test_later_refund_not_limited_by_payment_expiration(self):
    s=summary(event(),event(event_id="DEMO-EVT-2",kind="refund",payment_id="DEMO-EVT-1",occurred_at="2030-01-01T12:59:59Z"));self.assertEqual(s["order_status"],"refund_exception")
 def test_arrival_order_declared_not_silently_sorted(self):
    out=result(event(occurred_at="2030-01-01T12:05:00Z"),event(event_id="DEMO-EVT-2"));self.assertEqual(out["receipt"]["processing_order"],"arrival_order");self.assertEqual(out["receipt"]["summary"]["matched_payment"],"DEMO-EVT-1")

class HTTP(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
    cls.web=server.Server(("127.0.0.1",0),server.Handler);cls.thread=threading.Thread(target=cls.web.serve_forever,daemon=True);cls.thread.start();cls.port=cls.web.server_port
 @classmethod
 def tearDownClass(cls):cls.web.shutdown();cls.web.server_close();cls.thread.join()
 def setUp(self):
    with server.LOCK:server.VISITORS.clear();server.GLOBAL.clear();server.RECEIPTS.clear()
 def req(self,path,body=None,headers=None,method=None):
    conn=http.client.HTTPConnection("127.0.0.1",self.port,timeout=7)
    if body is not None and not isinstance(body,bytes):body=json.dumps(body).encode()
    conn.request(method or ("POST" if body is not None else "GET"),path,body,headers or ({"Content-Type":"application/json"} if body else {}));r=conn.getresponse();data=r.read();h=dict(r.getheaders());status=r.status;conn.close();return status,h,data
 def test_api_and_public_receipt(self):
    status,h,b=self.req("/api/evaluate",{"events":[event()]});self.assertEqual(status,200);out=json.loads(b)
    st,_,public=self.req("/api/receipts/"+out["sha256"]);self.assertEqual(st,200);self.assertEqual(json.loads(public),out)
    st,_,v=self.req("/api/verify",out);self.assertTrue(json.loads(v)["verified"])
 def test_invalid_json_duplicate_keys_and_nonfinite(self):
    for b in [b'{ ',b'{"events":[],"events":[]}',b'{"events":NaN}',b'\xff ',b'['*3000+b'0'+b']'*3000]:
     st,_,out=self.req("/api/evaluate",b);self.assertIn(st,[400,422]);self.assertIn(json.loads(out)["error"]["code"],["invalid_json","request_shape"])
 def test_validation_has_explicit_reason(self):
    st,_,out=self.req("/api/evaluate",{"events":[event(reference="<script>")]});self.assertEqual(st,422);e=json.loads(out)["error"];self.assertEqual(e["code"],"reference_format");self.assertTrue(e["message"]);self.assertTrue(e["field"])
 def test_content_type_and_size_refused(self):
    self.assertEqual(self.req("/api/evaluate",b'{}',{"Content-Type":"text/plain"})[0],415)
    self.assertEqual(self.req("/api/evaluate",b' '*16385)[0],413)
 def test_bad_content_length(self):
    conn=socket.create_connection(("127.0.0.1",self.port),timeout=5);conn.sendall(b"POST /api/evaluate HTTP/1.1\r\nHost: localhost\r\nContent-Length: x\r\nContent-Type: application/json\r\n\r\n")
    self.assertIn(b"400",conn.recv(4096).split(b"\r\n")[0]);conn.close()
 def test_foreign_origin_refused(self):
    self.assertEqual(self.req("/api/evaluate",b'{}',{"Content-Type":"application/json","Origin":"https://example.org"})[0],403)
 def test_paths_and_methods_refused(self):
    for path in ["/../server.py","/server.py","/.git/config","/api/nope","/favicon.ico"]:self.assertEqual(self.req(path)[0],404)
    self.assertEqual(self.req("/",b'{}',method="PUT")[0],405)
 def test_rate_limit_and_retry_after(self):
    for _ in range(30):self.assertEqual(self.req("/api/version")[0],200)
    status,h,b=self.req("/api/version");self.assertEqual(status,429);self.assertEqual(h["Retry-After"],"60");self.assertEqual(json.loads(b)["error"]["code"],"rate_limit")
 def test_global_quota(self):
    with server.LOCK:server.GLOBAL.extend([server.time.monotonic()]*180)
    self.assertEqual(self.req("/api/version")[0],429)
 def test_public_source_and_security_headers(self):
    for path in ["/","/app.js","/style.css","/source/engine.py"]:
     st,h,b=self.req(path);self.assertEqual(st,200);self.assertEqual(h["X-Content-Type-Options"],"nosniff");self.assertIn("frame-ancestors 'none'",h["Content-Security-Policy"]);self.assertNotIn("Set-Cookie",h)
 def test_expired_receipt_is_explicit(self):
    out=result(event());
    with server.LOCK:server.RECEIPTS[out["sha256"]]=(server.time.monotonic()-901,out)
    st,_,b=self.req("/api/receipts/"+out["sha256"]);self.assertEqual(st,404);self.assertEqual(json.loads(b)["error"]["code"],"receipt_expired")
 def test_reset_is_stateless(self):
    for _ in range(2):
     st,_,b=self.req("/api/evaluate",{"events":[event()]});self.assertEqual(json.loads(b)["receipt"]["summary"]["simulated_release_count"],1)

class ProxyHTTP(unittest.TestCase):
 setUpClass=classmethod(HTTP.setUpClass.__func__)
 tearDownClass=classmethod(HTTP.tearDownClass.__func__)
 setUp=HTTP.setUp
 req=HTTP.req
 # Only additional tests; inherited HTTP checks also run under the same local server.
 def test_head_returns_metadata_without_body(self):
    st,h,b=self.req("/",method="HEAD");self.assertEqual(st,200);self.assertEqual(b,b"");self.assertGreater(int(h["Content-Length"]),100)
 def test_origin_host_case_normalization(self):
    st,_,_=self.req("/api/evaluate",{"events":[event()]},{"Content-Type":"application/json","Host":"LOCALHOST","Origin":"http://localhost"});self.assertEqual(st,200)
 def test_trusted_proxy_requires_exact_valid_origin(self):
    with mock.patch.object(server,"TRUST_LOCAL_PROXY",True):
     for header in [{},{"X-Real-IP":"not-an-ip"},{"X-Real-IP":"127.0.0.2, 127.0.0.3"}]:
      st,_,b=self.req("/api/version",headers=header);self.assertEqual(st,400);self.assertEqual(json.loads(b)["error"]["code"],"proxy_identity")
 def test_two_proxy_origins_have_separate_buckets(self):
    with mock.patch.object(server,"TRUST_LOCAL_PROXY",True):
     for _ in range(30):self.assertEqual(self.req("/api/version",headers={"X-Real-IP":"192.0.2.1"})[0],200)
     self.assertEqual(self.req("/api/version",headers={"X-Real-IP":"192.0.2.1"})[0],429)
     self.assertEqual(self.req("/api/version",headers={"X-Real-IP":"192.0.2.2"})[0],200)
 def test_untrusted_forwarding_headers_do_not_bypass_limits(self):
    with mock.patch.object(server,"TRUST_LOCAL_PROXY",False):
     for n in range(30):self.assertEqual(self.req("/api/version",headers={"X-Real-IP":"192.0.2."+str(n+1)})[0],200)
     self.assertEqual(self.req("/api/version",headers={"X-Real-IP":"192.0.2.200"})[0],429)

class HardeningHTTP(unittest.TestCase):
 setUpClass=classmethod(HTTP.setUpClass.__func__)
 tearDownClass=classmethod(HTTP.tearDownClass.__func__)
 setUp=HTTP.setUp
 req=HTTP.req
 def test_query_string_and_index_alias(self):
    for path in ["/?utm_source=test","/index.html","/api/version?x=1"]:self.assertEqual(self.req(path)[0],200)
 def test_python_version_not_in_server_header(self):
    st,h,b=self.req("/api/version");self.assertNotIn("Python",h["Server"])
 def test_unicode_and_huge_content_length_refused(self):
    for value in [b"\xb2",b"9"*5000]:
     conn=socket.create_connection(("127.0.0.1",self.port),timeout=5)
     conn.sendall(b"POST /api/evaluate HTTP/1.1\r\nHost: localhost\r\nContent-Length: "+value+b"\r\nContent-Type: application/json\r\n\r\n")
     self.assertIn(b"400",conn.recv(4096).split(b"\r\n")[0]);conn.close()
 def test_invalid_embedded_receipt_is_explicitly_unverified(self):
    out=result(event());out["receipt"]["request"]["events"][0]["reference"]="<script>"
    st,_,b=self.req("/api/verify",out);self.assertEqual(st,200);self.assertFalse(json.loads(b)["verified"])
 def test_transfer_encoding_refused(self):
    st,_,b=self.req("/api/evaluate",b'{}',{"Content-Type":"application/json","Transfer-Encoding":"chunked"});self.assertEqual(st,400);self.assertEqual(json.loads(b)["error"]["code"],"transfer_encoding")
 def test_total_deadline_while_headers_are_incomplete(self):
    with mock.patch.object(server,"REQUEST_DEADLINE_SECONDS",.15):
     conn=socket.create_connection(("127.0.0.1",self.port),timeout=2);start=time.monotonic();conn.sendall(b"GET / HTTP/1.1\r\nHost:")
     data=conn.recv(4096);self.assertIn(b"408",data.split(b"\r\n")[0]);self.assertLess(time.monotonic()-start,1);conn.close()
 def test_total_deadline_while_body_is_incomplete(self):
    with mock.patch.object(server,"REQUEST_DEADLINE_SECONDS",.15):
     conn=socket.create_connection(("127.0.0.1",self.port),timeout=2)
     conn.sendall(b"POST /api/evaluate HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
     data=conn.recv(4096);self.assertIn(b"408",data.split(b"\r\n")[0]);conn.close()
 def test_busy_handler_has_retry_after_and_reason(self):
    self.assertTrue(server.MAX_CONNECTIONS.acquire())
    # Replace with an exhausted semaphore only in this server test.
    try:
     with mock.patch.object(server,"MAX_CONNECTIONS",threading.BoundedSemaphore(0)):
      st,h,b=self.req("/api/version");self.assertEqual(st,503);self.assertEqual(h["Retry-After"],"2");self.assertEqual(json.loads(b)["error"]["code"],"busy")
    finally:server.MAX_CONNECTIONS.release()
 def test_receipt_cache_bound_256(self):
    with server.LOCK:
     for n in range(256):server.RECEIPTS[str(n)]=(time.monotonic(),{})
    st,_,b=self.req("/api/evaluate",{"events":[event()]});self.assertEqual(st,200)
    with server.LOCK:self.assertEqual(len(server.RECEIPTS),256);self.assertNotIn("0",server.RECEIPTS)

if __name__=="__main__":unittest.main(verbosity=2)

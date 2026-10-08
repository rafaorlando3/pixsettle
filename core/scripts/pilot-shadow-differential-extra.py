import sys,json,base64
sys.path.insert(0,sys.argv[1]); import test_validar_feed as T
import validar_feed as V
cases=[]
def packed(v):
 if isinstance(v,(bytes,bytearray)):return {'_bytes':base64.b64encode(v).decode()}
 if isinstance(v,dict):return {k:packed(x) for k,x in v.items()}
 if isinstance(v,(list,tuple)):return [packed(x) for x in v]
 return v
def add(raw,att,ring=T.RING,expect=T.EXP):
 cases.append({'op':'validate','raw':packed(raw),'att_json':json.dumps(att,ensure_ascii=False),'ring':packed(ring),'expect':packed(expect),'expected':packed(V.validate(raw,att,ring,expect))})
for token in [b'NaN',b'Infinity',b'-Infinity',b'15e2',b'1500.0']:
 raw,att=T.lote(T.GOOD);add(raw.replace(b'"amount_minor":1500',b'"amount_minor":'+token,1),att)
for ts,utc in [('0000-01-01T00:00:00Z','00000101T000000Z'),('2024-02-29T13:00:00Z','20240229T130000Z'),('2026-02-29T13:00:00Z','20260229T130000Z')]:
 raw,att=T.lote([T.ev(1,'order_created',ts=ts,utc=utc,order_ref=T.O)]);add(raw,att)
for key in ['schema','origin','store','cursor','event_id','type','at','amount_minor','currency']:
 for value in [None,[],{},True,15.0]:
  e=dict(T.GOOD[0]);e[key]=value
  try:raw,att=T.lote([e])
  except Exception:
   raw=json.dumps(e).encode()+b'\n';att={}
  add(raw,att)
for key in ['origin','store','key_id','sha256','sig','signed_at','from','to','scan_from','count','bytes','overlap_count','totals_minor']:
 for value in [None,[],{},True,15.0]:
  raw,att=T.lote(T.GOOD);att[key]=value;att['sig']=T.attest_sig(att,T.KEY) if key!='sig' else value;add(raw,att)
with open(sys.argv[2],'w') as f:
 for c in cases:f.write(json.dumps(c,ensure_ascii=False)+'\n')
print(len(cases))

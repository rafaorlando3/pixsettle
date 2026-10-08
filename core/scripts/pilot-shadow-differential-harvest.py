import sys, os, json, base64, importlib, unittest
ref=sys.argv[1]; dest=sys.argv[2]; sys.path.insert(0,ref)
import validar_feed as V
cases=[]
def packed(v):
    if isinstance(v,(bytes,bytearray)): return {'_bytes':base64.b64encode(v).decode()}
    if isinstance(v,dict): return {k:packed(x) for k,x in v.items()}
    if isinstance(v,(list,tuple)): return [packed(x) for x in v]
    return v
def wrap_validate(raw,att,keyring=None,expect=None):
    result=orig_validate(raw,att,keyring,expect)
    cases.append({'op':'validate','raw':packed(raw),'att_json':json.dumps(att,ensure_ascii=False),'ring':packed(keyring),'expect':packed(expect),'expected':packed(result)})
    return result
orig_validate=V.validate; V.validate=wrap_validate
orig_pronto=V.check_pronto
def wrap_pronto(*args):
    r=orig_pronto(*args); cases.append({'op':'pronto','args':packed(args),'expected':r}); return r
V.check_pronto=wrap_pronto
orig_ck=V.next_checkpoint
def wrap_ck(*args):
    r=orig_ck(*args); cases.append({'op':'checkpoint','args':packed(args),'expected':r}); return r
V.next_checkpoint=wrap_ck
orig_kr=V.parse_keyring
def wrap_kr(data,environ):
    try:
        r=orig_kr(data,environ); cases.append({'op':'keyring','data':packed(data),'env':environ,'expected':{'ok':True,'ring':packed(r)}}); return r
    except Exception:
        cases.append({'op':'keyring','data':packed(data),'env':environ,'expected':{'ok':False}}); raise
V.parse_keyring=wrap_kr
orig_rb=V.read_bounded
def wrap_rb(path,limit):
    with open(path,'rb') as f: data=f.read()
    try:
        r=orig_rb(path,limit); cases.append({'op':'bounded','data':packed(data),'limit':limit,'expected':{'ok':True,'data':packed(r)}}); return r
    except V.TooLarge:
        cases.append({'op':'bounded','data':packed(data),'limit':limit,'expected':{'ok':False}}); raise
V.read_bounded=wrap_rb
T=importlib.import_module('test_validar_feed')
orig_cli=T.cli
def wrap_cli(files,ring_obj=T.KR,extra=()):
    r=orig_cli(files,ring_obj,extra); cases.append({'op':'cli','files':packed(files),'ring_json':ring_obj if isinstance(ring_obj,str) else None if ring_obj is None else json.dumps(ring_obj),'extra':list(extra),'expected':list(r)}); return r
T.cli=wrap_cli
result=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromModule(T))
with open(dest,'w') as f:
    for c in cases:f.write(json.dumps(c,ensure_ascii=False)+'\n')
print(json.dumps({'original_tests':result.testsRun,'original_failures':len(result.failures),'original_errors':len(result.errors),'differential_cases':len(cases),'cases_by_operation':{op:sum(c['op']==op for c in cases) for op in sorted(set(c['op'] for c in cases))}}))
sys.exit(not result.wasSuccessful())

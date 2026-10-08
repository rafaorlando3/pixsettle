import {describe,it,expect,afterEach,vi} from 'vitest'
import {OpenAICompatibleModel,MAX_MODEL_RESPONSE_BYTES} from '../src/copilot/model.js'
const input={system:'fixture',user:'fixture'}
const model=()=>new OpenAICompatibleModel('fixture','fixture','https://fixture.invalid',15)
afterEach(()=>vi.unstubAllGlobals())
describe('complete request deadline',()=>{
 it('fails when no response headers arrive',async()=>{vi.stubGlobal('fetch',vi.fn(()=>new Promise(()=>{})));await expect(model().complete(input)).rejects.toMatchObject({code:'timeout',body:null})})
 it('fails when headers arrive but response body stalls',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,text:()=>new Promise(()=>{})})));await expect(model().complete(input)).rejects.toMatchObject({code:'timeout',body:null})})
 it('rejects unsuccessful HTTP without reading its potentially private or stalled body',async()=>{const text=vi.fn(()=>new Promise(()=>{}));vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:429,text})));await expect(model().complete(input)).rejects.toMatchObject({code:'http',status:429,message:'provider_http_error',body:null});expect(text).not.toHaveBeenCalled()})
 it('caps bytes before decoding a UTF-8 response',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('é'.repeat(MAX_MODEL_RESPONSE_BYTES/2+1),{status:200})));await expect(model().complete(input)).rejects.toMatchObject({code:'invalid_response',message:'response_too_large',body:null})})
 it('cancels a progressively oversized response stream',async()=>{let chunks=0;const cancel=vi.fn();const body=new ReadableStream<Uint8Array>({pull(c){chunks++;c.enqueue(new Uint8Array(chunks<=2?64*1024:1))},cancel});vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{status:200})));await expect(model().complete(input)).rejects.toMatchObject({code:'invalid_response',message:'response_too_large'});expect(cancel).toHaveBeenCalledTimes(1)})
})

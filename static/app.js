"use strict";
const $ = id => document.getElementById(id);
const appBase=new URL(".",document.currentScript.src);
const endpoint=path=>new URL(path.replace(/^\//,""),appBase).href;
let current = null, busy = false;
const labels = {matched:"CASADO",held:"RETIDO",exception:"EXCEÇÃO"};
const orderLabels={matched:"Pago na simulação",refund_exception:"Devolução registrada, em exceção",unpaid_held:"Sem pagamento casado",unpaid_exception:"Sem pagamento casado, em exceção"};
function event(overrides={}) {return {event_id:"DEMO-EVT-1",kind:"payment",amount_minor:10000,currency:"BRL",reference:"PS-DEMO-001",occurred_at:"2030-01-01T12:01:00Z",payment_id:"",...overrides};}
const scenarios = {
 duplicate:()=>{const e=event();return {events:[e,{...e}]};},
 amount:()=>({events:[event({amount_minor:9999})]}),
 expired:()=>({events:[event({occurred_at:"2030-01-01T12:11:00Z"})]}),
 refund:()=>({events:[event(),event({event_id:"DEMO-EVT-2",kind:"refund",payment_id:"DEMO-EVT-1",occurred_at:"2030-01-01T12:02:00Z"})]}),
 missing:()=>({events:[event({reference:""})]}), valid:()=>({events:[event()]})
};
async function request(path, body){
 const c=new AbortController(), t=setTimeout(()=>c.abort(),10000);
 try{
  const r=await fetch(endpoint(path),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:c.signal,credentials:"omit"});
  let data; try{data=await r.json();}catch{throw new Error("Resposta inesperada do servidor. Nenhuma decisão foi confirmada.");}
  if(!r.ok)throw new Error(`${data.error?.code||r.status}: ${data.error?.message||"Requisição recusada."}${data.error?.field?" Campo: "+data.error.field:""}`);
  return data;
 }catch(e){if(e.name==="AbortError")throw new Error("Tempo de resposta esgotado. Nenhuma decisão foi confirmada. Tente novamente.");if(e instanceof TypeError)throw new Error("Falha de conexão. Confira a rede; nenhuma decisão foi confirmada.");throw e;}
 finally{clearTimeout(t);}
}
function error(message){$("error").textContent=message;$("error").hidden=false;}
function lock(value){busy=value;document.querySelectorAll("button[data-case],#submit-event,#reset,#verify").forEach(b=>b.disabled=value);}
function clearResult(){current=null;$("status").textContent="";$("status").className="";$("result").hidden=true;$("error").hidden=true;$("verify-result").textContent="";}
function render(envelope){
 current=envelope;const r=envelope.receipt,s=r.summary;
 $("status").hidden=true;$("result").hidden=false;
 $("decision-card").className=s.order_status==="refund_exception"?"exception":s.decision;
 $("decision-tag").textContent="Último evento: "+labels[s.last_event_decision];
 $("decision-title").textContent=s.order_status==="refund_exception"?"Devolução registrada no pedido.":s.matched_payment?(s.decision==="matched"?"Conferiu. Uma única vez.":s.decision==="held"?"Pedido pago. Novo evento retido.":"Pedido pago. Novo evento em exceção."):s.decision==="held"?"Evento retido. Pedido sem pagamento.":"Evento em exceção. Pedido sem pagamento.";
 $("order-status").textContent="Estado do pedido: "+orderLabels[s.order_status]+".";
 $("reasons").replaceChildren(...s.reasons.map(x=>{const li=document.createElement("li");li.textContent=x.message;return li;}));
 $("naive").textContent=s.naive_notification_release_count+" liberação(ões)";
 $("safe").textContent=s.simulated_release_count+" liberação(ões)";
 $("naive-copy").textContent=s.refund_recorded?"Uma integração ingênua manteria o pedido como pago sem conferir a devolução.":s.naive_notification_release_count>1?"Confiar em cada notificação repetiria a liberação simulada.":"Confiar só na notificação ignora vínculo, valor e prazo.";
 if(s.decision==="matched")$("naive-copy").textContent="No controle válido, as duas simulações chegam a uma liberação.";
 $("safe-copy").textContent=s.refund_recorded?"Pagamento preservado no histórico; devolução gera exceção para conferência, sem desfazer dinheiro externo.":s.decision==="matched"?"Todos os campos conferiram. O pedido foi casado uma única vez.":s.simulated_release_count?"A primeira liberação fica no histórico; este novo evento não gera outra.":"A tentativa não gerou liberação simulada.";
 $("history").replaceChildren(...r.decisions.map((x,i)=>{const li=document.createElement("li");li.textContent=`${i+1}. ${x.event_id} → ${labels[x.decision]}: ${x.reasons.map(a=>a.message).join(" ")}`;return li;}));
 $("event-count").textContent=r.decisions.length+" evento(s)";$("hash").textContent=envelope.sha256;
 $("receipt-link").href=endpoint("api/receipts/"+envelope.sha256);$("verify-result").textContent="";
 $("status").textContent="Último evento: "+labels[s.last_event_decision]+". Estado do pedido: "+orderLabels[s.order_status]+". "+s.reasons.map(x=>x.message).join(" ");$("status").hidden=false;
 $("status").className="sr-status";
}
async function run(body){
 if(busy)return;clearResult();lock(true);$("status").hidden=false;$("status").className="";$("status").textContent="Conferindo evento sintético…";
 try{render(await request("/api/evaluate",body));}catch(e){error(e.message);$("status").textContent="Evento não confirmado.";}
 finally{lock(false);}
}
document.querySelectorAll("button[data-case]").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll("button[data-case]").forEach(x=>x.classList.toggle("active",x===b));run(scenarios[b.dataset.case]());}));
function tab(which){const free=which==="free";$("cases").hidden=free;$("free").hidden=!free;for(const id of ["cases","free"]){const b=$("tab-"+id),sel=id===which;b.setAttribute("aria-selected",String(sel));b.tabIndex=sel?0:-1;}}
for(const name of ["cases","free"]){$("tab-"+name).addEventListener("click",()=>tab(name));$("tab-"+name).addEventListener("keydown",e=>{if(["ArrowRight","ArrowLeft","Home","End"].includes(e.key)){e.preventDefault();const next=e.key==="Home"?"cases":e.key==="End"?"free":name==="cases"?"free":"cases";tab(next);$("tab-"+next).focus();}});}
$("event-form").addEventListener("submit",e=>{
 e.preventDefault();if(busy)return;$("error").hidden=true;
 const text=$("amount").value;
 if(!/^[0-9]{1,9}$/.test(text)||!Number.isSafeInteger(Number(text))||Number(text)<1||Number(text)>100000000){clearResult();error("amount_range: Use um inteiro entre 1 e 100000000 centavos. Decimais, negativos e valores absurdos são recusados.");$("amount").focus();return;}
 const previous=$("paid").checked;const kind=$("kind").value;
 const events=previous?[event({event_id:"DEMO-EVT-0",occurred_at:"2030-01-01T12:00:00Z"})]:[];
 const x=event({amount_minor:Number(text),reference:$("reference").value,occurred_at:$("time").value,kind,payment_id:kind==="refund"&&previous?"DEMO-EVT-0":""});events.push(x);if($("duplicate").value==="identical")events.push({...x});if($("duplicate").value==="conflict")events.push({...x,amount_minor:x.amount_minor===100000000?99999999:x.amount_minor+1});run({events});
});
$("reset").addEventListener("click",()=>{if(busy)return;clearResult();$("event-form").reset();document.querySelectorAll("button[data-case]").forEach(x=>x.classList.remove("active"));$("status").hidden=false;$("status").className="";$("status").textContent="Laboratório reiniciado. Escolha um desafio; cada tentativa usa um histórico novo.";});
$("verify").addEventListener("click",async()=>{if(!current||busy)return;lock(true);$("error").hidden=true;try{const out=await request("/api/verify",current);$("verify-result").textContent=(out.verified?"✓ ":"Recusado: ")+out.message;}catch(e){error(e.message);}finally{lock(false);}});
$("download").addEventListener("click",()=>{if(!current)return;const url=URL.createObjectURL(new Blob([JSON.stringify(current,null,2)+"\n"],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="pixsettle-synthetic-"+current.sha256.slice(0,12)+".json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
fetch(endpoint("/api/version"),{credentials:"omit"}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(d=>{$("build").textContent=d.schema+" · commit "+d.source_sha;}).catch(()=>{$("build").textContent="Versão indisponível; consulte o endpoint antes de citar esta prova.";});

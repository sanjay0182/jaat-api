export default `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Jaat API</title>
<style>
:root{--bg:#fafafa;--c:#fff;--b:#e8e8ec;--t:#18181b;--m:#71717a;--a:#2563eb;--g:#16a34a;--r:#dc2626;--o:#d97706}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif}
.w{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:19px;margin:0}h2{font-size:14px;margin:0 0 10px;color:var(--m);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:8px}
.card{background:var(--c);border:1px solid var(--b);border-radius:12px;padding:14px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}
.s{background:var(--c);border:1px solid var(--b);border-radius:12px;padding:12px}.s b{display:block;font-size:22px}.s span{color:var(--m);font-size:12px}
button{font:inherit;border:1px solid var(--b);background:var(--c);border-radius:8px;padding:6px 11px;cursor:pointer;color:var(--t)}
button.p{background:var(--a);border-color:var(--a);color:#fff}button.d{color:var(--r)}button:active{opacity:.7}
input{font:inherit;border:1px solid var(--b);border-radius:8px;padding:8px 10px;width:100%;background:#fff}
label{font-size:12px;color:var(--m);display:block;margin:8px 0 3px}
.k{border-top:1px solid var(--b);padding:12px 0}.k:first-of-type{border-top:0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
code{background:#f4f4f5;padding:2px 6px;border-radius:6px;font-size:12px;word-break:break-all}
.bd{font-size:11px;padding:2px 8px;border-radius:99px;font-weight:600}.on{background:#dcfce7;color:var(--g)}.off{background:#fee2e2;color:var(--r)}.ex{background:#fef3c7;color:var(--o)}
.m{color:var(--m);font-size:12px}.bar{height:6px;background:#f0f0f3;border-radius:9px;margin-top:6px;overflow:hidden}.bar i{display:block;height:100%;background:var(--a)}
.ch{display:flex;align-items:flex-end;gap:3px;height:90px}.ch div{flex:1;background:#bfdbfe;border-radius:3px 3px 0 0;min-height:2px;position:relative}.ch div.e{background:#fecaca}
table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:6px 4px;border-top:1px solid var(--b)}th{color:var(--m);font-weight:600;border:0}
.sc{overflow-x:auto}#md{position:fixed;inset:0;background:#0006;display:none;align-items:center;justify-content:center;padding:16px}#md>div{background:#fff;border-radius:14px;padding:18px;width:100%;max-width:380px}
.lg{max-width:340px;margin:18vh auto}
</style></head><body><div class="w">
<div id="lg" class="lg card"><h1>Jaat API</h1><p class="m">Admin key daalo</p><input id="pw" type="password" placeholder="ADMIN_KEY" onkeydown="if(event.key=='Enter')login()"><p><button class="p" onclick="login()">Login</button></p><p class="m" id="er"></p></div>
<div id="app" hidden>
<div class="top"><h1>Jaat API</h1><div><button onclick="load()">Refresh</button> <button onclick="logout()">Logout</button></div></div>
<div class="grid" id="st"></div>
<div class="card"><h2>Last 24 hours</h2><div class="ch" id="ch"></div><div class="row m"><span>24h pehle</span><span>abhi</span></div></div>
<div class="card"><div class="row"><h2 style="margin:0">API Keys</h2><button class="p" onclick="op()">+ New key</button></div><div id="ks"></div></div>
<div class="card"><h2>Models (total requests)</h2><div class="sc"><table id="mt"></table></div></div>
<div class="card"><div class="row"><h2 style="margin:0">AI ke liye guide</h2><button class="p" onclick="cp()">Copy</button></div><p class="m">Ye poora text kisi bhi AI ko paste kar do, use project bhejne ki zaroorat nahi: wo samajh jayega kaunsa model, kahan aur kaisi JSON request bhejni hai.</p><textarea id="gd" readonly rows="16" style="width:100%;font:12px/1.4 ui-monospace,Menlo,monospace;border:1px solid var(--b);border-radius:8px;padding:8px"></textarea></div>
<div class="card"><h2>Recent requests</h2><div class="sc"><table id="lt"></table></div></div>
</div></div>
<div id="md"><div><h1 style="font-size:16px">New API key</h1>
<label>Naam (kiske liye)</label><input id="n" placeholder="e.g. phone, friend-raj">
<label>Kitne din chalegi (0 = hamesha)</label><input id="dy" type="number" value="30">
<label>Rate limit: requests / minute (0 = unlimited)</label><input id="rm" type="number" value="0">
<label>Limit: requests / din (0 = unlimited)</label><input id="rd" type="number" value="0">
<p class="row"><button onclick="cl()">Cancel</button><button class="p" onclick="mk()">Create</button></p></div></div>
<script>
var T=localStorage.getItem("ak")||"",D=null;
function $(i){return document.getElementById(i)}
function E(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return"&#"+c.charCodeAt(0)+";"})}
async function api(o,d){var r=await fetch("/admin",{method:"POST",headers:{authorization:"Bearer "+T,"content-type":"application/json"},body:JSON.stringify(Object.assign({op:o},d||{}))});
if(r.status==401){logout();$("er").textContent="Galat admin key";throw 0}return r.json()}
function login(){T=$("pw").value.trim();localStorage.setItem("ak",T);load()}
function logout(){localStorage.removeItem("ak");T="";$("app").hidden=true;$("lg").hidden=false}
function ago(t){if(!t)return"kabhi nahi";var s=(Date.now()-t)/1e3;return s<60?Math.floor(s)+"s pehle":s<3600?Math.floor(s/60)+"m pehle":s<86400?Math.floor(s/3600)+"h pehle":Math.floor(s/86400)+"d pehle"}
function lf(k){if(!k.expiresAt)return"hamesha";var d=k.expiresAt-Date.now();return d<=0?"expire ho gayi":d<864e5?Math.ceil(d/36e5)+" ghante bache":Math.ceil(d/864e5)+" din bache"}
async function load(){if(!T)return;try{D=await api("list")}catch(e){return}$("lg").hidden=true;$("app").hidden=false;draw();if(!window.GD){window.GD=1;guide()}}
function draw(){var K=D.keys,td=0,tt=0,er=0,M={};
K.forEach(function(k){td+=k.today;tt+=k.total;er+=k.err||0;for(var m in k.models)M[m]=(M[m]||0)+k.models[m]});
var act=K.filter(function(k){return!k.disabled&&!(k.expiresAt&&k.expiresAt<Date.now())}).length;
var ls=D.logs.filter(function(l){return l.ms}),av=ls.length?Math.round(ls.reduce(function(a,l){return a+l.ms},0)/ls.length/100)/10:0;
$("st").innerHTML=[["Aaj",td],["Total",tt],["Active keys",act+"/"+K.length],["Errors",er],["Avg time",av+"s"]].map(function(x){return'<div class="s"><b>'+x[1]+'</b><span>'+x[0]+'</span></div>'}).join("");
var h=[],now=new Date(D.now),mx=1;for(var i=23;i>=0;i--){var d=new Date(D.now-i*36e5),key=d.toISOString().slice(0,13),v=D.hourly[key]||{n:0,e:0};h.push(v);mx=Math.max(mx,v.n)}
$("ch").innerHTML=h.map(function(v){return'<div class="'+(v.e?"e":"")+'" style="height:'+Math.max(2,v.n/mx*100)+'%" title="'+v.n+' req, '+(v.e||0)+' err"></div>'}).join("");
var mxk=Math.max.apply(null,K.map(function(k){return k.total}).concat([1]));
$("ks").innerHTML=K.length?K.map(function(k){var ex=k.expiresAt&&k.expiresAt<Date.now(),b=k.disabled?'<span class="bd off">band</span>':ex?'<span class="bd ex">expired</span>':'<span class="bd on">chal rahi</span>';
return'<div class="k"><div class="row"><b>'+E(k.name)+' '+b+'</b><span class="m">'+lf(k)+'</span></div>'+
'<div class="row" style="margin:6px 0"><code id="c'+k.id+'">'+E(k.key.slice(0,12))+'••••••</code><span><button onclick="cp(\\''+k.id+'\\')">Copy</button> <button onclick="sh(\\''+k.id+'\\')">Dikhao</button></span></div>'+
'<div class="m">Aaj <b>'+k.today+'</b> · Total <b>'+k.total+'</b> · Errors '+(k.err||0)+' · Limit: '+(k.rpm||"∞")+'/min, '+(k.rpd||"∞")+'/din · Last: '+ago(k.last)+'</div>'+
'<div class="bar"><i style="width:'+k.total/mxk*100+'%"></i></div>'+
'<div class="row" style="margin-top:8px"><span><button onclick="ed(\\''+k.id+'\\')">Edit limits</button> <button onclick="tg(\\''+k.id+'\\','+(!k.disabled)+')">'+(k.disabled?"Chalu karo":"Band karo")+'</button> <button onclick="rs(\\''+k.id+'\\')">Reset count</button></span><button class="d" onclick="dl(\\''+k.id+'\\')">Delete</button></div></div>'}).join(""):'<p class="m">Abhi koi key nahi. "+ New key" dabao.</p>';
var ms=Object.keys(M).sort(function(a,b){return M[b]-M[a]});
$("mt").innerHTML='<tr><th>Model</th><th>Requests</th></tr>'+(ms.map(function(m){return'<tr><td>'+E(m)+'</td><td>'+M[m]+'</td></tr>'}).join("")||'<tr><td class="m" colspan=2>Abhi koi request nahi</td></tr>');
$("lt").innerHTML='<tr><th>Time</th><th>Key</th><th>Model</th><th>Status</th><th>ms</th></tr>'+D.logs.slice(0,40).map(function(l){return'<tr><td>'+ago(l.t)+'</td><td>'+E(l.k)+'</td><td>'+E(l.m)+'</td><td style="color:var(--'+(l.s<400?"g":"r")+')">'+l.s+'</td><td>'+(l.ms||"")+'</td></tr>'}).join("")}
function gk(i){return D.keys.filter(function(k){return k.id==i})[0]}
function cp(i){navigator.clipboard.writeText(gk(i).key);alert("Copy ho gayi")}
function sh(i){var c=$("c"+i),k=gk(i).key;c.textContent=c.textContent.indexOf("•")>0?k:k.slice(0,12)+"••••••"}
function op(){$("md").style.display="flex"}function cl(){$("md").style.display="none"}
async function mk(){await api("create",{name:$("n").value||"key",days:+$("dy").value,rpm:+$("rm").value,rpd:+$("rd").value});cl();$("n").value="";load()}
async function ed(i){var k=gk(i),a=prompt("Requests/minute limit (0=unlimited)",k.rpm||0);if(a===null)return;var b=prompt("Requests/din limit (0=unlimited)",k.rpd||0);if(b===null)return;
var d=prompt("Ab se kitne din chalegi? (0=hamesha, khali=badlo mat)","");var u={id:i,rpm:+a,rpd:+b};if(d)u.days=+d;await api("update",u);load()}
async function guide(){
var o=location.origin,ms=[];
try{var r=await fetch("/v1/models",{headers:{authorization:"Bearer "+T}});ms=(await r.json()).data||[]}catch(e){}
var dk=[],fr=[];
ms.forEach(function(m){if(m.owned_by=="duck.ai")dk.push(m.id+(m.free===false?" (paid)":""));else if(m.owned_by!="jaat")fr.push(m.id)});
var J=function(x){return JSON.stringify(x)};
var tl=[{type:"function",function:{name:"get_weather",description:"Get weather of a city",parameters:{type:"object",properties:{city:{type:"string"}},required:["city"]}}}];
var L=[
"JAAT API - OpenAI + Anthropic compatible proxy. Use it exactly like the OpenAI / Anthropic API, only BASE_URL and key differ.",
"BASE_URL: "+o,
"AUTH: header  Authorization: Bearer YOUR_API_KEY   (or  x-api-key: YOUR_API_KEY). Read the key from an env var, never hardcode it.",
"",
"ENDPOINTS",
"  GET  /v1/models              list of model ids",
"  POST /v1/chat/completions    OpenAI chat format (stream, tools, legacy functions)",
"  POST /v1/messages            Anthropic format (stream, tools)",
"  POST /v1/responses           OpenAI Responses format (stream, tools)",
"  POST /v1/images/generations  duck.ai image (1 image/call, b64_json)",
"",
"MODELS (put the id in the \\"model\\" field)",
"  default: jaat-default (used for unknown model names)",
"  duck.ai models (best: tools + streaming + conversation_id): "+(dk.join(", ")||"gpt-5.4-mini, claude-haiku-4-5, claude-sonnet-4-6, ..."),
"  aliases that map to duck.ai: claude-sonnet, claude-haiku, claude-opus, gpt-4o, gpt-4o-mini, gpt-5, duck-auto (any claude-* / gpt-* name also works)",
"  free provider models (each name is one provider, tools pass through only if that provider supports them): "+(fr.join(", ")||"see GET /v1/models"),
"",
"1) CHAT (non-stream)  POST "+o+"/v1/chat/completions",
J({model:"claude-sonnet",messages:[{role:"system",content:"You are helpful."},{role:"user",content:"Hello"}]}),
"   reply: choices[0].message.content",
"",
"2) STREAM: same body + \\"stream\\":true  -> Server-Sent Events, lines  data: {chunk}  (choices[0].delta.content) and finally  data: [DONE]",
"",
"3) TOOLS / FUNCTION CALLING (chat completions)",
J({model:"claude-sonnet",messages:[{role:"user",content:"Weather in Delhi?"}],tools:tl,tool_choice:"auto"}),
"   if the model wants a tool: message.content=null, message.tool_calls[{id,type:function,function:{name,arguments(JSON string)}}], finish_reason=\\"tool_calls\\".",
"   then run the tool yourself and send back the history + the assistant tool_calls message + a tool message:",
J({role:"tool",tool_call_id:"CALL_ID_FROM_REPLY",content:"{\\"temp\\":31}"}),
"   tool_choice: \\"auto\\" | \\"none\\" | \\"required\\" | {\\"type\\":\\"function\\",\\"function\\":{\\"name\\":\\"get_weather\\"}}",
"",
"4) FASTER FOLLOW-UPS (session reuse, duck.ai models only): add \\"conversation_id\\":\\"my-chat-1\\" (or header x-conversation-id). Always send the FULL message history, unchanged, plus the new turn. If history changes it silently starts a fresh chat.",
"",
"5) ANTHROPIC FORMAT  POST "+o+"/v1/messages  (max_tokens required)",
J({model:"claude-sonnet",max_tokens:1024,system:"You are helpful.",messages:[{role:"user",content:"Hello"}]}),
"   reply: content[0].text. Tools use input_schema / tool_use / tool_result blocks as in the official Anthropic API. \\"stream\\":true gives message_start ... message_stop events.",
"",
"6) RESPONSES FORMAT  POST "+o+"/v1/responses",
J({model:"gpt-4o",instructions:"You are helpful.",input:"Hello"}),
"   reply: output_text. input can also be a list of items incl. function_call / function_call_output.",
"",
"OPTIONAL FIELDS: reasoning_effort (low|medium|high), max_tokens, temperature.",
"ERRORS: JSON  {\\"error\\":{\\"message\\":...,\\"type\\":...}}; 401 bad key, 429 rate/day limit of that key, 5xx upstream/duck.ai problem (just retry).",
"NOTES: a request can take 3-20s (real browser behind it). Use a timeout of at least 90s. Streaming is real only for duck.ai models without tools; otherwise chunks arrive at the end."
];
$("gd").value=L.join("\\n")}
function cp(){var t=$("gd");t.select();t.setSelectionRange(0,99999);try{navigator.clipboard.writeText(t.value)}catch(e){document.execCommand("copy")}}
async function tg(i,v){await api("update",{id:i,disabled:v});load()}
async function rs(i){if(confirm("Count zero kar du?")){await api("reset",{id:i});load()}}
async function dl(i){if(confirm("Key delete kar du? Wapas nahi aayegi.")){await api("delete",{id:i});load()}}
if(T)load();setInterval(function(){if(T&&!$("app").hidden)load()},15000);
</script></body></html>`;

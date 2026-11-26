/*
  재고실사 탭 (적재존 실사 · 로케이션 실사) — 앱 AuditController.kt · AuditRepository.kt · AuditScreen.kt 의 웹판.
  규칙·요청·저장 모양은 앱과 똑같이 맞춘다 (5F 현황판·정산이 앱 기록과 섞어서 읽는다).
   · 로그인: 5F 웹(auth-gate.js)·앱과 같은 auth-login (app=wh5f), 매일 13:10 자동 로그아웃
   · 유령 확정: 5F 웹과 같은 잠금(op_lock id=1) → jaeja 위치 '유령-원래위치' → loc_log · ghost_stock → 방송
   · 로케이션 실사: 로케재고 = jaeja_db.stock − jaeja(유령 제외), 저장 표 loc_audit_result
   · 현황판: ghost_audit_live · loc_audit_live (찍은 뒤 1.5초 모아서, 45초마다 살아 있음), 완료 기록 ghost_audit_result
   · 작업자 이름: app_worker (기기마다 하나, 다른 기기와 중복 금지, 30일 안 쓰면 풀림)
  index.html 이 init(api) 로 카메라·소리·DB 최신화 시각을 넘겨 준다.
*/
(function(){
'use strict';

// ── 연결 (앱 MainViewModel.kt 와 같은 값) ──
// 가짜 서버(sim/fake_5f_server.py /scanweb/)는 이 주소를 자기 주소로 바꿔 내보낸다
const SB_URL='https://beomzpaunlxiqwgissrf.supabase.co';
const SB_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJlb216cGF1bmx4aXF3Z2lzc3JmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI1MDk1OTcsImV4cCI6MjA4ODA4NTU5N30.qq4l3QVbIfBTaj0-_XadMyhAmZq1IJLtJd_LtNrsg-Q';

const GHOST_PREFIX='유령-';
const RESULT_TABLE='loc_audit_result';
const BOX_COLUMNS='id,box_code,barcode,qty,position,location,product_name,option_name';
const DB_COLUMNS='product_code,barcode,product_name,option,location,stock';
const LOCK_ID=1, LOCK_TIMEOUT_MS=15000, LOCK_WAIT_MAX_MS=120000;
const WORKER_STALE_DAYS=30;
const LIVE_DEBOUNCE_MS=1500, LIVE_BEAT_MS=45000;
const STATE_KEY='audit_state_v1';
const VOICE_CLIPS='@clips';

const ls={
  get(k,d=''){ try{ const v=localStorage.getItem(k); return v==null?d:v; }catch(e){ return d; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} },
  del(k){ try{ localStorage.removeItem(k); }catch(e){} },
};
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const normCode=s=>String(s||'').trim().toUpperCase();
const normPos=normCode;
const hasHangul=s=>/[ㄱ-ㆎ가-힣]/.test(s);
const uuid=()=>(crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);}));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ── 한국 시간 (기기 시간대가 달라도 현황판이 오늘 날짜로 찾게) ──
function kst(d=new Date()){
  const o={};
  new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
    .formatToParts(d).forEach(p=>{o[p.type]=p.value;});
  if(o.hour==='24') o.hour='00';
  return o;
}
const kstDate=()=>{ const k=kst(); return `${k.year}-${k.month}-${k.day}`; };
const kstHms=()=>{ const k=kst(); return `${k.hour}:${k.minute}:${k.second}`; };
// 5F 웹 nowKo() 와 같은 모양: "2026. 11. 19. 오후 3:05:09" — loc_log·ghost_stock 의 다른 기록과 섞여 정렬된다
function nowKo(){ const k=kst(); const h=+k.hour; return `${k.year}. ${k.month}. ${k.day}. ${h<12?'오전':'오후'} ${h%12||12}:${k.minute}:${k.second}`; }
function shortTime(iso){ const d=new Date(iso); if(isNaN(d)) return String(iso||'').slice(0,16); const k=kst(d); return `${k.month}-${k.day} ${k.hour}:${k.minute}`; }

// ── 기기 이름 (현황판에서 기기를 구분) ──
function model(){
  const ua=navigator.userAgent||'';
  if(/iPhone/.test(ua)) return 'iPhone';
  if(/iPad/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1)) return 'iPad';
  if(/Android/.test(ua)) return 'Android';
  return 'PC';
}
let DEVICE=ls.get('audit_device_id');
if(!DEVICE){ DEVICE=`웹-${model()}-${uuid().slice(0,4).toUpperCase()}`; ls.set('audit_device_id',DEVICE); }

// ══ 로그인 (auth-gate.js 와 같은 규칙: 8시간 토큰 + 매일 13:10 자동 로그아웃) ══
const K_TOKEN='scanweb_token', K_EXP='scanweb_exp', K_CUT='scanweb_cutoff', K_USER='scanweb_user';
function nextCutoff(now=Date.now()){
  // 한국 13:10 = UTC 04:10
  const d=new Date(now); const c=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),4,10,0);
  let cut=c; while(cut<=now) cut+=86400000; while(cut-86400000>now) cut-=86400000;
  return cut;
}
const Auth={
  token(){ return ls.get(K_TOKEN); },
  name(){ try{ const u=JSON.parse(ls.get(K_USER,'{}')); return u.name||u.empNo||''; }catch(e){ return ''; } },
  valid(){ const t=this.token(); if(!t) return false; const now=Date.now(); return now<+ls.get(K_EXP,0)&&now<+ls.get(K_CUT,0); },
  expiredReason(){
    if(!this.token()) return '';
    const now=Date.now();
    if(now>=+ls.get(K_EXP,0)) return '로그인 유효시간(8시간)이 지났습니다.';
    if(now>=+ls.get(K_CUT,0)) return '점심시간 자동 로그아웃되었습니다. 다시 로그인해 주세요.';
    return '';
  },
  save(token,expMs,user){ ls.set(K_TOKEN,token); ls.set(K_EXP,String(expMs)); ls.set(K_CUT,String(nextCutoff())); ls.set(K_USER,JSON.stringify(user||{})); },
  clear(){ [K_TOKEN,K_EXP,K_CUT,K_USER].forEach(k=>ls.del(k)); },
  async login(empNo,password){
    let text='';
    const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),8000);
    try{
      const res=await fetch(SB_URL+'/functions/v1/auth-login',{method:'POST',signal:ctrl.signal,
        headers:{apikey:SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({empNo,password,app:'wh5f'})});
      text=await res.text();
    }catch(e){ throw new Error('서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.'); }
    finally{ clearTimeout(t); }
    let j=null; try{ j=JSON.parse(text); }catch(e){}
    if(!j||!j.ok||!j.token) throw new Error((j&&j.message)||'로그인에 실패했습니다.');
    const user=j.user||{}; if(!user.name&&!user.empNo) user.empNo=empNo;
    this.save(j.token,Math.round((+j.expiresAt||0)*1000),user);
  },
};
let loginMessage='';
function ensureSession(){
  if(Auth.valid()) return true;
  if(Auth.token()){ loginMessage=Auth.expiredReason(); Auth.clear(); }
  return false;
}
function logout(msg){ Auth.clear(); loginMessage=msg||''; render(); api.onAuthChange&&api.onAuthChange(); }
const who=()=>Auth.name();

// ══ HTTP (AuditRepository.kt 의 request) ══
class Unauthorized extends Error{ constructor(){ super('로그인이 만료되었습니다. 다시 로그인해 주세요.'); } }
class TableMissing extends Error{}
const enc=v=>encodeURIComponent(v);
const quoted=v=>'"'+String(v).replace(/"/g,'').replace(/\\/g,'')+'"';
const inList=vals=>enc('('+vals.map(quoted).join(',')+')');
const chunk=(a,n)=>{ const o=[]; for(let i=0;i<a.length;i+=n) o.push(a.slice(i,i+n)); return o; };
const txt=(o,k)=>(o&&o[k]!=null)?String(o[k]):'';
const int=(o,k,d=0)=>{ const v=o&&o[k]; const n=parseInt(v,10); return isNaN(n)?d:n; };

async function request(url,method,body,prefer='return=minimal'){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),15000);
  let res,text;
  try{
    res=await fetch(url,{method,signal:ctrl.signal,cache:'no-store',headers:{
      apikey:SB_KEY,Authorization:'Bearer '+Auth.token(),'Content-Type':'application/json',Accept:'application/json',Prefer:prefer},
      body:body==null?undefined:body});
    text=await res.text();
  }catch(e){ throw new Error('인터넷 연결을 확인해 주세요.'); }
  finally{ clearTimeout(t); }
  if(res.status===401) throw new Unauthorized();
  if(res.status===404||text.includes('PGRST205')||text.includes('42P01')) throw new TableMissing(text);
  if(!res.ok){ let m=''; try{ m=JSON.parse(text).message||''; }catch(e){} throw new Error(m||`Supabase 요청 실패 (${res.status})`); }
  return text||'[]';
}
const send=(path,method,body,prefer)=>request(`${SB_URL}/rest/v1/${path}`,method,body,prefer);
const getArray=async path=>{ const a=JSON.parse(await send(path,'GET',null)); return Array.isArray(a)?a:[]; };

const toBox=o=>({id:String(o.id),boxCode:normCode(txt(o,'box_code')),barcode:txt(o,'barcode'),name:txt(o,'product_name'),
  stock:int(o,'qty'),location:txt(o,'location'),position:txt(o,'position'),optionName:txt(o,'option_name')});

const Repo={
  // ── 적재존: 그 위치에 있어야 할 박스 ──
  async boxesAt(position){
    const p=normPos(position);
    const rows=await getArray(`jaeja?select=${BOX_COLUMNS}&position=ilike.${enc(p.replace(/\*/g,''))}&limit=2000`);
    return rows.filter(r=>normPos(txt(r,'position'))===p).map(toBox);
  },
  async boxesByCodes(codes){
    const out=new Map();
    const list=[...new Set([...codes].map(normCode).filter(Boolean))];
    for(const c of chunk(list,80)){
      (await getArray(`jaeja?select=${BOX_COLUMNS}&box_code=in.${inList(c)}`)).forEach(o=>{ const b=toBox(o); if(b.boxCode&&!out.has(b.boxCode)) out.set(b.boxCode,b); });
    }
    return out;
  },
  // 유령 확정 — 잠금을 쥔 채로 ① 서버에서 지금 위치를 다시 읽어 아직 그 자리에 있는 박스만 ② 위치 '유령-원래위치' ③ loc_log ④ ghost_stock
  async markGhost(position,remaining,me){
    const p=normPos(position);
    let done=null;
    const result=await withLock('위치변경',me,async()=>{
      const live=await this.boxesByCodes(remaining.map(b=>b.boxCode));
      const gone=remaining.filter(c=>!live.get(normCode(c.boxCode))).length;
      const moved=[], targets=[];
      remaining.forEach(card=>{
        const jr=live.get(normCode(card.boxCode)); if(!jr) return;
        if(normPos(jr.position)!==p){ moved.push(`${jr.boxCode} → ${jr.position||'(없음)'}`); return; }
        targets.push(jr);
      });
      if(!targets.length) return {marked:[],gone,moved,at:''};
      const at=nowKo();
      const moveMap={}; targets.forEach(t=>{ moveMap[t.boxCode]=GHOST_PREFIX+t.position; });
      const byPos={}; Object.entries(moveMap).forEach(([code,np])=>{ (byPos[np]=byPos[np]||[]).push(code); });
      for(const [np,codes] of Object.entries(byPos))
        for(const c of chunk(codes,50)) await send(`jaeja?box_code=in.${inList(c)}`,'PATCH',JSON.stringify({position:np}));
      const logs=targets.map(t=>({box_code:t.boxCode,barcode:t.barcode,product_name:t.name,option_name:t.optionName,old_position:t.position,new_position:moveMap[t.boxCode],worked_at:at}));
      const ghosts=targets.map(t=>({box_code:t.boxCode,barcode:t.barcode,product_name:t.name,option_name:t.optionName,qty:t.stock,origin_position:t.position,
        ghost_position:moveMap[t.boxCode],checked_loc:p,marked_at:at,marked_by:me}));
      await send('loc_log','POST',JSON.stringify(logs));
      await send('ghost_stock','POST',JSON.stringify(ghosts));
      const r={marked:targets.map(t=>t.boxCode),gone,moved,at};
      done={r,moveMap};
      return r;
    });
    if(result==null) throw new Error(`다른 사람이 작업 중입니다(${lastLockOwner||'작업 잠금'}). 잠시 뒤 다시 시도하세요.`);
    // 켜져 있는 5F 웹 화면에 알린다 — 알림일 뿐이라 잠금을 푼 뒤에. 실패해도 저장은 끝났다
    if(done&&done.r.marked.length){
      const set=new Set(done.r.marked);
      broadcastMove(done.moveMap,remaining.filter(c=>set.has(c.boxCode)).map(c=>Object.assign({},c,{position:p})),done.r.at).catch(()=>{});
    }
    return result;
  },

  // ── 로케이션: 그 자리(또는 앞자리) 상품과 로케재고 ──
  async locationItems(location){
    const loc=normPos(location).replace(/\*/g,'');
    let rows=(await getArray(`jaeja_db?select=${DB_COLUMNS}&location=ilike.${enc(loc)}&limit=1000`)).filter(r=>normPos(txt(r,'location'))===loc);
    let prefix=false;
    if(!rows.length){
      rows=(await getArray(`jaeja_db?select=${DB_COLUMNS}&location=ilike.${enc(loc+'-*')}&order=location&limit=1000`)).filter(r=>normPos(txt(r,'location')).startsWith(loc+'-'));
      prefix=rows.length>0;
    }
    if(!rows.length) return {scope:loc,prefix:false,items:[],product:await this.findProduct(loc)};
    const seen=new Set(), items=[];
    rows.forEach(r=>{
      const bc=normCode(txt(r,'barcode')), pc=normCode(txt(r,'product_code')), key=bc||pc;
      if(!key||seen.has(key)) return; seen.add(key);
      items.push({key,barcode:bc,code:pc||bc,name:txt(r,'product_name'),option:txt(r,'option'),location:normPos(txt(r,'location')),stock:int(r,'stock'),jaeja:0,expected:0,counted:null,extra:false});
    });
    // 적재존(jaeja)에 올라가 있는 수량 — 유령재고는 실물이 없으니 빼지 않는다 (5F 로케재고와 같은 기준)
    const jsum=new Map();
    const codes=[...new Set(items.flatMap(i=>[i.barcode,i.code]).filter(Boolean))];
    for(const c of chunk(codes,80)){
      (await getArray(`jaeja?select=barcode,qty,position&barcode=in.${inList(c)}`)).forEach(o=>{
        if(txt(o,'position').startsWith(GHOST_PREFIX)) return;
        const k=normCode(txt(o,'barcode')); jsum.set(k,(jsum.get(k)||0)+int(o,'qty'));
      });
    }
    items.forEach(i=>{ i.jaeja=(jsum.get(i.barcode)||0)+(i.code!==i.barcode?(jsum.get(i.code)||0):0); i.expected=Math.max(0,i.stock-i.jaeja); });
    // 이 자리를 전에 저장한 적이 있는지 (안내만)
    let prev=null; try{ prev=(await getArray(`${RESULT_TABLE}?select=saved_at,worker_name&scope=eq.${enc(loc)}&order=id.desc&limit=1`))[0]||null; }catch(e){}
    return {scope:loc,prefix,items,prevSavedAt:txt(prev,'saved_at'),prevWorker:txt(prev,'worker_name')};
  },
  async findProduct(code){
    const q=quoted(normCode(code));
    const it=(await getArray(`jaeja_db?select=${DB_COLUMNS}&or=${enc(`(barcode.eq.${q},product_code.eq.${q})`)}&limit=1`))[0];
    return it?{barcode:normCode(txt(it,'barcode')),code:normCode(txt(it,'product_code')),name:txt(it,'product_name'),option:txt(it,'option'),location:normPos(txt(it,'location'))}:null;
  },
  async saveLocation(payload){
    // 같은 실사(client_id)를 다시 보내면 그 줄을 고친다 — 저장 재시도가 겹쳐도 한 줄
    try{ await send(`${RESULT_TABLE}?on_conflict=client_id`,'POST',JSON.stringify([payload]),'resolution=merge-duplicates,return=minimal'); }
    catch(e){ if(e instanceof TableMissing) throw new Error('결과 저장 표(loc_audit_result)가 아직 없습니다. 5F SQL(2026-11-19_앱_로케이션실사)을 먼저 실행해 주세요.'); throw e; }
  },
  async savedList(){
    try{
      const rows=await getArray(`${RESULT_TABLE}?select=id,scope,saved_at,worker_name,total,ok_cnt,short_cnt,over_cnt,missing_cnt,extra_cnt,items,errors&order=id.desc&limit=40`);
      return rows.map(o=>{
        const items=Array.isArray(o.items)?o.items:[];
        return {id:+o.id,scope:txt(o,'scope'),savedAt:txt(o,'saved_at'),worker:txt(o,'worker_name'),total:int(o,'total'),ok:int(o,'ok_cnt'),
          short:int(o,'short_cnt'),over:int(o,'over_cnt'),missing:int(o,'missing_cnt'),extra:int(o,'extra_cnt'),
          diffs:items.filter(i=>!['ok','zero'].includes(txt(i,'st'))).map(i=>({name:txt(i,'name')||txt(i,'bc'),option:txt(i,'opt'),barcode:txt(i,'bc'),status:txt(i,'st'),
            expected:i.exp==null?null:int(i,'exp'),counted:i.cnt==null?null:int(i,'cnt')})),
          // 이어서 세기용 — counted 가 없는 옛 기록은 센 것으로 본다
          items:items.map(i=>({barcode:normCode(txt(i,'bc')),code:normCode(txt(i,'code')),name:txt(i,'name'),option:txt(i,'opt'),location:normPos(txt(i,'loc')),
            count:int(i,'cnt'),counted:i.counted==null?true:!!i.counted,extra:!!i.extra||txt(i,'st')==='extra'})),
          errors:(Array.isArray(o.errors)?o.errors:[]).map(e=>({reason:txt(e,'reason'),code:txt(e,'code'),name:txt(e,'name'),option:txt(e,'opt'),where:txt(e,'loc'),qty:0,n:Math.max(1,int(e,'n',1)),at:'',checked:!!e.checked})),
        };
      });
    }catch(e){ if(e instanceof TableMissing) throw new Error('결과 저장 표(loc_audit_result)가 아직 없습니다. 5F SQL 을 먼저 실행해 주세요.'); throw e; }
  },
  // 현황판 — 표가 아직 없으면 조용히 넘긴다 (실사 자체는 막지 않는다)
  async upsertQuiet(path,row){ try{ await send(path,'POST',JSON.stringify([row]),'resolution=merge-duplicates,return=minimal'); return true; }catch(e){ if(e instanceof TableMissing) return false; throw e; } },
  async deleteQuiet(path){ try{ await send(path,'DELETE',null); }catch(e){ if(!(e instanceof TableMissing)) throw e; } },
  pushGhostLive(row){ return this.upsertQuiet('ghost_audit_live?on_conflict=device',row); },
  deleteGhostLive(){ return this.deleteQuiet(`ghost_audit_live?device=eq.${enc(DEVICE)}`); },
  pushLocLive(row){ return this.upsertQuiet('loc_audit_live?on_conflict=device',row); },
  deleteLocLive(){ return this.deleteQuiet(`loc_audit_live?device=eq.${enc(DEVICE)}`); },
  saveGhostResult(row){ return this.upsertQuiet('ghost_audit_result?on_conflict=client_id',row); },

  // ── 작업자 이름 (기기마다 하나, 중복 금지) ──
  async claimWorkerName(name){
    try{
      const cur=(await getArray(`app_worker?select=device,seen_at&worker_name=eq.${enc(name)}`))[0];
      const staleIso=new Date(Date.now()-WORKER_STALE_DAYS*86400000).toISOString();
      if(cur&&txt(cur,'device')!==DEVICE){
        const seen=new Date(txt(cur,'seen_at'));
        const stale=!isNaN(seen)&&seen.toISOString()<staleIso;
        if(!stale) return 'TAKEN';
        await send(`app_worker?worker_name=eq.${enc(name)}&device=eq.${enc(txt(cur,'device'))}&seen_at=lt.${enc(staleIso)}`,'DELETE',null);
      }
      if(cur&&txt(cur,'device')===DEVICE){ await send(`app_worker?worker_name=eq.${enc(name)}`,'PATCH',JSON.stringify({device:DEVICE})); return 'OK'; }
      await send(`app_worker?device=eq.${enc(DEVICE)}`,'DELETE',null);   // 이 기기의 예전 이름 풀기
      try{ await send('app_worker','POST',JSON.stringify([{worker_name:name,device:DEVICE}])); return 'OK'; }
      catch(e){ if(/duplicate|23505/.test(e.message||'')) return 'TAKEN'; throw e; }   // 같은 순간 다른 기기가 먼저 잡음
    }catch(e){ if(e instanceof TableMissing) return 'NO_TABLE'; throw e; }
  },
  touchWorkerName(name){ return send(`app_worker?worker_name=eq.${enc(name)}&device=eq.${enc(DEVICE)}`,'PATCH',JSON.stringify({device:DEVICE})).catch(()=>{}); },
};

// ── 작업 잠금 (5F 웹 withLock 과 같은 행·같은 규칙) ──
let lastLockOwner='';
async function withLock(operation,me,block){
  const myId=`${(me||'').replace(/[_\s]/g,'')||'웹'}_${Date.now()}_${Math.floor(Math.random()*1e8).toString(36)}`;
  // 기다리는 동안 짧게 자주 다시 묻는다 — 앞사람이 끝나자마자 이어받게
  const started=Date.now(); let wait=300;
  while(!(await tryLock(myId,operation))){
    if(Date.now()-started>LOCK_WAIT_MAX_MS) return null;
    await sleep(wait+Math.random()*300); wait=Math.min(wait*1.3,1200);
  }
  // 오래 걸려도 남이 뺏어 가지 않게 5초마다 시각을 갱신한다
  const beat=setInterval(()=>{ send(`op_lock?id=eq.${LOCK_ID}&locked_by=eq.${enc(myId)}`,'PATCH',JSON.stringify({locked_at:new Date().toISOString()})).catch(()=>{}); },5000);
  try{ return await block(); }
  finally{
    clearInterval(beat);
    await send(`op_lock?id=eq.${LOCK_ID}&locked_by=eq.${enc(myId)}`,'PATCH',JSON.stringify({locked_by:null,locked_at:null,operation:null})).catch(()=>{});
  }
}
async function tryLock(myId,operation){
  const expiry=new Date(Date.now()-LOCK_TIMEOUT_MS).toISOString();
  const filter=`id=eq.${LOCK_ID}&or=${enc(`(locked_by.is.null,locked_at.is.null,locked_at.lt.${expiry})`)}`;
  let got=null;
  try{ got=JSON.parse(await send(`op_lock?${filter}`,'PATCH',JSON.stringify({locked_by:myId,locked_at:new Date().toISOString(),operation}),'return=representation')); }
  catch(e){ if(e instanceof Unauthorized) throw e; return false; }
  if(Array.isArray(got)&&got.length&&got[0].locked_by===myId) return true;
  try{ const cur=(await getArray(`op_lock?id=eq.${LOCK_ID}&select=locked_by,operation`))[0]; lastLockOwner=cur?`${txt(cur,'locked_by').split('_')[0]} · ${txt(cur,'operation')}`:''; }catch(e){ lastLockOwner=''; }
  return false;
}
async function broadcastMove(moveMap,targets,at){
  const logRows=targets.map(t=>({'박스코드':t.boxCode,'바코드':t.barcode,'상품명':t.name,'옵션명':t.optionName,'기존위치':t.position,'변경위치':moveMap[t.boxCode],'작업시간':at}));
  const message={topic:'jaeja_broadcast',event:'jaeja_changed',payload:{type:'위치변경',moveMap,logRows}};
  await request(`${SB_URL}/realtime/v1/api/broadcast`,'POST',JSON.stringify({messages:[message]}),'return=minimal');
}

// ══ 상태 (AuditController.kt) ══
const S={
  kind:'GHOST', busy:false, message:null, hi:null, lastKey:'',
  ghostPos:'', doneOpen:false, ghostCards:[], ghostScanned:[], ghostErrors:[], ghostTotal:0, ghostClientId:'', ghostOpenedAt:'',
  locScope:'', locPrefix:false, zeroOpen:false, locItems:[], locErrors:[], locPrev:'', locClientId:'', locOpenedAt:'',
  savedOpen:false, saved:[], workerName:ls.get('audit_worker_name'), workerBusy:false,
  // 화면 스타일 A(카드형+필터) / B(플로팅+빠른 액션) — 화면만 바뀌고 실사 데이터는 그대로. 마지막 선택을 기억, 처음은 A
  design:ls.get('audit_design','A')==='B'?'B':'A', filter:'all',
  voiceOn:ls.get('audit_voice_on','1')==='1', voiceName:ls.get('audit_voice_name',VOICE_CLIPS), voiceRate:parseFloat(ls.get('audit_voice_rate','1.1'))||1.1,
};
let api={}; let liveTimer=null, locLiveTimer=null;
const me=()=>S.workerName||who();
const isOpen=()=>S.kind==='GHOST'?!!S.ghostPos:!!S.locScope;
const ghostRemain=()=>{ const s=new Set(S.ghostScanned); return S.ghostCards.filter(c=>!s.has(c.boxCode)); };
const ghostDone=()=>{ const cards=new Set(S.ghostCards.map(c=>c.boxCode)); return S.ghostScanned.filter(s=>cards.has(s)).length; };

function finalStatus(i){ if(i.extra) return 'extra'; const c=i.counted||0; return c===i.expected?'ok':c===0?'missing':c<i.expected?'short':'over'; }
function status(i){ return (!i.extra&&i.counted==null)?(i.expected===0?'zero':'wait'):finalStatus(i); }

function ready(){ if(ensureSession()) return true; render(); api.onAuthChange&&api.onAuthChange(); return false; }
function fail(e,fallback){
  if(e instanceof Unauthorized){ logout(e.message); }
  return (e&&e.message)||fallback;
}
function say(text,err,hi=null){ S.message={text,err}; S.hi=hi; }

// ── 작업자 이름 ──
async function registerWorker(raw){
  const name=String(raw||'').trim().replace(/\s+/g,' ');
  if(name.length<2) return '이름을 2글자 이상 적어 주세요.';
  if(name.length>12) return '이름은 12글자까지입니다.';
  if(name.toLowerCase()===who().toLowerCase()) return `공용 계정 이름(${name})은 쓸 수 없습니다. 본인 이름을 적어 주세요.`;
  if(!ready()) return '로그인 후 등록할 수 있습니다.';
  S.workerBusy=true; render();
  try{
    const r=await Repo.claimWorkerName(name);
    if(r==='TAKEN') return `'${name}' 은(는) 이미 다른 기기에서 쓰는 이름입니다. 다른 이름(예: ${name} 2)을 적어 주세요.`;
    S.workerName=name; ls.set('audit_worker_name',name);   // NO_TABLE 이면 기기에만 저장하고 쓴다
    if(S.ghostPos) pushLive(); if(S.locScope) pushLocLive();
    return null;
  }catch(e){ return fail(e,'이름을 등록하지 못했습니다.'); }
  finally{ S.workerBusy=false; render(); }
}
function touchWorker(){ if(S.workerName&&Auth.valid()) Repo.touchWorkerName(S.workerName); }

// ── 입력 흐름 ──
function onCode(raw){
  const code=String(raw||'').trim();
  if(!code) return;
  if(!isOpen()){ open(code); return; }
  // 자리를 연 뒤에도 카메라가 그 위치 라벨을 계속 읽는다 — 지금 자리 라벨은 조용히 넘긴다
  const current=S.kind==='GHOST'?S.ghostPos:S.locScope;
  if(normPos(code)===current) return;
  if(S.kind==='GHOST') scanGhost(code); else scanLocation(code);
}

async function open(raw){
  const target=normPos(raw);
  if(!target){ say('위치를 입력하거나 스캔해 주세요.',true); render(); return; }
  if(hasHangul(target)){ tone('ERROR'); talk('한영 키 오류'); say(`한/영 키가 한글입니다 — 영문으로 바꾸고 다시 찍어 주세요. (${target})`,true); render(); return; }
  if(S.busy||!ready()) return;
  S.busy=true; S.message=null; render();
  try{ if(S.kind==='GHOST') await openGhost(target); else await openLocation(target); }
  finally{ S.busy=false; render(); }
}

function close(k=S.kind){
  if(k==='GHOST'){ if(S.ghostPos) endLive(); Object.assign(S,{ghostPos:'',ghostCards:[],ghostScanned:[],ghostErrors:[],ghostTotal:0,ghostClientId:''}); }
  else{ if(S.locScope) endLocLive(); Object.assign(S,{locScope:'',locItems:[],locErrors:[],locPrev:'',locClientId:''}); }
  S.lastKey=''; S.message=null; S.hi=null; persist();
}

// ══ 적재존 실사 (남은 박스 = 유령재고) ══
async function openGhost(pos){
  if(pos.startsWith(GHOST_PREFIX)){ say("'유령-' 위치는 실사 대상이 아닙니다.",true); return; }
  try{
    const boxes=await Repo.boxesAt(pos);
    if(!boxes.length){ tone('ERROR'); talk('박스 없는 위치'); say(`${pos} 위치에 적재된 박스가 없습니다 (적재현황 기준). 위치를 다시 확인해 주세요.`,true); return; }
    boxes.sort((a,b)=>a.boxCode<b.boxCode?-1:a.boxCode>b.boxCode?1:0);
    Object.assign(S,{ghostPos:pos,ghostCards:boxes,ghostScanned:[],ghostErrors:[],lastKey:'',doneOpen:false,ghostTotal:boxes.length,ghostClientId:uuid(),ghostOpenedAt:new Date().toISOString()});
    say(`${pos} · 박스 ${boxes.length}개 — 하나씩 찍어 주세요. 끝까지 안 찍힌 박스가 유령재고입니다.`,false);
    talk(`박스 ${boxes.length}개`);
    persist(); pushLive();
  }catch(e){ say(fail(e,'적재현황을 불러오지 못했습니다.'),true); }
}

function scanGhost(raw){
  if(hasHangul(raw)){ tone('ERROR'); talk('한영 키 오류'); addGhostError({reason:'hangul',code:raw}); say('한/영 키가 한글입니다 — 영문으로 바꾸고 다시 찍어 주세요.',true); render(); return; }
  // 통합바코드(박스코드+바코드+수량)면 앞의 박스코드만 쓴다 — 5F parseUnifiedBarcode 와 같은 규칙
  const parts=raw.trim().toUpperCase().split('+');
  const box=normCode(parts.length>=2?parts[0]:raw);
  if(!box) return;
  const card=S.ghostCards.find(c=>c.boxCode===box);
  if(card){
    S.lastKey=box;
    const hi={place:card.position,code:card.barcode,qty:`${card.stock}개`};
    if(S.ghostScanned.includes(box)){ tone('DUP'); talk('이미 확인한 박스'); say(`${box} · 이미 확인한 박스입니다.`,false,hi); render(); return; }
    S.ghostScanned.push(box); tone('OK');
    const left=S.ghostCards.length-ghostDone();
    talk(left===0?'전부 확인':`확인, 남은 ${left}`);
    say(`확인 ${S.ghostScanned.length} / ${S.ghostCards.length} · 박스 ${box} · ${card.name||'-'}`,false,hi);
    persist(); scheduleLive(); render(); return;
  }
  // 이 자리 카드에 없는 박스 — 다른 위치 박스인지, 적재현황에 아예 없는지 서버에서 본다
  tone('ERROR');
  if(!ready()) return;
  Repo.boxesByCodes([box]).then(m=>{
    const jr=m.get(box);
    addGhostError(jr?{reason:'other',code:box,name:jr.name,option:jr.optionName,where:jr.position||'(없음)',qty:jr.stock}:{reason:'none',code:box});
    talk(jr?'다른 위치 박스':'적재현황에 없는 박스');
    say(jr?`${box} · 다른 위치(${jr.position||'없음'}) 박스입니다.`:`${box} · 적재현황에 없는 박스입니다.`,true,
      jr?{place:jr.position||'위치 없음',code:jr.barcode,qty:`${jr.stock}개`}:{place:'적재현황 없음',code:box,qty:''});
  }).catch(e=>{ addGhostError({reason:'none',code:box,where:'조회 실패'}); talk('조회 실패, 다시 찍어 주세요'); say(fail(e,'박스 조회에 실패했습니다.'),true); })
    .finally(render);
}
function addGhostError(e){ addError(S.ghostErrors,e); scheduleLive(); }

async function confirmGhost(){
  const remain=ghostRemain();
  if(!remain.length||S.busy||blockIfUnchecked()||!ready()) return;
  const pos=S.ghostPos;
  S.busy=true; say(`유령재고 처리 중… (${remain.length}건)`,false); render();
  try{
    const r=await Repo.markGhost(pos,remain,me());
    const set=new Set(r.marked);
    const extra=[r.gone>0?`이미 출고됨 ${r.gone}건`:'',r.moved.length?`다른 위치로 옮겨짐 ${r.moved.length}건`:''].filter(Boolean).join(', ');
    recordGhostResult(remain.filter(c=>set.has(c.boxCode)),r.gone,r.moved.length);
    close('GHOST');
    talk(r.marked.length?`유령 ${r.marked.length}건 확정`:'유령 처리할 박스 없음');
    if(!r.marked.length) say(`${pos} · 유령 처리할 박스가 없습니다${extra?` (${extra})`:''}.`,true);
    else say(`${pos} · 유령재고 ${r.marked.length}건 확정 — 위치를 '${GHOST_PREFIX}${pos}' 로 바꿨습니다${extra?` (${extra} 제외)`:''}. 실물을 찾으면 5F 웹 › 적재존 › 유령재고 리스트에서 복구하세요.`,false);
  }catch(e){ talk('처리 실패'); say(fail(e,'유령재고 처리에 실패했습니다. 카드는 그대로 남아 있습니다.'),true); }
  finally{ S.busy=false; render(); }
}

function finishGhost(){
  if(!S.ghostPos||ghostRemain().length||S.busy||blockIfUnchecked()) return;
  const pos=S.ghostPos;
  recordGhostResult([],0,0);
  close('GHOST');
  say(`${pos} · 박스를 전부 확인했습니다 (유령 없음). 다음 자리를 찍어 주세요.`,false);
  talk('이 자리 완료'); render();
}

const boxJson=p=>({box:p.boxCode,bc:p.barcode,name:p.name,opt:p.optionName,qty:p.stock,loc:p.location});
const errorsJson=list=>list.map(e=>({reason:e.reason,code:e.code,name:e.name||'',opt:e.option||'',where:e.where||'',qty:e.qty||0,n:e.n||1,at:e.at||'',checked:!!e.checked}));

// 자리 하나를 끝낸 기록 — 현황판의 '오늘 실사한 자리'. 실패해도 실사 결과(위치 변경)는 이미 끝났다
function recordGhostResult(ghosts,gone,moved){
  const row={client_id:S.ghostClientId||uuid(),position:S.ghostPos,audit_date:kstDate(),worker_name:me(),device:DEVICE,
    total:S.ghostTotal>0?S.ghostTotal:S.ghostCards.length,found:ghostDone(),ghost_cnt:ghosts.length,gone_cnt:gone,moved_cnt:moved,err_cnt:S.ghostErrors.length,
    ghosts:ghosts.map(boxJson),errors:errorsJson(S.ghostErrors)};
  Repo.saveGhostResult(row).catch(()=>{});
}

function scheduleLive(){ clearTimeout(liveTimer); liveTimer=setTimeout(pushLive,LIVE_DEBOUNCE_MS); }
function pushLive(){
  if(!S.ghostPos||!Auth.valid()) return;
  const row={device:DEVICE,worker_name:me(),position:S.ghostPos,total:S.ghostCards.length,done:ghostDone(),
    remain:ghostRemain().map(boxJson),errors:errorsJson(S.ghostErrors.slice(0,50)),opened_at:S.ghostOpenedAt||null};
  Repo.pushGhostLive(row).catch(()=>{});
}
function endLive(){ clearTimeout(liveTimer); if(Auth.valid()) Repo.deleteGhostLive().catch(()=>{}); }

// ══ 로케이션 실사 ══
async function openLocation(loc){
  try{
    const s=await Repo.locationItems(loc);
    if(!s.items.length){
      tone('ERROR');
      talk(s.product?'상품 바코드입니다':'없는 로케이션');
      say(s.product?`상품 바코드입니다 — 로케이션 라벨을 먼저 찍어 주세요. (이 상품 로케이션: ${s.product.location||'미지정'})`:`${loc} · 상품DB에 이 로케이션(또는 ${loc}-…)이 없습니다.`,true);
      return;
    }
    Object.assign(S,{locScope:s.scope,locPrefix:s.prefix,locItems:sortItems(s.items),locErrors:[],lastKey:'',zeroOpen:false,locClientId:uuid(),locOpenedAt:new Date().toISOString(),
      locPrev:s.prevSavedAt?`이 자리는 ${shortTime(s.prevSavedAt)} 에 ${s.prevWorker||'누군가'} 님이 이미 저장했습니다.`:''});
    talk(`상품 ${s.items.length}개`);
    pushLocLive();
    say(`${s.scope}${s.prefix?` (앞자리 ${new Set(s.items.map(i=>i.location)).size}칸)`:''} · 상품 ${s.items.length}개 — 상품을 찍을 때마다 1개씩 셉니다.`,false);
    persist();
  }catch(e){ say(fail(e,'로케이션을 불러오지 못했습니다.'),true); }
}
const sortItems=items=>items.slice().sort((a,b)=>a.location<b.location?-1:a.location>b.location?1:a.name<b.name?-1:a.name>b.name?1:0);

function countSay(it,n){
  const tag=it.extra?'위치다름':n>it.expected?`초과 +${n-it.expected}`:n===it.expected?'일치':`세는 중 ${n} / ${it.expected}`;
  say(`${it.name||it.code}${!it.extra?` · 로케재고 ${it.expected}`:' · 위치다름'}`,false,
    {place:it.location||'로케 없음',code:it.barcode||it.code,qty:`${n}개`,state:status(it),tag});
}
function countTalk(it,n){ talk(it.extra?`위치다름 ${n}개`:n>it.expected?`${n}개, 초과`:`${n}개`); }

function scanLocation(raw){
  if(hasHangul(raw)){ tone('ERROR'); talk('한영 키 오류'); addError(S.locErrors,{reason:'hangul',code:raw}); say('한/영 키가 한글입니다 — 영문으로 바꾸고 다시 찍어 주세요.',true); render(); return; }
  const parts=raw.trim().toUpperCase().split('+');
  const code=normCode(parts.length>=2?parts[1]:raw);
  if(!code) return;
  const it=S.locItems.find(i=>i.barcode===code||i.code===code);
  if(it){
    it.counted=(it.counted||0)+1; S.lastKey=it.key; tone('OK');
    countTalk(it,it.counted); scheduleLocLive(); countSay(it,it.counted);
    persist(); render(); return;
  }
  tone('ERROR');
  if(!ready()) return;
  Repo.findProduct(code).then(p=>{
    const e=!p?{reason:'none',code}:!p.location?{reason:'noloc',code,name:p.name,option:p.option}:{reason:'other',code,name:p.name,option:p.option,where:p.location};
    addError(S.locErrors,e); scheduleLocLive();
    talk({none:'미등록 상품',noloc:'로케이션 없는 상품'}[e.reason]||'다른 로케이션 상품');
    say(e.reason==='none'?`${code} · 상품DB에 없는 바코드입니다.`:e.reason==='noloc'?`${e.name} · 로케이션이 지정되지 않은 상품입니다.`:`${e.name} · 다른 로케이션(${e.where}) 상품입니다.`,true,
      {place:e.reason==='none'?'DB 없음':e.reason==='noloc'?'로케 없음':e.where,code,qty:''});
  }).catch(err=>{ addError(S.locErrors,{reason:'none',code,where:'조회 실패'}); talk('조회 실패, 다시 찍어 주세요'); say(fail(err,'상품 조회에 실패했습니다.'),true); })
    .finally(render);
}

function setCount(key,count){
  const it=S.locItems.find(i=>i.key===key); if(!it) return;
  it.counted=count==null?null:Math.max(0,count); S.lastKey=key; persist();
  if(count!=null){ countTalk(it,it.counted); countSay(it,it.counted); }
  else say(`${it.name||it.code} · 안 센 것으로 되돌림`,false,{place:it.location||'로케 없음',code:it.barcode||it.code,qty:'-',state:status(it),tag:'미확인'});
  scheduleLocLive(); render();
}
function removeExtra(key){ S.locItems=S.locItems.filter(i=>!(i.key===key&&i.extra)); persist(); scheduleLocLive(); render(); }
function errorToItem(e){
  S.locErrors=S.locErrors.filter(x=>x!==e);
  afterResolve(e.code);
  if(!S.locItems.some(i=>i.key===e.code)){
    S.locItems.unshift({key:e.code,barcode:e.code,code:e.code,name:e.name||'',option:e.option||'',location:e.where||'',stock:0,jaeja:0,expected:0,counted:e.n||1,extra:true});
    S.lastKey=e.code; scheduleLocLive();
  }
  persist(); render();
}
function checkError(e,on){
  e.checked=!!on;
  if(on) afterResolve(e.code);
  if(S.kind==='GHOST') scheduleLive(); else scheduleLocLive();
  persist(); render();
}
const blockText=n=>`확인이 필요한 스캔 ${n}건을 먼저 처리해 주세요. (${S.kind==='GHOST'?'확인함':'여기 있음 · 확인함'})`;
// 오류를 처리하면 맨 아래 빨간 띠를 맞춘다 — '먼저 처리해 주세요'는 남은 건수로 줄이고 다 끝나면 지운다,
// 방금 찍은 그 오류의 띠면 지운다 (창에서 처리해도 띠에 빨갛게 남아 있던 문제)
function afterResolve(code){
  const m=S.message; if(!m||!m.err) return;
  if(m.block){ const n=unchecked(curErrors()).length; if(n) m.text=blockText(n); else { S.message=null; S.hi=null; } }
  else if(S.hi&&S.hi.code===code){ S.message=null; S.hi=null; }
}
// 확인이 끝나지 않은 오류 스캔 — 남아 있으면 저장·유령 확정·이 자리 완료를 막는다
const curErrors=()=>S.kind==='GHOST'?S.ghostErrors:S.locErrors;
const unchecked=list=>list.filter(e=>!e.checked);
function blockIfUnchecked(){
  const n=unchecked(curErrors()).length;
  if(!n) return false;
  tone('ERROR');
  say(blockText(n),true); S.message.block=true;
  errorsDialog(true); render();
  return true;
}

function scheduleLocLive(){ clearTimeout(locLiveTimer); locLiveTimer=setTimeout(pushLocLive,LIVE_DEBOUNCE_MS); }
function pushLocLive(){
  if(!S.locScope||!Auth.valid()) return;
  const items=S.locItems;
  const row={device:DEVICE,worker_name:me(),scope:S.locScope,total:items.length,done:items.filter(i=>i.counted!=null||i.extra).length,
    diff:items.filter(i=>i.counted!=null&&!['ok','zero'].includes(status(i))).length,
    items:items.map(i=>({bc:i.barcode,name:i.name,opt:i.option,loc:i.location,exp:i.extra?null:i.expected,cnt:i.counted==null?null:i.counted,st:status(i)})),
    errors:errorsJson(S.locErrors.slice(0,50)),opened_at:S.locOpenedAt||null};
  Repo.pushLocLive(row).catch(()=>{});
}
function endLocLive(){ clearTimeout(locLiveTimer); if(Auth.valid()) Repo.deleteLocLive().catch(()=>{}); }

async function saveLocation(){
  if(!S.locItems.length||S.busy||blockIfUnchecked()||!ready()) return;
  const items=S.locItems.slice(), errors=S.locErrors.slice();
  const st=items.map(finalStatus); const cnt=k=>st.filter(x=>x===k).length;
  if(!S.locClientId) S.locClientId=uuid();
  const payload={client_id:S.locClientId,scope:S.locScope,audit_date:kstDate(),worker_name:me(),device:`웹-${model()}`,
    stock_src:'db',db_updated_at:api.dbUpdatedAt?api.dbUpdatedAt():'',opened_at:S.locOpenedAt,
    total:items.filter(i=>!i.extra).length,ok_cnt:cnt('ok'),short_cnt:cnt('short'),over_cnt:cnt('over'),missing_cnt:cnt('missing'),extra_cnt:cnt('extra'),
    err_cnt:errors.length,expected_qty:items.filter(i=>!i.extra).reduce((s,i)=>s+i.expected,0),counted_qty:items.reduce((s,i)=>s+(i.counted||0),0),
    items:items.map(i=>({bc:i.barcode,code:i.code,name:i.name,opt:i.option,loc:i.location,stock:i.stock,jaeja:i.jaeja,exp:i.extra?null:i.expected,
      cnt:i.counted||0,st:finalStatus(i),extra:i.extra,counted:i.counted!=null})),
    errors:errors.map(e=>({reason:e.reason,code:e.code,name:e.name||'',opt:e.option||'',loc:e.where||'',n:e.n||1,checked:!!e.checked}))};
  S.busy=true; render();
  try{
    await Repo.saveLocation(payload);
    const scopeName=S.locScope, diff=st.filter(x=>x!=='ok').length;
    close('LOCATION'); talk('저장 완료');
    say(`${scopeName} 실사를 저장했습니다 — 상품 ${items.length}개 중 차이 ${diff}건. 다음 로케이션을 찍어 주세요.`,false);
  }catch(e){ talk('저장 실패'); say(fail(e,'저장에 실패했습니다. 센 수량은 이 기기에 그대로 남아 있습니다.'),true); }
  finally{ S.busy=false; render(); }
}

// 저장본 이어서 세기 — 지금 상품DB 기준으로 다시 열고 센 수량·위치다름·오류 스캔을 되살린다. 다시 저장하면 새 기록(새 client_id)
async function resume(s){
  if(S.busy||!ready()) return;
  if(S.locScope){ say(`세는 중인 로케이션(${S.locScope})을 먼저 저장하거나 닫아 주세요.`,true); render(); return; }
  S.busy=true; S.message=null; render();
  try{
    const fresh=await Repo.locationItems(s.scope);
    if(!fresh.items.length){ tone('ERROR'); say(`${s.scope} · 지금 상품DB에 이 로케이션이 없어 이어서 셀 수 없습니다.`,true); return; }
    const byKey=new Map(s.items.filter(i=>!i.extra).map(i=>[i.barcode||i.code,i]));
    const merged=fresh.items.map(i=>{ const o=byKey.get(i.key); return (o&&o.counted)?Object.assign({},i,{counted:o.count}):i; });
    const keys=new Set(merged.map(i=>i.key));
    const extras=s.items.filter(i=>i.extra&&!keys.has(i.barcode||i.code)).map(i=>({key:i.barcode||i.code,barcode:i.barcode,code:i.code||i.barcode,name:i.name,option:i.option,location:i.location,stock:0,jaeja:0,expected:0,counted:i.count,extra:true}));
    const gone=s.items.filter(i=>!i.extra&&!keys.has(i.barcode||i.code)).length;
    const done=merged.filter(i=>i.counted!=null).length;
    Object.assign(S,{locScope:fresh.scope,locPrefix:fresh.prefix,locItems:extras.concat(sortItems(merged)),locErrors:s.errors.slice(),lastKey:'',zeroOpen:false,savedOpen:false,
      locClientId:uuid(),locOpenedAt:new Date().toISOString(),
      locPrev:`${shortTime(s.savedAt)} ${s.worker||'누군가'} 님 저장본을 이어서 셉니다 (센 ${done}/${merged.length}). 다시 저장하면 새 기록으로 남습니다.`+(gone>0?` 그 사이 상품DB에서 이 자리를 떠난 상품 ${gone}개는 뺐습니다.`:'')});
    talk(`이어서 세기, 남은 ${merged.length-done}`);
    pushLocLive();
    say(`${fresh.scope} · 이어서 세기 — 센 ${done} / ${merged.length}, 남은 ${merged.length-done}개.`,false);
    persist();
  }catch(e){ say(fail(e,'로케이션을 불러오지 못했습니다.'),true); }
  finally{ S.busy=false; render(); }
}

async function loadSaved(){
  if(!ready()) return;
  S.savedOpen=true; S.busy=true; render();
  try{ S.saved=await Repo.savedList(); if(!S.saved.length) say('저장된 로케이션 실사가 아직 없습니다.',false); }
  catch(e){ say(fail(e,'저장목록을 불러오지 못했습니다.'),true); }
  finally{ S.busy=false; render(); }
}

function addError(list,e){
  const now=kstHms();
  const hit=list.findIndex(x=>x.reason===e.reason&&x.code===e.code);
  // 같은 코드를 또 찍으면 다시 '확인 필요'로 (새로 생긴 일이다)
  const base=Object.assign({name:'',option:'',where:'',qty:0,n:1},e,{checked:false});
  if(hit>=0){ const old=list.splice(hit,1)[0]; list.unshift(Object.assign(base,{n:old.n+1,at:now})); }
  else list.unshift(Object.assign(base,{at:now}));
  if(list.length>300) list.length=300;
  persist();
}

function switchKind(k){ S.kind=k; S.message=null; S.hi=null; S.lastKey=''; S.savedOpen=false; persist(); render(); }

// ── 기기에 임시 저장 — 화면을 닫거나 13:10 로그아웃이 돼도 세던 실사가 남는다 ──
function persist(){
  ls.set(STATE_KEY,JSON.stringify({kind:S.kind,ghostPos:S.ghostPos,ghostCards:S.ghostCards,ghostScanned:S.ghostScanned,ghostErrors:S.ghostErrors,
    ghostTotal:S.ghostTotal,ghostClientId:S.ghostClientId,ghostOpenedAt:S.ghostOpenedAt,
    locScope:S.locScope,locPrefix:S.locPrefix,locClientId:S.locClientId,locOpenedAt:S.locOpenedAt,locPrev:S.locPrev,locItems:S.locItems,locErrors:S.locErrors}));
}
function restore(){
  try{
    const o=JSON.parse(ls.get(STATE_KEY,'')||'null'); if(!o) return;
    ['kind','ghostPos','ghostTotal','ghostClientId','ghostOpenedAt','locScope','locPrefix','locClientId','locOpenedAt','locPrev'].forEach(k=>{ if(o[k]!=null) S[k]=o[k]; });
    ['ghostCards','ghostScanned','ghostErrors','locItems','locErrors'].forEach(k=>{ if(Array.isArray(o[k])) S[k]=o[k]; });
    if(S.kind!=='GHOST'&&S.kind!=='LOCATION') S.kind='GHOST';
  }catch(e){}
}

// ══ 소리 · 음성 ══
// 카메라는 읽을 때마다 '삑' 한다(index.html). 여기서는 오류·중복만 따로 알린다
function tone(t){
  if(t==='OK') return;
  const ctx=api.audioCtx&&api.audioCtx(); if(!ctx||ctx.state!=='running') return;
  try{
    const g=ctx.createGain(); g.connect(ctx.destination);
    const at=ctx.currentTime+0.02;
    const notes=t==='ERROR'?[[440,0,.22],[330,.23,.22]]:[[1300,0,.09],[1300,.14,.09]];
    notes.forEach(([f,s,d])=>{ const o=ctx.createOscillator(); o.type=t==='ERROR'?'square':'sine'; o.frequency.value=f; o.connect(g); o.start(at+s); o.stop(at+s+d); });
    g.gain.setValueAtTime(t==='ERROR'?.18:.3,at);
  }catch(e){}
}

// 녹음 음성 (앱 ClipVoice.kt 와 같은 조각 규칙) — 녹음이 없는 말만 기기 음성(speechSynthesis)으로
const FIXED={'한영 키 오류':['v_hangul'],'박스 없는 위치':['v_no_box_here'],'이미 확인한 박스':['v_already_box'],'전부 확인':['v_all_checked'],
  '다른 위치 박스':['v_other_pos_box'],'적재현황에 없는 박스':['v_not_in_jaeja'],'조회 실패, 다시 찍어 주세요':['v_lookup_failed','v_scan_again'],
  '유령 처리할 박스 없음':['v_no_ghost'],'처리 실패':['v_process_failed'],'이 자리 완료':['v_place_done'],'상품 바코드입니다':['v_is_product'],
  '없는 로케이션':['v_bad_location'],'미등록 상품':['v_unregistered'],'로케이션 없는 상품':['v_no_location'],'다른 로케이션 상품':['v_other_location'],
  '저장 완료':['v_saved'],'저장 실패':['v_save_failed'],'음성 안내 켬':['v_voice_on']};
const PREFIX={'박스':'v_box','상품':'v_product','위치다름':'v_extra'};
const num=s=>{ const n=parseInt(s,10); return (n>=0&&n<=99&&String(n)===s)?`n_${n}`:null; };
function clipsFor(text){
  const t=String(text).trim();
  if(FIXED[t]) return FIXED[t];
  let m;
  if((m=t.match(/^(\d+)개, 초과$/))) return num(m[1])?[num(m[1]),'v_over']:null;
  if((m=t.match(/^(박스|상품|위치다름) (\d+)개$/))) return num(m[2])?[PREFIX[m[1]],num(m[2])]:null;
  if((m=t.match(/^(\d+)개$/))) return num(m[1])?[num(m[1])]:null;
  if((m=t.match(/^확인, 남은 (\d+)$/))) return num(m[1])?['v_checked','v_remain',num(m[1])]:null;
  if((m=t.match(/^유령 (\d+)건 확정$/))) return num(m[1])?['v_ghost_confirmed',num(m[1])]:null;
  return null;
}
const ALL_CLIPS=[...new Set(Object.values(FIXED).flat().concat(Object.values(PREFIX),['v_over','v_checked','v_remain','v_ghost_confirmed'],Array.from({length:100},(_,i)=>`n_${i}`)))];
const clipBuf=new Map(); let clipSources=[], speakGen=0, preloaded=false;
function loadClip(name){
  if(clipBuf.has(name)) return clipBuf.get(name);
  const ctx=api.audioCtx&&api.audioCtx(); if(!ctx) return Promise.reject(new Error('no audio'));
  const p=fetch(`voice/${name}.mp3`).then(r=>{ if(!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
    .then(b=>new Promise((ok,no)=>ctx.decodeAudioData(b,ok,no)));
  clipBuf.set(name,p); p.catch(()=>clipBuf.delete(name));
  return p;
}
function preloadClips(){
  if(preloaded||S.voiceName!==VOICE_CLIPS||!S.voiceOn) return;
  const ctx=api.audioCtx&&api.audioCtx(); if(!ctx) return;
  preloaded=true;
  (async()=>{ for(const n of ALL_CLIPS){ try{ await loadClip(n); }catch(e){} } })();
}
function stopVoice(){
  speakGen++;
  clipSources.forEach(s=>{ try{ s.stop(); }catch(e){} }); clipSources=[];
  try{ if(window.speechSynthesis) speechSynthesis.cancel(); }catch(e){}
}
async function speakClips(names,speed,my){
  const ctx=api.audioCtx&&api.audioCtx(); if(!ctx||ctx.state!=='running') return false;
  let bufs; try{ bufs=await Promise.all(names.map(loadClip)); }catch(e){ return false; }
  if(my!==speakGen) return true;
  let t=ctx.currentTime+0.02;
  bufs.forEach(b=>{ const s=ctx.createBufferSource(); s.buffer=b; s.playbackRate.value=speed; s.connect(ctx.destination); s.start(t); t+=b.duration/speed+0.06; clipSources.push(s); });
  return true;
}
function koVoices(){ try{ return (window.speechSynthesis?speechSynthesis.getVoices():[]).filter(v=>/^ko/i.test(v.lang)); }catch(e){ return []; } }
function speakTts(text,voiceName){
  if(!window.speechSynthesis) return;
  try{
    speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text); u.lang='ko-KR'; u.rate=Math.max(.5,Math.min(2,S.voiceRate/1.1));
    const vs=koVoices(); const v=vs.find(x=>x.name===voiceName)||vs.find(x=>x.localService)||vs[0]; if(v) u.voice=v;
    speechSynthesis.speak(u);
  }catch(e){}
}
async function speak(text,force){
  if(!S.voiceOn&&!force) return;
  stopVoice(); const my=speakGen;
  const names=S.voiceName===VOICE_CLIPS?clipsFor(text):null;
  // 녹음은 1.05배로 만들었다 — 말 빠르기 '보통'(1.1)일 때 그대로 나오게
  if(names&&await speakClips(names,S.voiceRate/1.1,my)) return;
  if(my===speakGen) speakTts(text,S.voiceName===VOICE_CLIPS?'':S.voiceName);
}
const talk=text=>{ if(S.voiceOn) speak(text); };
function toggleVoice(){ S.voiceOn=!S.voiceOn; ls.set('audit_voice_on',S.voiceOn?'1':'0'); if(S.voiceOn){ preloadClips(); talk('음성 안내 켬'); } render(); }

// ══ 화면 ══
const STATUS={ok:['일치','var(--a-ok)','var(--a-ok-soft)'],short:['부족','var(--a-short)','var(--a-short-soft)'],missing:['없음','var(--a-short)','var(--a-short-soft)'],
  over:['초과','var(--a-over)','var(--a-over-soft)'],extra:['위치다름','var(--a-blue)','var(--a-blue-soft)'],zero:['재고 0','var(--a-idle)','var(--a-idle-soft)']};
const stStyle=st=>STATUS[st]||['미확인','var(--a-navy)','var(--a-navy-soft)'];
const badge=(label,fg,bg)=>`<span class="badge" style="color:${fg};background:${bg};border-color:color-mix(in srgb, ${fg} 28%, transparent)">${esc(label)}</span>`;
const ERROR_LABEL={other:'다른 위치',noloc:'로케이션 미지정',none:'DB 없음',hangul:'한/영 오입력'};

let root, lastScrolledKey='';
function skeleton(){
  root=$('auditTab');
  root.innerHTML=`
  <section class="a-card a-accent" id="aLogin" hidden><div class="in">
    <div class="a-h1">재고실사 로그인</div>
    <p class="a-desc">5F 웹과 같은 사번·비밀번호로 로그인합니다.</p>
    <form id="aLoginForm" autocomplete="on" style="display:flex;flex-direction:column;gap:10px">
      <input class="a-field" id="aEmp" name="username" autocomplete="username" placeholder="사번" autocapitalize="characters" spellcheck="false">
      <input class="a-field" id="aPw" name="password" type="password" autocomplete="current-password" placeholder="비밀번호">
      <div class="a-err" id="aLoginMsg" hidden></div>
      <button class="a-btn full" id="aLoginBtn" type="submit">로그인</button>
    </form>
    <div class="a-note">매일 13:10에 자동 로그아웃됩니다(점심시간). 다시 로그인하면 그날 야간까지 유지됩니다.</div>
  </div></section>
  <section class="a-card a-accent" id="aReg" hidden><div class="in">
    <div class="a-h1">작업자 이름 등록</div>
    <p class="a-desc">이 기기를 쓰는 사람의 이름을 적어 주세요. 실사 기록과 5F 현황판에 이 이름으로 나옵니다.<br>다른 기기와 같은 이름은 쓸 수 없습니다.</p>
    <form id="aRegForm" style="display:flex;flex-direction:column;gap:10px">
      <input class="a-field" id="aRegName" maxlength="12" placeholder="작업자 이름 (예: 홍길동)">
      <div class="a-err" id="aRegMsg" hidden></div>
      <button class="a-btn full" id="aRegBtn" type="submit">등록</button>
    </form>
  </div></section>
  <div id="aMain" hidden style="display:flex;flex-direction:column;gap:10px">
    <div id="aTop" style="display:flex;flex-direction:column;gap:10px"></div>
    <div id="aCamSlot"></div>
    <div id="aMid" style="display:flex;flex-direction:column;gap:10px"></div>
    <form class="a-input" id="aForm" autocomplete="off">
      <input id="aInput" type="text" inputmode="text" enterkeyhint="go" autocapitalize="characters" spellcheck="false" placeholder="적재위치 입력·스캔">
      <button id="aGo" type="submit">열기</button>
    </form>
    <div class="busybar" id="aBusy" hidden></div>
    <div id="aBody" style="display:flex;flex-direction:column;gap:10px"></div>
  </div>`;
  const bottom=document.createElement('div'); bottom.id='aBottom'; bottom.hidden=true; document.body.appendChild(bottom);
  const modalRoot=document.createElement('div'); modalRoot.id='aModal'; document.body.appendChild(modalRoot);
  // 스타일 B: 맨 위로 (목록을 내려가 있을 때만)
  const toTop=document.createElement('button'); toTop.id='aToTop'; toTop.type='button'; toTop.hidden=true; toTop.setAttribute('aria-label','맨 위로'); toTop.textContent='↑';
  toTop.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'})); document.body.appendChild(toTop);
  window.addEventListener('scroll',placeToTop,{passive:true});
  // 키보드가 올라오면 입력칸이 가려지지 않게 가운데로
  if(window.visualViewport) visualViewport.addEventListener('resize',()=>{ if(document.activeElement===$('aInput')) setTimeout(()=>$('aForm').scrollIntoView({block:'center'}),50); });

  $('aLoginForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const emp=$('aEmp').value.trim(), pw=$('aPw').value;
    if(!emp||!pw){ loginMessage='사번과 비밀번호를 입력해 주세요.'; render(); return; }
    $('aLoginBtn').disabled=true; $('aLoginBtn').textContent='로그인 중…'; loginMessage=''; render();
    try{ await Auth.login(emp,pw); $('aPw').value=''; S.message=null; S.hi=null; touchWorker(); api.onAuthChange&&api.onAuthChange(); }
    catch(err){ loginMessage=err.message||'로그인에 실패했습니다.'; }
    finally{ $('aLoginBtn').disabled=false; $('aLoginBtn').textContent='로그인'; render(); }
  });
  $('aRegForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const err=await registerWorker($('aRegName').value);
    $('aRegMsg').hidden=!err; $('aRegMsg').textContent=err||'';
    if(!err) api.onAuthChange&&api.onAuthChange();
  });
  $('aRegName').addEventListener('input',()=>{ $('aRegMsg').hidden=true; });
  $('aForm').addEventListener('submit',e=>{
    e.preventDefault();
    const v=$('aInput').value.replace(/\s+/g,''); $('aInput').value='';
    if(v) onCode(v);
  });
  $('aInput').addEventListener('input',e=>{ const v=e.target.value.replace(/\s+/g,''); if(v!==e.target.value) e.target.value=v; });

  root.addEventListener('click',onAct); bottom.addEventListener('click',onAct); modalRoot.addEventListener('click',onAct);
}

function onAct(e){
  const el=e.target.closest('[data-act]'); if(!el) return;
  const act=el.dataset.act, key=el.dataset.key||'';
  const errList=()=>S.kind==='GHOST'?S.ghostErrors:S.locErrors;
  const findErr=()=>{ const [reason,code]=key.split('\u0001'); return errList().find(x=>x.reason===reason&&x.code===code); };
  switch(act){
    case 'kind': if(S.kind!==key) switchKind(key); break;
    case 'voice': voiceDialog(); break;
    case 'rename': renameDialog(); break;
    case 'close': confirmBox('실사 닫기',S.kind==='GHOST'?'완료 기록 없이 이 자리 실사를 닫습니다. 찍은 기록은 사라지고, 유령재고 확정은 하지 않습니다.':'저장하지 않고 닫습니다. 센 수량은 사라집니다.',
      '닫기','red',()=>{ close(); render(); },'계속 세기'); break;
    case 'saved': if(S.savedOpen){ S.savedOpen=false; render(); } else loadSaved(); break;
    case 'savedToggle': { const c=el.closest('.a-saved'); const d=c&&c.querySelector('.diffs'); if(d) d.hidden=!d.hidden; break; }
    case 'resume': { e.stopPropagation(); const s=S.saved.find(x=>String(x.id)===key); if(s) resume(s); break; }
    case 'minus': { const it=S.locItems.find(i=>i.key===key); if(it) setCount(key,Math.max(0,(it.counted||0)-1)); break; }
    case 'plus': { const it=S.locItems.find(i=>i.key===key); if(it) setCount(key,(it.counted||0)+1); break; }
    case 'qty': qtyDialog(key); break;
    case 'stripQty': if(S.lastKey) qtyDialog(S.lastKey); break;
    case 'toggleZero': S.zeroOpen=!S.zeroOpen; render(); break;
    case 'toggleDone': S.doneOpen=!S.doneOpen; render(); break;
    case 'filter': S.filter=key; render(); break;
    case 'removeExtra': { const it=S.locItems.find(i=>i.key===key); if(it) confirmBox('이 카드 빼기',`${it.barcode||it.code}\n${it.name||'-'} — 이 로케이션 실사에서 뺍니다.`,'빼기','red',()=>removeExtra(key)); break; }
    case 'errHere': { e.stopPropagation(); const x=findErr(); if(x){ errorToItem(x); if(el.dataset.strip){ S.message=null; S.hi=null; render(); } } break; }
    // 확인함 — 지우지 않고 '확인했다' 표시만 (정산이 오류 스캔 기록을 '실물이 더 있을 수 있음' 점검에 쓴다). 다시 누르면 되돌린다
    case 'errOk': { e.stopPropagation(); const x=findErr(); if(x){ checkError(x,!x.checked); if(el.dataset.strip&&x.checked){ S.message=null; S.hi=null; render(); } } break; }
    case 'showErrors': errorsDialog(false); break;
    case 'blockErr': blockIfUnchecked(); break;
    case 'askGhost': if(!blockIfUnchecked()) ghostDialog(); break;
    case 'finishGhost': if(!blockIfUnchecked()) finishGhost(); break;
    case 'askSave': if(!blockIfUnchecked()) saveDialog(); break;
  }
}

function render(){
  if(!root) return;
  const active=api.isActive?api.isActive():true;
  const logged=Auth.valid();
  const named=!!S.workerName;
  $('aLogin').hidden=logged;
  $('aReg').hidden=!logged||named;
  $('aMain').hidden=!logged||!named;
  $('aMain').style.display=(!logged||!named)?'none':'flex';
  $('aLoginMsg').hidden=!loginMessage; $('aLoginMsg').textContent=loginMessage;
  $('aRegBtn').disabled=S.workerBusy;
  if(api.onWho) api.onWho(logged?(S.workerName||who()):'');
  const bottom=$('aBottom');
  if(!logged||!named){ bottom.hidden=true; document.body.style.paddingBottom=''; return; }

  const ghost=S.kind==='GHOST', open=isOpen(), B=S.design==='B';
  applyDesign();
  const sw=`<div class="a-switch">${[['GHOST','적재존 실사'],['LOCATION','로케이션 실사']].map(([k,l])=>`<button type="button" data-act="kind" data-key="${k}" class="${S.kind===k?'on':''}">${l}</button>`).join('')}</div>`;
  const voiceBtn=`<button type="button" class="a-voice${S.voiceOn?' on':''}" data-act="voice" aria-label="음성 안내 설정">${S.voiceOn?'🔊':'🔇'}</button>`;
  let top='', mid='';
  if(!open){
    const wk=`<div class="a-row"><span style="font-size:13px;color:var(--a-sub)">작업자</span><b style="font-size:16px">${esc(S.workerName)}</b><span class="a-grow"></span>
        <button type="button" class="a-obtn" data-act="rename">이름 변경</button></div>`;
    // 제목·설명 문단은 없앰 (2026-11-26). A = 전환 탭이 위, B = 카메라 아래
    if(B){ top=wk; mid=`<div class="a-row">${sw}${voiceBtn}</div>`; }
    else top=wk+`<div class="a-row">${sw}${voiceBtn}</div>`;
  }else{
    // 확인이 필요한 스캔 — 목록은 창으로 열고, 여기는 칩 하나만 (카드를 밀어내지 않게)
    const errs=curErrors(), left=unchecked(errs).length;
    const bump=left>lastUnchecked; lastUnchecked=left;
    const chip=!errs.length?'':left>0
      ?`<button type="button" class="a-chip${bump?' bump':''}" data-act="showErrors">⚠ 확인 필요 ${left}</button>`
      :`<button type="button" class="a-chip done" data-act="showErrors">오류 스캔 ${errs.length} · 확인함</button>`;
    const P=progress(), pct=P.total?Math.round(P.done/P.total*100):0;
    const lbl=ghost?'적재위치':S.locPrefix?'로케이션 앞자리':'로케이션', pos=esc(ghost?S.ghostPos:S.locScope);
    const locExtra=ghost?'':`<span style="color:${P.diff>0?'var(--a-short)':'var(--a-ok)'};font-weight:700">차이 ${P.diff}</span>
        <span class="s">로케재고 ${P.expSum} / 센 ${P.cntSum}</span>`;
    const prev=!ghost&&S.locPrev?`<div class="a-prev">${esc(S.locPrev)}</div>`:'';
    if(!B){
      // 스타일 A — 탭 · 작업 정보 카드(위치 · 작업자 · 전체/확인/남은 · 진행률)
      top=`<div class="a-row">${sw}</div>
        <div class="a-card a-accent"><div class="in a-scope wk-a">
          <div class="a-row" style="align-items:flex-start"><div class="pos-wrap"><span class="lbl">${lbl}</span><span class="pos mono">${pos}</span><span class="wk">작업자 <b>${esc(S.workerName)}</b></span></div>
            ${voiceBtn}<button type="button" class="a-obtn" data-act="close" style="color:var(--a-text)">닫기</button></div>
          <div class="a-stats"><div><b>${P.total}</b><small>전체${ghost?' 박스':''}</small></div><div><b class="ok">${P.done}</b><small>확인</small></div><div><b class="left">${P.left}</b><small>남은</small></div></div>
          <div class="a-row" style="gap:10px"><div class="a-prog a-grow"><i style="width:${pct}%"></i></div><b class="a-pct">${pct}%</b></div>
          ${locExtra||chip?`<div class="a-row a-sum2">${locExtra}<span class="a-grow"></span>${chip}</div>`:''}
          ${prev}</div></div>`;
    }else{
      // 스타일 B — 위에 붙는 짧은 요약 한 장 (위치 · 작업자 · 확인/남은 · 진행률 · 종료)
      top=`<div class="b-sum">
          <div class="a-row"><span class="b-lbl">${lbl}</span><span class="b-pos mono a-grow">${pos}</span>${voiceBtn}<button type="button" class="b-end" data-act="close">종료</button></div>
          <div class="a-row b-meta"><span>작업자 <b>${esc(S.workerName)}</b></span><span>확인 <b class="ok">${P.done}</b>/${P.total}</span><span>남은 <b class="left">${P.left}</b></span>
            ${ghost?'':`<span style="color:${P.diff>0?'var(--a-short)':'var(--a-ok)'}">차이 <b>${P.diff}</b></span>`}<span class="a-grow"></span>${chip}</div>
          <div class="a-prog"><i style="width:${pct}%"></i></div>${prev}</div>`;
      mid=sw;
    }
  }
  $('aTop').innerHTML=top;
  $('aMid').innerHTML=mid; $('aMid').hidden=!mid;
  $('aInput').placeholder=!open?(ghost?'적재위치 입력·스캔':'로케이션 입력·스캔'):(ghost?'박스 바코드 (스캐너·직접 입력)':'상품 바코드 (스캐너·직접 입력)');
  $('aGo').textContent=open?'확인':'열기'; $('aGo').disabled=S.busy;
  $('aBusy').hidden=!S.busy;

  let body='';
  if(!open){
    if(!ghost){
      body=`<button type="button" class="a-obtn big" data-act="saved">${S.savedOpen?'저장목록 닫기':'저장한 로케이션 실사 보기'}</button>`;
      if(S.savedOpen) body+=savedHtml();
    }
  }else{
    body+=(B?'':filterHtml())+(ghost?ghostCardsHtml():locCardsHtml());
  }
  $('aBody').innerHTML=body;
  // 오류 창이 열려 있으면 내용을 지금 목록으로 (창을 연 채 또 찍어도 맞게)
  const eb=$('errModalBody');
  if(eb){ if(!open||!curErrors().length) $('aModal').innerHTML=''; else eb.innerHTML=errorsHtml(curErrors(),ghost); }

  // 맨 아래 고정: 저장·확정 버튼 + 방금 찍은 결과 띠
  let bot='';
  const hasMsg=!!S.message;
  if(open){
    let btn;
    const left=unchecked(curErrors()).length;
    // 확인 안 된 오류 스캔이 있으면 저장·확정 대신 '먼저 확인' (누르면 오류 창)
    if(left>0) btn=`<button type="button" class="a-btn red" data-act="blockErr">확인 필요 ${left}건 처리 후 ${ghost?(ghostRemain().length?'확정':'완료'):'저장'}</button>`;
    else if(ghost){ const r=ghostRemain().length;
      btn=r>0?`<button type="button" class="a-btn amber" data-act="askGhost" ${S.busy?'disabled':''}>남은 ${r}건 유령재고 확정</button>`
             :`<button type="button" class="a-btn ok" data-act="finishGhost" ${S.busy?'disabled':''}>전부 확인 · 이 자리 완료</button>`; }
    else btn=`<button type="button" class="a-btn" data-act="askSave" ${S.busy||!S.locItems.length?'disabled':''}>${esc(S.locScope)} 실사 저장</button>`;
    bot+=`<div class="act${hasMsg?'':' last'}">${btn}</div>`;
  }
  if(hasMsg) bot+=stripHtml();
  bottom.innerHTML=bot;
  bottom.hidden=!active||!bot;
  document.body.style.paddingBottom=(!bottom.hidden)?(bottom.offsetHeight+12)+'px':'';
  placeToTop();

  // 방금 찍은 카드(맨 위)가 화면 밖이면 보이게 — 이미 보이면 움직이지 않는다
  const sig=S.lastKey?S.lastKey+':'+(S.locItems.find(i=>i.key===S.lastKey)||{}).counted:'';
  if(open&&S.lastKey&&sig!==lastScrolledKey){
    lastScrolledKey=sig;
    const card=$('aBody').querySelector('.a-box.last,.b-row.last');
    if(card){ const r=card.getBoundingClientRect(); const bh=bottom.hidden?0:bottom.offsetHeight; if(r.top<60||r.bottom>window.innerHeight-bh) card.scrollIntoView({block:'nearest',behavior:'smooth'}); }
  }
  if(!S.lastKey) lastScrolledKey='';
}

// 묶음 머리 (재고 0 상품 · 확인된 박스) — 눌러서 펼치기/접기
const groupHead=(title,n,unit,open,act)=>`<button type="button" class="a-zero-head" data-act="${act}" aria-expanded="${open}">
  <span class="ttl">${title}</span><span class="n">${n}${unit}</span><span class="a-grow"></span><span class="tg">${open?'접기 ▴':'펼치기 ▾'}</span></button>`;
// ── 화면 스타일 (A 카드형+필터 / B 플로팅+빠른 액션) — 그리는 방법만 다르고 데이터·동작은 같다 ──
function applyDesign(){
  document.body.classList.toggle('design-mode-a',S.design!=='B');
  document.body.classList.toggle('design-mode-b',S.design==='B');
  if($('aTop')) $('aTop').classList.toggle('b-stick',S.design==='B'&&isOpen());
}
function setDesign(d){
  if(d!=='A'&&d!=='B') return;
  S.design=d; ls.set('audit_design',d); render();
  if(api.onDesign) api.onDesign(d);
}
// 진행 숫자 (A 작업 카드 · B 요약 같이 씀). 로케이션은 재고 0 을 안 세도 끝난 것으로 (저장 창의 '미확인'과 같은 기준)
function progress(){
  if(S.kind==='GHOST'){ const n=S.ghostCards.length, d=ghostDone(); return {total:n,done:d,left:ghostRemain().length}; }
  const items=S.locItems, left=items.filter(i=>status(i)==='wait').length;
  return {total:items.length,done:items.length-left,left,
    diff:items.filter(i=>i.counted!=null&&!['ok','zero'].includes(status(i))).length,
    expSum:items.filter(i=>!i.extra).reduce((a,i)=>a+i.expected,0),cntSum:items.reduce((a,i)=>a+(i.counted||0),0)};
}
// 필터 (스타일 A) — 미확인 = 아직 안 센 것(재고 있는 상품), 확인 완료 = 그 밖 전부(찍음·수량 넣음·위치다름·재고 0)
// 확인 완료 = 미확인이 아닌 것 전부 (재고 0 은 안 세도 끝난 것) — 위 '확인 N/M' 진행 숫자와 같은 기준이라 전체 = 미확인 + 확인 완료
const locTodo=i=>status(i)==='wait', locChecked=i=>status(i)!=='wait';
function filterHtml(){
  const ghost=S.kind==='GHOST', sc=new Set(S.ghostScanned);
  const c=ghost?{all:S.ghostCards.length,todo:S.ghostCards.filter(b=>!sc.has(b.boxCode)).length,done:S.ghostCards.filter(b=>sc.has(b.boxCode)).length}
               :{all:S.locItems.length,todo:S.locItems.filter(locTodo).length,done:S.locItems.filter(locChecked).length};
  return `<div class="a-filter" role="tablist">${[['all','전체'],['todo','미확인'],['done','확인 완료']].map(([k,l])=>
    `<button type="button" role="tab" aria-selected="${S.filter===k}" class="${S.filter===k?'on':''}" data-act="filter" data-key="${k}">${l}<b>${c[k]}</b></button>`).join('')}</div>`;
}
const emptyNote=f=>`<div class="a-empty">${f==='todo'?'미확인 항목이 없습니다.':'아직 확인한 항목이 없습니다.'}</div>`;
const lastFirst=(l,key)=>l.filter(x=>key(x)===S.lastKey).concat(l.filter(x=>key(x)!==S.lastKey));
// 스타일 B 맨 위로 버튼 — 맨 아래 고정 영역 바로 위
function placeToTop(){
  const b=$('aToTop'); if(!b) return;
  const show=S.design==='B'&&isOpen()&&(api.isActive?api.isActive():true)&&Auth.valid()&&!!S.workerName&&window.scrollY>320;
  b.hidden=!show;
  if(show){ const bt=$('aBottom'); b.style.bottom=((bt&&!bt.hidden?bt.offsetHeight:0)+14)+'px'; }
}

// 남은 박스가 위, 확인된 박스는 아래 '확인된 박스' 묶음(접힘). 방금 찍은 박스만 맨 위에 잠깐 (다음에 찍으면 묶음으로)
function ghostCardsHtml(){
  const B=S.design==='B', scanned=new Set(S.ghostScanned), one=b=>B?ghostRowHtml(b,scanned):ghostCardHtml(b,scanned);
  const wrap=inner=>`<div class="a-list${B?' b-list':''}">${inner}</div>`;
  const f=B?'all':S.filter;
  if(f!=='all'){
    // 방금 찍은 박스는 필터와 상관없이 맨 위에 (찍자마자 목록에서 사라지지 않게)
    const l=lastFirst(S.ghostCards.filter(c=>c.boxCode===S.lastKey||(f==='todo'?!scanned.has(c.boxCode):scanned.has(c.boxCode))),c=>c.boxCode);
    return l.length?wrap(l.map(one).join('')):emptyNote(f);
  }
  const top=S.ghostCards.filter(c=>c.boxCode===S.lastKey), rest=S.ghostCards.filter(c=>c.boxCode!==S.lastKey);
  const main=top.concat(rest.filter(c=>!scanned.has(c.boxCode))), done=rest.filter(c=>scanned.has(c.boxCode));
  const open=S.doneOpen||!main.length;
  const ordered=main.concat(open?done:[]);
  const head=done.length?groupHead('확인된 박스',done.length,'박스',open,'toggleDone'):'';
  return wrap(ordered.map((b,i)=>(i===main.length?head:'')+one(b)).join('')+(ordered.length===main.length?head:''));
}
// 스타일 B 한 줄 — 바코드 크게 · 상품명/박스는 작게 · 오른쪽에 상태와 수량
function ghostRowHtml(b,scanned){
  const ok=scanned.has(b.boxCode), last=b.boxCode===S.lastKey;
  return `<div class="b-row${ok?' done':''}${last?' last':''}" style="--st:${ok?'var(--a-ok)':'var(--a-navy)'}">
    <div class="b-main"><div class="b-code big mono">${esc(b.barcode)}</div>
      <div class="b-name">${esc(b.name||'-')}</div>${b.optionName?`<div class="b-opt">${esc(b.optionName)}</div>`:''}
      <div class="b-sub mono">박스 ${esc(b.boxCode)} · <b class="c-loc">${esc(b.position||S.ghostPos)}</b></div></div>
    <div class="b-right">${ok?badge('확인됨','var(--a-ok)','var(--a-ok-soft)'):badge('미확인','var(--a-navy)','var(--a-navy-soft)')}<div class="b-qty c-stk">${b.stock}<small>개</small></div></div></div>`;
}
function ghostCardHtml(b,scanned){
    const ok=scanned.has(b.boxCode), last=b.boxCode===S.lastKey;
    const border=last?`border:2px solid ${ok?'var(--a-ok)':'var(--a-blue)'}`:'';
    return `<div class="a-box${ok?' done':''}${last?' last':''}" style="${border}">
      <div class="a-row"><span class="place mono">${esc(b.position||S.ghostPos)}</span><span class="a-grow"></span>${ok?badge('확인됨','var(--a-ok)','var(--a-ok-soft)'):badge('미확인','var(--a-navy)','var(--a-navy-soft)')}</div>
      <div class="a-row" style="align-items:flex-end"><span class="code mono a-grow">${esc(b.barcode)}</span><span class="qty c-stk">${b.stock}<small>개</small></span></div>
      <div class="meta mono">박스 ${esc(b.boxCode)}</div>
      <div class="meta">${esc(b.name||'-')}</div>${b.optionName?`<div class="meta opt">${esc(b.optionName)}</div>`:''}</div>`;
}

// 재고 있는 상품 위 / 재고 0 상품은 아래 '재고 0' 묶음(접힘)으로 — 재고 0 이어도 찍어서 센 것·위치다름은 위로
const isZeroItem=i=>!i.extra&&i.expected===0&&!(i.counted>0);
function locCardsHtml(){
  const B=S.design==='B', one=B?locRowHtml:locCardHtml, f=B?'all':S.filter;
  const wrap=inner=>`<div class="a-list${B?' b-list':''}">${inner}</div>`;
  const note=`<div class="a-note">${B?'줄을 누르면 수량을 숫자로 넣을 수 있습니다 (0 = 없음).':'가운데 수량 칸을 누르면 숫자로 바로 넣을 수 있습니다 (0 = 없음).'} 카메라는 바코드를 떼었다 다시 대야 1개 더 셉니다.</div>`;
  if(f!=='all'){
    // 방금 센 상품은 필터와 상관없이 맨 위에 (+ 를 이어서 누를 수 있게)
    const want=f==='todo'?locTodo:locChecked;
    const l=lastFirst(S.locItems.filter(i=>i.key===S.lastKey||want(i)),i=>i.key);
    return (l.length?wrap(l.map(one).join('')):emptyNote(f))+note;
  }
  const rest=S.locItems.filter(i=>i.key!==S.lastKey), top=S.locItems.filter(i=>i.key===S.lastKey);
  const main=top.concat(rest.filter(i=>!isZeroItem(i))), zero=rest.filter(isZeroItem);
  const zeroOpen=S.zeroOpen||!main.length;
  const zeroHead=zero.length?groupHead('재고 0 상품',zero.length,'개',zeroOpen,'toggleZero'):'';
  return wrap(main.map(one).join('')+zeroHead+(zeroOpen?zero.map(one).join(''):''))+note;
}
// 스타일 B 한 줄 — 누르면 수량 창 (필요할 때만 수량 조작)
function locRowHtml(it){
  const st=status(it), [label,fg,bg]=stStyle(st), last=it.key===S.lastKey, k=esc(it.key);
  const sub=it.extra?`이 자리에서 발견 · 등록 <b class="mono c-loc">${esc(it.location||'없음')}</b>`
    :`<b class="mono c-loc">${esc(it.location||'로케 없음')}</b> · 로케재고 <b class="c-stk">${it.expected}</b>`;
  return `<div class="b-row${last?' last':''}" data-act="qty" data-key="${k}" style="--st:${fg}">
    <div class="b-main"><div class="b-code mono">${esc(it.barcode||it.code)}</div>
      <div class="b-name">${esc(it.name||'-')}</div>${it.option?`<div class="b-opt">${esc(it.option)}</div>`:''}
      <div class="b-sub">${sub}</div></div>
    <div class="b-right">${badge(label,fg,bg)}
      <div class="b-qty" style="color:${it.counted==null?'var(--a-idle)':fg}">${it.counted==null?'–':it.counted}${it.extra?'':`<small class="c-stk">/ ${it.expected}</small>`}</div>
      ${it.extra?`<button type="button" class="b-x" data-act="removeExtra" data-key="${k}">빼기</button>`:''}</div></div>`;
}
function locCardHtml(it){
    const st=status(it), [label,fg,bg]=stStyle(st), last=it.key===S.lastKey;
    const k=esc(it.key);
    // 위치다름 카드는 머리에 '지금 세는 자리'(찾은 곳)를, 등록 로케이션은 아래 파란 상자에 따로
    return `<div class="a-box${last?' last':''}${it.extra?' extra':''}" style="${last?`border:2px solid ${fg}`:''}" data-act="qty" data-key="${k}">
      <div class="a-row"><span class="place mono a-grow">${esc(it.extra?S.locScope:(it.location||'로케 없음'))}</span>${badge(label,fg,bg)}</div>
      <div class="code mono">${esc(it.barcode||it.code)}</div>
      <div class="meta">${esc(it.name||'-')}</div>${it.option?`<div class="meta opt">${esc(it.option)}</div>`:''}
      <hr>
      <div class="a-row" style="gap:0">
        ${!it.extra?`<div class="a-grow"><div class="exp-l">로케재고</div><div class="exp c-stk">${it.expected}<small>정상 ${it.stock} − 적재 ${it.jaeja}</small></div></div>`
          :`<div class="a-grow x-info"><div class="x-l">이 자리에서 발견</div><div class="x-loc">등록 로케이션 <b class="mono">${esc(it.location||'없음')}</b></div>
              <button type="button" class="x-btn" data-act="removeExtra" data-key="${k}">이 카드 빼기</button></div>`}
        <button type="button" class="step" data-act="minus" data-key="${k}">−</button>
        <button type="button" class="cnt${it.counted==null?' empty':''}" data-act="qty" data-key="${k}" style="${it.counted==null?'':`color:${fg};border-color:color-mix(in srgb, ${fg} 60%, transparent)`}">${it.counted==null?'입력':it.counted}</button>
        <button type="button" class="step" data-act="plus" data-key="${k}">+</button>
      </div>
    </div>`;
}

// 오류 스캔 목록 (창 안) — 한 건 = 카드 한 장: 사유 배지 · 바코드 · 상품 · 위치 / 아래에 큰 버튼 두 개.
// 확인 안 된 것 먼저, 확인한 것은 흐리게 아래로
function errorsHtml(errors,ghost){
  const list=unchecked(errors).concat(errors.filter(e=>e.checked));
  const left=unchecked(errors).length;
  return `<div class="e-sum">${left?`남은 확인 <b style="color:var(--a-red)">${left}건</b> · 전체 ${errors.length}건`:`전부 확인했습니다 · 전체 ${errors.length}건`}</div>
  <div class="e-list">${list.map(e=>{
    const k=esc(e.reason+'\u0001'+e.code);
    const acts=e.checked
      ?`<button type="button" class="e-btn undo" data-act="errOk" data-key="${k}">확인 취소</button>`
      :(!ghost&&e.reason!=='hangul'?`<button type="button" class="e-btn here" data-act="errHere" data-key="${k}">여기 있음</button>`:'')+
       `<button type="button" class="e-btn ok" data-act="errOk" data-key="${k}">확인함</button>`;
    return `<div class="e-card${e.checked?' ok':''}">
      <div class="e-top"><span class="e-reason">${esc(ERROR_LABEL[e.reason]||e.reason)}${e.n>1?` ×${e.n}`:''}</span>${e.checked?'<span class="e-done">✓ 확인함</span>':''}</div>
      <div class="e-code mono">${esc(e.code)}</div>
      ${e.name?`<div class="e-name">${esc(e.name)}</div>${e.option?`<div class="e-name">${esc(e.option)}</div>`:''}`:''}
      ${e.where?`<div class="e-where"><span>${ghost?'현재 위치':'등록 로케이션'}</span><b class="mono">${esc(e.where)}</b></div>`:''}
      <div class="e-acts">${acts}</div></div>`;
  }).join('')}</div>`;
}
let lastUnchecked=0;
function errorsDialog(blocking){
  const ghost=S.kind==='GHOST', errs=curErrors(); if(!errs.length) return;
  // 버튼 뜻을 같은 모양의 작은 표시로 먼저 보여 준다
  const guide=`<div class="e-guide">
    ${!ghost?'<div><span class="e-pill here">여기 있음</span>이 자리에 실물이 있음 → 위치다름 카드로 올림</div>':''}
    <div><span class="e-pill ok">확인함</span>${ghost?'확인했음':'실물 없음 · 잘못 찍음'} → 기록만 남김 (지워지지 않음)</div>
    ${ghost?'<div class="e-sub">다른 위치 박스를 이 자리로 옮기는 것은 5F 웹 위치변경에서 해 주세요.</div>':''}</div>`;
  modal('확인이 필요한 스캔',
    (blocking?`<div class="e-block">확인이 끝나야 ${ghost?'확정·완료':'저장'}할 수 있습니다.</div>`:'')+guide+`<div id="errModalBody" class="e-body">${errorsHtml(errs,ghost)}</div>`,
    [{label:'닫기',cls:'a-btn'}]);
}

function savedHtml(){
  return `<div class="a-list">${S.saved.map(s=>{
    const mine=s.worker===S.workerName;
    const newer=S.saved.find(x=>x.scope===s.scope&&x.id>s.id);
    const notCounted=s.items.filter(i=>!i.extra&&!i.counted).length;
    return `<div class="a-saved" data-act="savedToggle">
      <div class="a-row"><span class="sc mono">${esc(s.scope)}</span><span class="tm">${esc(shortTime(s.savedAt))} · ${esc(s.worker)}</span></div>
      <div class="ln">상품 ${s.total} · 일치 ${s.ok} · 부족 ${s.short} · 없음 ${s.missing} · 초과 ${s.over}${s.extra>0?` · 위치다름 ${s.extra}`:''}</div>
      ${notCounted>0?`<div class="a-prev">안 센 상품 ${notCounted}개 (0개로 저장됨)</div>`:''}
      ${mine&&!newer?`<button type="button" class="a-btn full" style="height:44px;margin-top:4px;font-size:15px" data-act="resume" data-key="${s.id}" ${S.busy?'disabled':''}>이어서 세기</button>`
        :mine?`<div class="a-note">이후 ${esc(shortTime(newer.savedAt))} ${esc(newer.worker)} 님이 다시 저장함 — 그 저장본에서 이어서 세세요</div>`:''}
      <div class="diffs" hidden>${s.diffs.length?s.diffs.map(d=>{ const [l,fg]=stStyle(d.status);
        return `<div class="d"><b style="color:${fg}">${esc(l)}</b><span class="a-grow">${esc(d.name)}${d.option?' / '+esc(d.option):''}</span><b>${d.expected==null?'-':d.expected} → ${d.counted||0}</b></div>`; }).join('')
        :'<div style="color:var(--a-ok);font-size:13px">차이 없음</div>'}</div>
    </div>`;
  }).join('')}</div>`;
}

function stripHtml(){
  const {text,err}=S.message, h=S.hi, ghost=S.kind==='GHOST';
  // 띠 색 = 판정 — 오류 빨강 · 초과 주황 · 일치 초록 · 위치다름 블루 · 그 밖 네이비
  const bg=err?'var(--a-short)':h&&h.state==='over'?'var(--a-over)':h&&h.state==='ok'?'var(--a-ok)':h&&h.state==='extra'?'var(--a-blue)':'var(--a-navy)';
  const mark=err?'⚠':h&&h.state==='over'?'▲':'✓';
  const editable=!err&&!ghost&&h&&S.locItems.some(i=>i.key===S.lastKey);
  const errors=ghost?S.ghostErrors:S.locErrors;
  const errItem=err&&h?errors.find(e=>e.code===h.code&&!e.checked):null;
  const ek=errItem?esc(errItem.reason+'\u0001'+errItem.code):'';
  return `<div class="strip" style="background:${bg}" ${editable?'data-act="stripQty"':''}><div class="wrap">
    <span class="mk">${mark}</span>
    <div class="a-grow">${h?`<div class="place mono">${esc(h.place)}</div><div class="code mono">${esc(h.code)}</div>`:''}
      <div class="txt${h?'':' only'}">${esc(text)}</div></div>
    ${h&&(h.qty||h.tag)?`<div class="q">${h.qty?`<span class="n">${esc(h.qty)}</span>`:''}${h.tag?`<span class="tag" style="color:${bg}">${esc(h.tag)}</span>`:''}${editable?'<span class="edit">눌러서 수량 수정 ›</span>':''}</div>`:''}
    ${errItem?`<div class="eb">${!ghost&&errItem.reason!=='hangul'?`<button type="button" class="w" style="color:${bg}" data-act="errHere" data-strip="1" data-key="${ek}">여기 있음</button>`:''}
      <button type="button" class="o" data-act="errOk" data-strip="1" data-key="${ek}">확인함</button></div>`:''}
  </div></div>`;
}

// ── 창 ──
function modal(title,bodyHtml,buttons,onOpen){
  const m=$('aModal');
  m.innerHTML=`<div class="modal"><div class="box" role="dialog" aria-modal="true"><div class="mt">${title}</div><div class="mb">${bodyHtml}</div>
    <div class="mf">${buttons.map((b,i)=>`<button type="button" data-i="${i}" class="${b.cls||'a-btn'}">${esc(b.label)}</button>`).join('')}</div></div></div>`;
  const shut=()=>{ m.innerHTML=''; };
  const back=m.firstElementChild;
  back.addEventListener('click',ev=>{ if(ev.target===back) shut(); });
  back.querySelectorAll('.mf [data-i]').forEach(btn=>btn.addEventListener('click',()=>{ const b=buttons[+btn.dataset.i]; if(b.keep) b.act&&b.act(); else { shut(); b.act&&b.act(); } }));
  if(onOpen) onOpen(back,shut);
  return shut;
}
function confirmBox(title,text,okLabel,cls,act,cancel='취소'){
  modal(esc(title),esc(text),[{label:cancel,cls:'a-tbtn',act:null},{label:okLabel,cls:'a-btn '+(cls||''),act}]);
}
function ghostDialog(){
  const remain=ghostRemain(); if(!remain.length) return;
  const body=`<div>${esc(S.ghostPos)} 에서 찍히지 않은 ${remain.length}건을 유령재고로 확정합니다.</div>
    <div style="font-size:13px;color:var(--a-sub)">· 적재위치가 '${esc(GHOST_PREFIX+S.ghostPos)}' 로 바뀝니다 (출고되지 않음)
· 5F 웹 유령재고 리스트에 기록되고, 실물을 찾으면 원래 위치로 복구할 수 있습니다</div>
    ${remain.slice(0,8).map(b=>`<div class="mono" style="font-size:12px">${esc(b.boxCode)}  ${esc(b.name)}</div>`).join('')}
    ${remain.length>8?`<div style="font-size:12px;color:var(--a-sub)">… 외 ${remain.length-8}건</div>`:''}
    ${S.ghostErrors.length?`<div style="font-size:13px;color:var(--a-sub)">확인한 오류 스캔 ${S.ghostErrors.length}건도 함께 기록됩니다. <button type="button" class="a-tbtn blue" style="padding:0" data-act="showErrors">보기</button></div>`:''}`;
  modal('유령재고 확정',body,[{label:'취소',cls:'a-tbtn'},{label:'확정',cls:'a-btn amber',act:confirmGhost}]);
}
function saveDialog(){
  const waiting=S.locItems.filter(i=>status(i)==='wait').length, diff=S.locItems.filter(i=>finalStatus(i)!=='ok').length;
  const body=`<div>상품 ${S.locItems.length}개 · 차이 ${diff}건으로 저장합니다.</div>
    ${waiting>0?`<div style="color:var(--a-red);font-weight:600">아직 안 센 상품 ${waiting}개는 0개(없음)로 저장됩니다.</div>`:''}
    ${S.locErrors.length?`<div style="font-size:13px;color:var(--a-sub)">확인한 오류 스캔 ${S.locErrors.length}건도 함께 기록됩니다. <button type="button" class="a-tbtn blue" style="padding:0" data-act="showErrors">보기</button></div>`:''}`;
  modal(`${esc(S.locScope)} 실사 저장`,body,[{label:'취소',cls:'a-tbtn'},{label:'저장',cls:'a-btn',act:saveLocation}]);
}
let qtyInp=null;
function qtyDialog(key){
  const it=S.locItems.find(i=>i.key===key); if(!it) return;
  const start=it.counted==null?'':String(it.counted);
  const body=`<div style="font-size:13px;color:var(--a-sub)">${esc(it.name||'-')}${it.option?' / '+esc(it.option):''}</div>
    ${!it.extra?`<div style="color:var(--a-sub)">로케재고 ${it.expected}개</div>`:''}
    <form id="qtyForm"><input class="a-field qtyin" id="qtyIn" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="5" placeholder="센 수량" value="${esc(start)}"></form>
    <div class="a-row" style="flex-wrap:wrap">${!it.extra?'<button type="button" class="a-obtn" id="qtySame">로케재고와 같음</button>':''}<button type="button" class="a-obtn" id="qtyZero">없음 (0)</button></div>
    ${it.counted!=null&&!it.extra?'<button type="button" class="a-tbtn" id="qtyReset" style="align-self:flex-start;padding-left:0">안 센 것으로 되돌리기</button>':''}`;
  const apply=v=>setCount(key,v);
  modal(`<span class="mono" style="font-weight:800">${esc(it.barcode||it.code)}</span>`,body,
    // 적용 — 창을 닫은 뒤에 실행되므로 입력칸은 미리 잡아 둔 것을 읽는다 (닫힌 뒤 $('qtyIn') 은 없음)
    [{label:'취소',cls:'a-tbtn'},{label:'적용',cls:'a-btn',act:()=>apply(parseInt(qtyInp&&qtyInp.value,10)||0)}],
    (box,shut)=>{
      const inp=box.querySelector('#qtyIn'); qtyInp=inp;
      inp.addEventListener('input',()=>{ inp.value=inp.value.replace(/\D/g,'').slice(0,5); });
      box.querySelector('#qtyForm').addEventListener('submit',ev=>{ ev.preventDefault(); const v=parseInt(inp.value,10)||0; shut(); apply(v); });
      const same=box.querySelector('#qtySame'); if(same) same.addEventListener('click',()=>{ shut(); apply(it.expected); });
      box.querySelector('#qtyZero').addEventListener('click',()=>{ shut(); apply(0); });
      const reset=box.querySelector('#qtyReset'); if(reset) reset.addEventListener('click',()=>{ shut(); apply(null); });
      // 열리자마자 숫자 키패드 + 기존 숫자 선택 (아이폰은 누른 순간에 바로 focus 해야 키보드가 뜬다)
      try{ inp.focus(); inp.select(); }catch(e){}
    });
}
function renameDialog(){
  const body=`<div style="color:var(--a-sub)">지금 이름: ${esc(S.workerName)}</div>
    <input class="a-field" id="renIn" maxlength="12" value="${esc(S.workerName)}"><div class="a-err" id="renMsg" hidden></div>`;
  modal('작업자 이름 변경',body,[{label:'취소',cls:'a-tbtn'},{label:'변경',cls:'a-btn',keep:true,act:async()=>{
    const err=await registerWorker($('renIn').value);
    if(err){ const m=$('renMsg'); if(m){ m.hidden=false; m.textContent=err; } } else $('aModal').innerHTML='';
  }}],box=>{ const i=box.querySelector('#renIn'); try{ i.focus(); i.select(); }catch(e){} });
}
const PREVIEW='여덟 개, 초과. 확인, 남은 세 개';
function voiceDialog(){
  const draw=()=>{
    const vs=koVoices();
    const opt=(name,label,sub)=>`<button type="button" class="opt${S.voiceName===name?' on':''}" data-v="${esc(name)}"><span style="flex:1">${esc(label)}<span class="sub">${esc(sub)}</span></span><span style="color:var(--a-blue)">▶</span></button>`;
    return `<div class="a-row"><b style="flex:1;font-size:16px">음성 안내</b><button type="button" class="a-obtn" data-on="1" style="${S.voiceOn?'background:var(--a-navy);color:#fff;border-color:var(--a-navy)':''}">${S.voiceOn?'켜짐':'꺼짐'}</button></div>
      <div style="font-size:13px;font-weight:600;color:var(--a-sub)">말 빠르기</div>
      <div class="rates">${[['느리게',.9],['보통',1.1],['빠르게',1.3],['아주 빠르게',1.5]].map(([l,r])=>`<button type="button" data-r="${r}" class="${Math.abs(S.voiceRate-r)<.01?'on':''}">${l}</button>`).join('')}</div>
      <div style="font-size:13px;font-weight:600;color:var(--a-sub)">목소리 (누르면 바로 들려줍니다)</div>
      ${opt(VOICE_CLIPS,'녹음 음성 (추천)','미리 녹음한 자연스러운 목소리 · 앱과 같은 목소리')}
      <div style="font-size:12px;font-weight:600;color:var(--a-sub)">기기 음성</div>
      ${opt('','자동','이 기기의 한국어 음성')}
      ${vs.map((v,i)=>opt(v.name,`목소리 ${i+1} · ${v.name}`,v.localService?'기기에 저장됨':'인터넷 필요')).join('')}
      ${!vs.length?'<div style="font-size:12px;color:var(--a-sub)">이 브라우저에서 한국어 기기 음성을 찾지 못했습니다. 녹음 음성은 그대로 됩니다.</div>':''}
      <div style="font-size:11px;color:var(--a-sub)">아이폰은 무음 스위치가 켜져 있으면 소리가 안 날 수 있습니다 · 설정은 이 기기에만 저장됩니다</div>`;
  };
  modal('음성 안내 설정',draw(),[{label:'닫기',cls:'a-btn'}],box=>{
    const mb=box.querySelector('.mb');
    const preview=()=>{ if(S.voiceName===VOICE_CLIPS) speak('8개, 초과',true); else speak(PREVIEW,true); };
    mb.addEventListener('click',ev=>{
      const t=ev.target.closest('button'); if(!t) return;
      if(t.dataset.on){ toggleVoice(); }
      else if(t.dataset.r){ S.voiceRate=parseFloat(t.dataset.r); ls.set('audit_voice_rate',String(S.voiceRate)); preview(); }
      else if(t.dataset.v!=null){ S.voiceName=t.dataset.v; ls.set('audit_voice_name',S.voiceName); if(S.voiceName===VOICE_CLIPS){ preloaded=false; preloadClips(); } preview(); }
      mb.innerHTML=draw();
    });
    if(window.speechSynthesis&&!koVoices().length) speechSynthesis.onvoiceschanged=()=>{ if(document.body.contains(mb)) mb.innerHTML=draw(); };
  });
}

// ══ 바깥(index.html)과 잇기 ══
window.Audit={
  init(a){
    api=a||{};
    restore(); ensureSession(); skeleton(); render();
    // 세는 중이면 45초마다 현황판에 살아 있다고 알린다
    setInterval(()=>{ if(S.ghostPos) pushLive(); if(S.locScope) pushLocLive(); },LIVE_BEAT_MS);
  },
  onCode,
  activate(){ ensureSession(); touchWorker(); preloadClips(); render(); },
  deactivate(){ $('aModal').innerHTML=''; render(); },
  render,
  design:()=>S.design,
  setDesign,
  audioUnlocked(){ preloadClips(); },
  needsLogin(){ return !Auth.valid()||!S.workerName; },
  logout(){ logout(''); },
  // 계정 창 — 앱 AccountDialog 와 같은 내용
  account(){
    if(!Auth.valid()) return;
    modal(esc(who()),`<div>다른 사번으로 바꾸려면 로그아웃한 뒤 다시 로그인하세요.</div>${S.workerName?`<div style="font-size:13px;color:var(--a-sub)">작업자 이름: ${esc(S.workerName)}</div>`:''}<div style="font-size:12px;color:var(--a-sub)">웹 버전</div>`,
      [{label:'닫기',cls:'a-tbtn'},{label:'로그아웃',cls:'a-btn',act:()=>logout('')}]);
  },
  loggedIn(){ return Auth.valid(); },
};
})();

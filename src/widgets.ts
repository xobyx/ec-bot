import type { Room, MicroTaskLibrary, Status } from './types';
import { finishCompactName, getRoomFinishMicroTasks, getAllRoomPhotoItems } from './supabase';

function statusShortCode(st: Status | string | undefined): 'd' | 'o' | 'p' {
  if (st === 'done') return 'd';
  if (st === 'ongoing') return 'o';
  return 'p';
}

function utf8Len(str: string): number {
  return new TextEncoder().encode(str).length;
}

/**
 * Builds compact JSON state (<= 1000 bytes UTF-8) for the Interactive Room HTML Widget.
 * Shape:
 * {
 *   id: roomId,
 *   c: spaceCode,
 *   n: spaceName,
 *   l: level,
 *   z: zone,
 *   p: photoCount,
 *   f: [ [code, shortName, 'd'|'o'|'p', prepDone, prepTotal, [ [idx, microName, 'd'|'o'|'p'] ]] ],
 *   s: [ [snagId, trade, text] ]
 * }
 */
export function buildRoomWidgetState(room: Room, microLib: MicroTaskLibrary): string {
  const code = room.spaceCode || room.spaceNo || 'ROOM';
  const checkEntries = Object.entries(room.checks || {});
  const openSnags = (room.snags || []).filter(s => s.status === 'open');

  const buildWithLimits = (maxFinishes: number, maxMicrosPerFinish: number, maxSnags: number) => {
    const f = checkEntries.slice(0, maxFinishes).map(([fCode, st]) => {
      const micros = getRoomFinishMicroTasks(room, fCode, microLib);
      const doneM = micros.filter(m => m.status === 'done').length;
      const mList = micros.slice(0, maxMicrosPerFinish).map((m, idx) => [
        idx,
        m.name.slice(0, 22),
        statusShortCode(m.status)
      ]);
      return [
        fCode,
        finishCompactName(fCode).slice(0, 18),
        statusShortCode(st),
        doneM,
        micros.length,
        mList
      ];
    });

    const s = openSnags.slice(0, maxSnags).map(sn => [
      sn.id,
      (sn.trade || 'Gen').slice(0, 10),
      (sn.text || 'Snag').slice(0, 36),
      (sn.photos && sn.photos[0]) || ''
    ]);

    return JSON.stringify({
      id: room.id,
      c: code.slice(0, 12),
      n: (room.space || 'Room').slice(0, 28),
      l: room.level,
      z: room.zone || 0,
      p: getAllRoomPhotoItems(room).length,
      f,
      s
    });
  };

  let json = buildWithLimits(8, 5, 4);
  if (utf8Len(json) > 980) json = buildWithLimits(6, 3, 3);
  if (utf8Len(json) > 980) json = buildWithLimits(5, 2, 2);
  if (utf8Len(json) > 980) json = buildWithLimits(4, 0, 1);
  return json;
}

/**
 * Builds compact JSON state (<= 950 bytes UTF-8) for the Project KPI & Floor Progress HTML Widget.
 */
export function buildStatsWidgetState(stats: {
  totalRooms: number;
  roomsDone: number;
  roomsDonePct: number;
  checksTotal: number;
  checksDone: number;
  checksOngoing: number;
  checksPending: number;
  checksDonePct: number;
  openSnags: number;
  totalPhotos: number;
  byLevel: Record<
    number,
    { total: number; done: number; checksTotal: number; checksDone: number; snags: number }
  >;
}): string {
  const lv: Array<[number, number, number, number, number]> = [];
  for (let l = 0; l <= 8; l++) {
    const row = stats.byLevel[l];
    if (!row || row.total === 0) continue;
    const pct = row.checksTotal ? Math.round((row.checksDone / row.checksTotal) * 100) : 0;
    lv.push([l, row.done, row.total, pct, row.snags]);
  }
  const now = new Date();
  const hh = String((now.getUTCHours() + 4) % 24).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  return JSON.stringify({
    rD: stats.roomsDone,
    rT: stats.totalRooms,
    rP: stats.roomsDonePct,
    cD: stats.checksDone,
    cO: stats.checksOngoing,
    cP: stats.checksPending,
    cT: stats.checksTotal,
    cPct: stats.checksDonePct,
    sn: stats.openSnags,
    ph: stats.totalPhotos,
    t: `${hh}:${mm}`,
    lv
  });
}

/**
 * Self-contained Telegram Profile 1 HTML Widget for Interactive Room Dashboard.
 * Strict adherence to https://core.telegram.org/bots/widgets.md:
 * - < 4096 bytes after zlib level 9 compression
 * - Only Profile 1 HTML/CSS/JS
 * - Zero opacity/filter heavy elements
 * - Respects env(safe-area-inset-bottom) for corner timestamp
 */
export const ROOM_WIDGET_HTML = `<style>
body{margin:0;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));font-family:system-ui,sans-serif;color:var(--tg-theme-text-color)}
.hd{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px}
.bdg{font-family:ui-monospace,monospace;font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);border:0;cursor:pointer;user-select:text;-webkit-user-select:text}
.sub{font-size:11px;color:var(--tg-theme-hint-color);font-weight:600}
.ttl{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px}
.bar{height:6px;border-radius:3px;background:var(--tg-theme-secondary-bg-color);overflow:hidden;margin-bottom:8px;display:flex}
.bf-d{background:#10b981;height:100%;transition:width .25s}
.bf-o{background:#f59e0b;height:100%;transition:width .25s}
.tabs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:8px}
.tab{padding:5px 4px;font-size:11px;font-weight:700;border-radius:6px;border:1px solid var(--tg-theme-section-separator-color,#ccc);background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color);cursor:pointer;text-align:center}
.tab.on{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);border-color:var(--tg-theme-button-color)}
.row{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 8px;margin-bottom:4px;border-radius:8px;background:var(--tg-theme-secondary-bg-color)}
.rn{min-width:0;flex:1}
.rc{font-family:ui-monospace,monospace;font-size:12px;font-weight:700}
.rd{font-size:11px;color:var(--tg-theme-hint-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st{padding:4px 8px;border-radius:6px;border:0;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap}
.st-d{background:#10b981;color:#fff}
.st-o{background:#f59e0b;color:#fff}
.st-p{background:var(--tg-theme-bg-color);color:var(--tg-theme-hint-color);border:1px solid var(--tg-theme-section-separator-color,#ccc)}
.ft{display:flex;align-items:center;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--tg-theme-hint-color)}
.rf{padding:3px 8px;font-size:11px;border-radius:5px;border:0;background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-link-color);font-weight:600;cursor:pointer}
</style>
<div class="hd">
  <div><button class="bdg" id="codeBtn"></button> <span class="sub" id="loc"></span></div>
  <span class="sub" id="pct"></span>
</div>
<div class="ttl" id="ttl"></div>
<div class="bar"><div class="bf-d" id="bD"></div><div class="bf-o" id="bO"></div></div>
<div class="tabs">
  <button class="tab" id="tF"></button>
  <button class="tab" id="tM"></button>
  <button class="tab" id="tS"></button>
</div>
<div id="list"></div>
<div class="ft"><span id="msg">Tap any item to update live</span><button class="rf" id="syncBtn">↻ Sync</button></div>
<script>
const TW=window.TelegramWidget,$=id=>document.getElementById(id);
let tab='f',cached=null;
function getS(){
  try{
    const raw=(TW&&(TW.chatData||TW.publicData))||null;
    if(raw)cached=JSON.parse(raw);
  }catch{}
  return cached||{id:'',c:'ROOM',n:'Loading...',l:0,z:0,p:0,f:[],s:[]};
}
function hap(t){try{TW&&TW.HapticFeedback&&TW.HapticFeedback.impactOccurred(t||'light')}catch{}}
function req(d){
  if(!TW)return;
  hap('light');
  $('msg').textContent='Saving to Supabase...';
  TW.request(d).then(a=>{
    if(a&&a.result){try{cached=JSON.parse(a.result)}catch{}}
    try{TW.HapticFeedback.notificationOccurred('success')}catch{}
    $('msg').textContent='✓ Synced live';
    draw();
  },e=>{
    $('msg').textContent=e.code==='NOT_ALLOWED'?'Open bot chat to edit':'Err: '+e.code;
  });
}
function stLbl(s){return s==='d'?'✓ DONE':s==='o'?'🔨 ONGOING':'⏳ PENDING'}
function draw(){
  const s=getS(),f=s.f||[],sn=s.s||[];
  const dCnt=f.filter(x=>x[2]==='d').length,oCnt=f.filter(x=>x[2]==='o').length,tot=f.length||1;
  let mTot=0,mDone=0;
  f.forEach(x=>{mDone+=x[3]||0;mTot+=x[4]||0});
  $('codeBtn').textContent='📋 '+s.c;
  $('codeBtn').onclick=()=>{try{hap('light');TW&&TW.copyText(s.c);$('msg').textContent='Copied '+s.c}catch{}};
  $('loc').textContent=(s.l===0?'GF':'L'+s.l)+' · Z'+(s.z||'All')+(s.p?' · 📷 '+s.p:'');
  $('pct').textContent=dCnt+'/'+f.length+' Done';
  $('ttl').textContent=s.n;
  $('bD').style.width=Math.round(dCnt/tot*100)+'%';
  $('bO').style.width=Math.round(oCnt/tot*100)+'%';
  $('tF').textContent='Finishes ('+dCnt+'/'+f.length+')';
  $('tM').textContent='Prep ('+mDone+'/'+mTot+')';
  $('tS').textContent='Snags ('+sn.length+')';
  $('tF').className='tab'+(tab==='f'?' on':'');
  $('tM').className='tab'+(tab==='m'?' on':'');
  $('tS').className='tab'+(tab==='s'?' on':'');
  $('tF').onclick=()=>{hap('light');tab='f';draw()};
  $('tM').onclick=()=>{hap('light');tab='m';draw()};
  $('tS').onclick=()=>{hap('light');tab='s';draw()};
  $('syncBtn').onclick=()=>req('wr:'+s.id);
  const nodes=[];
  if(tab==='f'){
    f.forEach(x=>{
      const r=document.createElement('div');r.className='row';
      const pr=x[4]>0?' · 🔧 '+x[3]+'/'+x[4]:'';
      r.innerHTML='<div class="rn"><div class="rc">'+x[0]+'</div><div class="rd">'+x[1]+pr+'</div></div>';
      const b=document.createElement('button');
      b.className='st st-'+x[2];b.textContent=stLbl(x[2]);
      b.onclick=()=>req('wf:'+s.id+':'+x[0]);
      r.appendChild(b);nodes.push(r);
    });
  }else if(tab==='m'){
    f.forEach(x=>{
      const ms=x[5]||[];
      if(ms.length>1&&x[3]<x[4]){
        const ar=document.createElement('div');ar.className='row';
        ar.innerHTML='<div class="rn"><div class="rc">'+x[0]+' Prep ('+x[3]+'/'+x[4]+')</div></div>';
        const ab=document.createElement('button');
        ab.className='st st-d';ab.textContent='✓ All '+x[0]+' Prep';
        ab.onclick=()=>req('wa:'+s.id+':'+x[0]);
        ar.appendChild(ab);nodes.push(ar);
      }
      ms.forEach(m=>{
        const r=document.createElement('div');r.className='row';
        r.innerHTML='<div class="rn"><div class="rc">['+x[0]+'] '+m[1]+'</div></div>';
        const b=document.createElement('button');
        b.className='st st-'+m[2];b.textContent=stLbl(m[2]);
        b.onclick=()=>req('wm:'+s.id+':'+x[0]+':'+m[0]);
        r.appendChild(b);nodes.push(r);
      });
    });
    if(!nodes.length){
      const d=document.createElement('div');d.className='sub';d.textContent='No prep micro-tasks assigned.';nodes.push(d);
    }
  }else{
    sn.forEach(g=>{
      const r=document.createElement('div');r.className='row';
      const pUrl=g[3]?(g[3].indexOf('http')===0?g[3]:'https://ynrgbmssbilugflxtpfx.supabase.co/storage/v1/object/public/photos/'+g[3]+'.jpg'):'';
      const imgHtml=pUrl?'<a href="'+pUrl+'" target="_blank"><img src="'+pUrl+'" style="width:42px;height:42px;object-fit:cover;border-radius:6px;display:block"></a>':'';
      r.innerHTML=imgHtml+'<div class="rn"><div class="rc">⚠️ '+g[1]+(pUrl?' · 📸':'')+'</div><div class="rd">'+g[2]+'</div></div>';
      const b=document.createElement('button');
      b.className='st st-d';b.textContent='✓ Resolve';
      b.onclick=()=>req('ws:'+s.id+':'+g[0]);
      r.appendChild(b);nodes.push(r);
    });
    if(!nodes.length){
      const d=document.createElement('div');d.className='sub';d.textContent='🎉 Zero open snags in this room!';nodes.push(d);
    }
  }
  $('list').replaceChildren(...nodes);
}
if(TW){
  TW.onEvent('chatDataChanged',draw);
  TW.onEvent('publicDataChanged',draw);
  draw();
  TW.ready&&TW.ready();
}else{draw()}
</script>`;

/**
 * Self-contained Telegram Profile 1 HTML Widget for Live Project KPI & Floor Progress.
 */
export const STATS_WIDGET_HTML = `<style>
body{margin:0;padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));font-family:system-ui,sans-serif;color:var(--tg-theme-text-color)}
.hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
.ttl{font-size:14px;font-weight:700}
.sub{font-size:11px;color:var(--tg-theme-hint-color);font-weight:600}
.kpis{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:4px;margin-bottom:8px}
.kc{padding:6px;border-radius:8px;background:var(--tg-theme-secondary-bg-color);text-align:center}
.kv{font-family:ui-monospace,monospace;font-size:14px;font-weight:700}
.kl{font-size:10px;color:var(--tg-theme-hint-color)}
.lv{display:flex;align-items:center;gap:6px;padding:4px 6px;margin-bottom:3px;border-radius:6px;background:var(--tg-theme-secondary-bg-color);cursor:pointer;border:1px solid transparent}
.lv.on{border-color:var(--tg-theme-button-color)}
.ll{font-family:ui-monospace,monospace;font-size:11px;font-weight:700;width:24px}
.lb{flex:1;height:6px;border-radius:3px;background:var(--tg-theme-bg-color);overflow:hidden}
.lf{height:100%;background:var(--tg-theme-button-color);transition:width .25s}
.lp{font-family:ui-monospace,monospace;font-size:11px;font-weight:700;width:34px;text-align:right}
.ls{font-size:10px;color:var(--tg-theme-hint-color);width:68px;text-align:right}
.ft{display:flex;align-items:center;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--tg-theme-hint-color)}
.rf{padding:4px 10px;font-size:11px;border-radius:6px;border:0;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font-weight:700;cursor:pointer}
</style>
<div class="hd">
  <span class="ttl">🏗️ ECIT Live KPIs</span>
  <span class="sub" id="tm"></span>
</div>
<div class="kpis">
  <div class="kc"><div class="kv" id="kR">0%</div><div class="kl">Rooms</div></div>
  <div class="kc"><div class="kv" id="kC">0%</div><div class="kl">Finishes</div></div>
  <div class="kc"><div class="kv" id="kO">0</div><div class="kl">Ongoing</div></div>
  <div class="kc"><div class="kv" id="kS">0</div><div class="kl">Snags</div></div>
</div>
<div id="lvs"></div>
<div class="ft"><span id="info">Tap a floor for details</span><button class="rf" id="rfBtn">↻ Refresh</button></div>
<script>
const TW=window.TelegramWidget,$=id=>document.getElementById(id);
let sel=-1,cached=null;
function getS(){
  try{
    const raw=(TW&&(TW.chatData||TW.publicData))||null;
    if(raw)cached=JSON.parse(raw);
  }catch{}
  return cached||{rD:0,rT:0,rP:0,cD:0,cO:0,cP:0,cT:0,cPct:0,sn:0,ph:0,t:'',lv:[]};
}
function hap(){try{TW&&TW.HapticFeedback&&TW.HapticFeedback.impactOccurred('light')}catch{}}
function refresh(){
  if(!TW)return;
  hap();
  $('info').textContent='Refreshing KPIs...';
  TW.request('wstat:refresh').then(a=>{
    if(a&&a.result){try{cached=JSON.parse(a.result)}catch{}}
    try{TW.HapticFeedback.notificationOccurred('success')}catch{}
    $('info').textContent='✓ Updated live';
    draw();
  },e=>{$('info').textContent='Err: '+e.code});
}
function draw(){
  const s=getS();
  $('tm').textContent=s.rD+'/'+s.rT+' rooms · 📷 '+s.ph;
  $('kR').textContent=s.rP+'%';
  $('kC').textContent=s.cPct+'%';
  $('kO').textContent=s.cO;
  $('kS').textContent=s.sn;
  $('rfBtn').onclick=refresh;
  const rows=(s.lv||[]).map(r=>{
    const d=document.createElement('div'),lbl=r[0]===0?'GF':'L'+r[0];
    d.className='lv'+(sel===r[0]?' on':'');
    d.innerHTML='<span class="ll">'+lbl+'</span><div class="lb"><div class="lf" style="width:'+r[3]+'%"></div></div><span class="lp">'+r[3]+'%</span><span class="ls">'+r[1]+'/'+r[2]+(r[4]?' ⚠️'+r[4]:'')+'</span>';
    d.onclick=()=>{
      hap();sel=r[0];
      $('info').textContent=lbl+': '+r[1]+'/'+r[2]+' rooms done ('+r[3]+'% checks)'+(r[4]?' · '+r[4]+' snags':'');
      draw();
    };
    return d;
  });
  $('lvs').replaceChildren(...rows);
}
if(TW){
  TW.onEvent('chatDataChanged',draw);
  TW.onEvent('publicDataChanged',draw);
  draw();
  TW.ready&&TW.ready();
}else{draw()}
</script>`;

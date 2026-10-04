(function(){
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const WD = ['일','월','화','수','목','금','토'];
const p2 = n => String(n).padStart(2,'0');
function fmt(iso){ if(!iso) return ''; const d = new Date(iso); return `${p2(d.getMonth()+1)}.${p2(d.getDate())}(${WD[d.getDay()]}) ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function fmtDate(ymd){ if(!ymd) return ''; const [y,m,d] = ymd.split('-'); return `${m}.${d}(${WD[new Date(+y,m-1,+d).getDay()]})`; }
function ymd(d){ return `${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}`; }
const now = () => new Date().toISOString();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,6);
function lsGet(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
function lsSet(k,v){ try { localStorage.setItem(k,v); return true; } catch(e){ return false; } }

const COMPANY = '선민종합관리';
const ST = {
  received:{label:'접수', chip:'지시 대기'},
  assigned:{label:'지시', chip:'지시됨'},
  progress:{label:'처리중', chip:'처리중'},
  done:{label:'처리완료', chip:'회신 대기'},
  replied:{label:'회신완료', chip:'회신완료'}
};
const ORDER = ['received','assigned','progress','done','replied'];
const CATS = ['시설','전기','설비(급배수)','승강기','소음·층간','주차','청소·미화','보안·경비','관리비','기타'];
const CHANNELS = ['전화','방문','문자','인터폰','게시판'];
const METHODS = ['인터폰','방문','전화','문자','카톡','안내문 부착'];

/* ---------- 저장소 ----------
 * 서버: Supabase(PostgreSQL). config.js에 주소와 키를 넣으면 로그인한 모든 기기가 같은 데이터를 본다.
 *   complaints(민원) · events(처리 내역, 추가만 함) · staff(직원) · settings(설정) 네 표를 쓰고,
 *   다른 기기의 변경은 실시간(Realtime)으로 받는다. 표 구조는 supabase/schema.sql.
 * 설정 전: 이 기기 브라우저(localStorage)에만 저장한다. */
const KEY = 'sunmin.minwon.v1';
const LOGO_KEY = 'sunmin.minwon.logo';
const MIGRATED_KEY = 'sunmin.minwon.migrated';
const REFRESH_MS = 60000;            // 실시간 연결이 끊겼을 때를 대비한 주기적 새로 고침
const DEFAULT_ORDER = '해당 호실 방문 및 처리 바랍니다';
const DEFAULT_SETTINGS = {company:COMPANY, buildingName:'', officePhone:'', defaultOrder:DEFAULT_ORDER};
const CFG = window.MINWON_CONFIG || {};
const SERVER = !!(CFG.supabaseUrl && CFG.supabaseKey);

const ROLE_LABEL = {hq:'본사 담당자', exec:'임원', manager:'관리소장', staff:'직원'};

const S = {
  role: lsGet('role') || 'manager', filter:'open', q:'', selectedId:null, panel:null,
  me: lsGet('meStaff'),
  /* db: 서버에서 받은 전체(권한 범위 안의 모든 사업장). complaints·staff·settings 는 지금 보는 사업장(site)만 */
  db:{complaints:[], staff:[], settings:{}, sites:[], users:[]},
  site:'main', complaints:[], staff:[], settings:Object.assign({}, DEFAULT_SETTINGS),
  logo: lsGet(LOGO_KEY) || '',
  sync:{state:'', at:null, msg:''},
  user:null, authReady:!SERVER, access:SERVER ? {} : {role:'manager', site_id:'main'},
  hq:false, oldSchema:false, canManage:true, lockMe:false
};

const siteOf = x => x.site || 'main';
const siteName = id => { const st = S.db.sites.find(x => x.id === (id || S.site)); return st ? st.name : (S.settings.buildingName || ''); };
function emptyData(){ return {complaints:[], staff:[], settings:{}, sites:[{id:'main', name:'사업장 1'}], users:[]}; }
/* 지금 보는 사업장의 기록(백업·이 기기 저장용) */
function snapshot(){ return {complaints:S.complaints, staff:S.staff, settings:S.settings}; }
function applyData(d){
  d = d || emptyData();
  S.db = {complaints:d.complaints || [], staff:d.staff || [], settings:d.settings || {}, sites:d.sites || [], users:d.users || []};
  if(!S.db.sites.length) S.db.sites = [{id:'main', name:'사업장 1'}];
  deriveSite();
}
/* S.site 가 가리키는 사업장의 민원·직원·설정만 골라낸다(같은 객체를 가리키므로 고치면 db에도 반영) */
function deriveSite(){
  if(!S.db.sites.some(x => x.id === S.site)) S.site = S.db.sites[0].id;
  S.complaints = S.db.complaints.filter(c => siteOf(c) === S.site);
  S.staff = S.db.staff.filter(x => siteOf(x) === S.site);
  S.settings = Object.assign({}, DEFAULT_SETTINGS, S.db.settings[S.site]);
  delete S.settings.logo; delete S.settings.photoRepo;
}
function readLocal(){ try { return JSON.parse(lsGet(KEY) || 'null'); } catch(e){ return null; } }
function loadLocal(){
  const d = readLocal() || {};
  applyData({complaints:d.complaints, staff:d.staff, settings:{main:d.settings || {}},
    sites:[{id:'main', name:(d.settings && d.settings.buildingName) || '사업장 1'}]});
}
function persist(){
  if(SERVER) return;
  if(!lsSet(KEY, JSON.stringify(snapshot()))) throw {code:'quota_exceeded'};
}
const byAt = (a, b) => (a.at || '').localeCompare(b.at || '');

function renderSync(){
  const el = $('#sync'); if(!el) return;
  el.hidden = !(SERVER && S.user);
  el.className = 'sync ' + (S.sync.state || '');
  const t = S.sync.at ? `${p2(S.sync.at.getHours())}:${p2(S.sync.at.getMinutes())}` : '';
  el.textContent = S.sync.state === 'saving' ? (S.sync.msg || '저장 중…') : S.sync.state === 'error' ? `연결 오류: ${S.sync.msg}` : `서버 연결됨 ${t}`;
  el.title = '누르면 지금 바로 새로 고칩니다';
}
function setSync(state, msg){ S.sync.state = state; S.sync.msg = msg || ''; if(state === 'ok') S.sync.at = new Date(); renderSync(); }

/* ---------- 서버(Supabase) ---------- */
let sb = null;
function sbErr(error){
  const m = String(error && (error.message || error.error_description || error) || '');
  const e = new Error(m);
  e.code = /gone/.test(m) ? 'gone'
    : /forbidden|row-level security|permission denied|403/i.test(m) ? 'forbidden'
    : /JWT|not authenticated|401/i.test(m) ? 'auth'
    : /Failed to fetch|NetworkError|network/i.test(m) ? 'network' : 'server';
  return e;
}
async function q(promise){ const {data, error} = await promise; if(error) throw sbErr(error); return data; }

async function fetchAll(table){
  const rows = [], key = table === 'app_users' ? 'email' : 'id';
  for(let from = 0; ; from += 1000){
    const data = await q(sb.from(table).select('*').order(key).range(from, from + 999));
    rows.push(...data);
    if(data.length < 1000) return rows;
  }
}
const rowToComplaint = r => Object.assign({}, r.data, {id:r.id, site:r.site_id || 'main', events:[]});
const rowToEvent = r => Object.assign({}, r.data, {id:r.id});
const rowToStaff = r => Object.assign({}, r.data, {id:r.id, site:r.site_id || 'main'});
const rowToSite = r => ({id:r.id, name:r.name, archived:!!r.archived, staffToken:r.staff_token || '', createdAt:r.created_at});
const rowToUser = r => ({email:r.email, role:r.role, site:r.site_id, name:r.name || ''});
const bySiteName = (a, b) => (a.archived - b.archived) || a.name.localeCompare(b.name, 'ko');
function assemble(cRows, eRows, sRows, setRows, siteRows, userRows){
  const map = new Map(cRows.map(r => [r.id, rowToComplaint(r)]));
  eRows.forEach(r => { const c = map.get(r.complaint_id); if(c) c.events.push(rowToEvent(r)); });
  map.forEach(c => c.events.sort(byAt));
  return {
    complaints:[...map.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    staff:sRows.map(rowToStaff).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')),
    settings:Object.fromEntries(setRows.map(r => [r.id, r.data || {}])),
    sites:siteRows.map(rowToSite).sort(bySiteName),
    users:userRows.map(rowToUser).sort((a, b) => a.email.localeCompare(b.email))
  };
}
let loading = null;
function reload(){
  if(!sb || !S.user) return Promise.resolve();
  if(loading) return loading;
  loading = (async () => {
    try {
      const [c, e, s, st, si, us] = await Promise.all(['complaints', 'events', 'staff', 'settings', 'sites', 'app_users'].map(fetchAll));
      applyData(assemble(c, e, s, st, si, us));
      checkNew();
      setSync('ok');
      render();
    } catch(err){
      console.error(err);
      setSync('error', err.code === 'auth' ? '로그인이 필요합니다' : err.code === 'network' ? '인터넷 연결 없음' : '불러오기 실패: ' + err.message.slice(0, 80));
    } finally { loading = null; }
  })();
  return loading;
}
let reloadT;
function scheduleReload(){ clearTimeout(reloadT); reloadT = setTimeout(reload, 300); }

/* 실시간: 다른 기기의 변경을 받아 바로 반영한다(내 변경의 메아리는 id로 걸러진다) */
function applyChange(table, p){
  const row = p.new && Object.keys(p.new).length ? p.new : null, old = p.old || {};
  const db = S.db;
  if(table === 'complaints'){
    if(p.eventType === 'DELETE') db.complaints = db.complaints.filter(c => c.id !== old.id);
    else { const cur = db.complaints.find(c => c.id === row.id); if(cur) Object.assign(cur, row.data, {site:row.site_id || cur.site}); else db.complaints.unshift(rowToComplaint(row)); }
  } else if(table === 'events'){
    if(p.eventType !== 'INSERT') return scheduleReload();
    const c = db.complaints.find(x => x.id === row.complaint_id);
    if(!c) return scheduleReload();
    if(!c.events.some(e => e.id === row.id)){ c.events.push(rowToEvent(row)); c.events.sort(byAt); }
  } else if(table === 'staff'){
    if(p.eventType === 'DELETE') db.staff = db.staff.filter(s => s.id !== old.id);
    else { const i = db.staff.findIndex(s => s.id === row.id); if(i >= 0) db.staff[i] = rowToStaff(row); else db.staff.push(rowToStaff(row)); }
  } else if(table === 'settings'){
    if(p.eventType === 'DELETE') delete db.settings[old.id]; else if(row) db.settings[row.id] = row.data || {};
  } else if(table === 'sites'){
    if(p.eventType === 'DELETE') db.sites = db.sites.filter(x => x.id !== old.id);
    else { const i = db.sites.findIndex(x => x.id === row.id); if(i >= 0) db.sites[i] = rowToSite(row); else db.sites.push(rowToSite(row)); db.sites.sort(bySiteName); }
  } else if(table === 'app_users'){
    if(p.eventType === 'DELETE') db.users = db.users.filter(u => u.email !== old.email);
    else { const i = db.users.findIndex(u => u.email === row.email); if(i >= 0) db.users[i] = rowToUser(row); else db.users.push(rowToUser(row)); }
  }
  if(table === 'complaints') checkNew();
  deriveSite();
  setSync('ok');
  render();
}

/* ---------- 새 민원 소리 알림 ----------
   다른 사람이 새 민원을 접수하면 소리·진동·상단 알림띠로 알린다. 앱(화면)이 열려 있는 동안 동작한다.
   브라우저 규칙상 소리는 화면을 한 번 건드린 뒤부터 나고, 앱이 완전히 꺼진 상태에서는 울릴 수 없다. */
let knownIds = null;                 // 이미 본 민원 id (처음 불러올 때는 알리지 않음)
const mineIds = new Set();           // 내가 접수한 민원은 알리지 않음
let audioCtx = null, audioReady = false;
let callQueue = [];
const alertOn = () => { const v = lsGet('alertSound'); return v == null ? !S.allSites : v === '1'; };   // 본사·임원은 기본 꺼짐
function unlockAudio(){
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume();
    audioReady = true;
  }catch(e){}
  renderBell();
}
document.addEventListener('pointerdown', () => { if(!audioReady) unlockAudio(); }, {once:false, passive:true});
function chime(){
  if(!audioCtx) return;
  try{
    const t0 = audioCtx.currentTime + 0.02;
    const notes = [659.25, 783.99, 1046.5];                       // 미 · 솔 · 도
    [0, 1.3].forEach(rep => notes.forEach((f, i) => {
      const t = t0 + rep + i * 0.28, o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(g); g.connect(audioCtx.destination); o.start(t); o.stop(t + 0.75);
    }));
  }catch(e){}
}
function placeOf(c){ return c.location || [c.dong, c.ho].filter(Boolean).join(' ') || ''; }
function notifyNew(list){
  if(!alertOn() || !list.length) return;
  chime();
  try{ if(navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]); }catch(e){}
  callQueue = callQueue.concat(list);
  renderCall();
  const c = list[list.length - 1];
  const text = `${S.allSites ? siteName(siteOf(c)) + ' · ' : ''}${placeOf(c)} ${c.category || ''} ${c.title || ''}`.trim();
  if(document.hidden){
    document.title = `(${callQueue.length}) 새 민원 접수 · ${document.title.replace(/^\(\d+\) 새 민원 접수 · /, '')}`;
    if('Notification' in window && Notification.permission === 'granted'){
      const opt = {body:text, tag:'minwon-new', renotify:true, vibrate:[300, 150, 300], icon:'icon-192.png'};
      navigator.serviceWorker && navigator.serviceWorker.ready ? navigator.serviceWorker.ready.then(r => r.showNotification('새 민원 접수', opt)).catch(() => { try{ new Notification('새 민원 접수', opt); }catch(e){} }) : (() => { try{ new Notification('새 민원 접수', opt); }catch(e){} })();
    }
  }
}
function renderCall(){
  const el = $('#newcall'); if(!el) return;
  if(!callQueue.length){ el.hidden = true; return; }
  const c = callQueue[callQueue.length - 1], more = callQueue.length - 1;
  el.hidden = false;
  el.innerHTML = `<span class="nc-ico" aria-hidden="true">🔔</span><span class="nc-text"><b>새 민원 접수${more ? ` 외 ${more}건` : ''}</b>${S.allSites ? esc(siteName(siteOf(c))) + ' · ' : ''}${esc(placeOf(c))} ${esc(c.category || '')} ${esc(c.title || '')}</span><button type="button" class="btn sm" data-act="call-open" data-id="${esc(c.id)}">확인</button>`;
}
/* 새로 생긴 민원이 있으면 알린다. 접수한 지 30분이 넘은 것(복원·오래 꺼져 있던 뒤)은 알리지 않는다 */
function checkNew(){
  if(!SERVER || !S.user) return;
  const ids = S.db.complaints.map(c => c.id);
  if(knownIds === null){ knownIds = new Set(ids); return; }
  const fresh = S.db.complaints.filter(c => !knownIds.has(c.id) && !mineIds.has(c.id) && Date.now() - new Date(c.createdAt || 0).getTime() < 30 * 60000);
  ids.forEach(id => knownIds.add(id));
  if(fresh.length) notifyNew(fresh);
}
function renderBell(){
  const b = $('#bell'); if(!b) return;     // 알림 버튼은 없앰(소장·직원은 항상 켜짐, 본사·임원은 꺼짐)
  b.hidden = !(SERVER && S.user);
  const on = alertOn();
  b.textContent = on ? '🔔 알림 켜짐' : '🔕 알림 꺼짐';
  b.classList.toggle('off', !on);
  b.setAttribute('aria-pressed', on);
}
let channel = null;
function subscribe(){
  if(channel) sb.removeChannel(channel);
  channel = sb.channel('minwon');
  ['complaints', 'events', 'staff', 'settings', 'sites', 'app_users'].forEach(t =>
    channel.on('postgres_changes', {event:'*', schema:'public', table:t}, p => applyChange(t, p)));
  channel.subscribe(status => {
    if(status === 'SUBSCRIBED') reload();            // 다시 연결되면 그사이 바뀐 것까지 받는다
    else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') setSync('error', '실시간 연결 끊김 · 1분마다 새로 고침');
  });
}
setInterval(() => { if(document.visibilityState === 'visible') reload(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible'){ document.title = document.title.replace(/^\(\d+\) 새 민원 접수 · /, ''); reload(); } });
window.addEventListener('online', () => reload());

async function write(fn){
  if(!SERVER) return fn();
  setSync('saving');
  try { const r = await fn(); setSync('ok'); return r; }
  catch(e){ setSync('error', e.code === 'network' ? '인터넷 연결 없음' : '저장 실패'); throw e; }
}
const chunks = (arr, n) => Array.from({length:Math.ceil(arr.length / n)}, (_, i) => arr.slice(i * n, i * n + n));

/* 백업이나 이 기기 기록을 서버에 합친다(같은 id는 덮어씀) */
async function importToServer(d){
  d = await migrateLocalPhotos(clone(d));
  const cRows = [], eRows = [];
  const site = S.site;
  (d.complaints || []).forEach(c => {
    const {events, id, site:_s, ...data} = c;
    cRows.push({id, site_id:site, data});
    (events || []).forEach(e => { const {id:eid, ...ed} = e; eRows.push({id:eid || uid(), complaint_id:id, site_id:site, data:ed}); });
  });
  const sRows = (d.staff || []).map(s => { const {id, site:_s, ...data} = s; return {id, site_id:site, data}; });
  for(const part of chunks(sRows, 500)) await q(sb.from('staff').upsert(part));
  for(const part of chunks(cRows, 500)) await q(sb.from('complaints').upsert(part));
  for(const part of chunks(eRows, 500)) await q(sb.from('events').upsert(part));
  if(d.settings){ const st = Object.assign({}, d.settings); delete st.logo; delete st.photoRepo; await q(sb.rpc('merge_settings', {patch:st, sid:site})); }
}
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- 사진 ----------
 * 휴대폰 사진은 올리기 전에 줄인다(긴 변 1280px, JPEG).
 * 서버 사용 시 Supabase Storage의 photos 버킷(비공개)에, 아니면 이 기기(IndexedDB)에 저장한다.
 * 처리 내역(event)에는 사진 위치만 photos:[...]로 남긴다. */
const PHOTO_MAX = 1280, PHOTO_Q = 0.72, PHOTO_LIMIT = 6;
const PHOTO_AVG_MB = 0.15, STORAGE_FREE_MB = 1024;   // 무료 요금제 사진 저장 한도 1GB
let pendingPhotos = [];              // 아직 올리지 않은 선택 사진 {blob, url}
const photoCache = new Map();        // 사진 위치 → 화면용 주소

function compressPhoto(file){
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('image')); };
    img.onload = () => {
      URL.revokeObjectURL(src);
      const scale = Math.min(1, PHOTO_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(b => b ? resolve(b) : reject(new Error('encode')), 'image/jpeg', PHOTO_Q);
    };
    img.src = src;
  });
}
const idb = {
  db:null,
  open(){
    if(this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('sunmin-minwon-photos', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(mode, fn){
    const db = await this.open();
    return new Promise((res, rej) => { const t = db.transaction('photos', mode); const q = fn(t.objectStore('photos')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); });
  },
  put(id, blob){ return this.tx('readwrite', st => st.put(blob, id)); },
  get(id){ return this.tx('readonly', st => st.get(id)); }
};
async function uploadPhoto(path, blob){
  await q(sb.storage.from('photos').upload(path, blob, {contentType:'image/jpeg', upsert:false}));
  return 'sb:' + path;
}
async function savePhoto(blob, cid){
  const name = `${ymd(new Date())}-${uid()}.jpg`;
  let ref;
  if(SERVER) ref = await uploadPhoto(`${cid}/${name}`, blob);
  else { ref = `local:${cid}/${name}`; await idb.put(ref, blob); }
  photoCache.set(ref, URL.createObjectURL(blob));
  return ref;
}
async function photoURL(ref){
  if(photoCache.has(ref)) return photoCache.get(ref);
  let blob;
  if(ref.startsWith('local:')) blob = await idb.get(ref);
  else if(ref.startsWith('sb:') && sb) blob = await q(sb.storage.from('photos').download(ref.slice(3)));
  if(!blob) throw new Error('missing');
  const url = URL.createObjectURL(blob);
  photoCache.set(ref, url);
  return url;
}
async function uploadPending(cid){
  const refs = [];
  for(let i = 0; i < pendingPhotos.length; i++){
    if(SERVER) setSync('saving', `사진 올리는 중 ${i + 1}/${pendingPhotos.length}`);
    refs.push(await savePhoto(pendingPhotos[i].blob, cid));
  }
  return refs;
}
function clearPending(){ pendingPhotos.forEach(p => URL.revokeObjectURL(p.url)); pendingPhotos = []; }
function hydratePhotos(root){
  root.querySelectorAll('img[data-photo]:not([src])').forEach(img => {
    photoURL(img.dataset.photo).then(u => { img.src = u; }).catch(() => { img.alt = '사진을 불러오지 못했습니다'; img.closest('.thumb').classList.add('broken'); });
  });
}
function photoPicker(hint){
  return `<div class="fld"><span>사진 <span class="hint">(${pendingPhotos.length}/${PHOTO_LIMIT}${hint ? ' · ' + hint : ''})</span></span>
    <div class="thumbs">${pendingPhotos.map((p, i) => `<span class="thumb"><img src="${p.url}" alt="선택한 사진 ${i + 1}"><button type="button" class="x" data-act="photo-remove" data-i="${i}" aria-label="사진 빼기">×</button></span>`).join('')}
    ${pendingPhotos.length < PHOTO_LIMIT ? `<label class="thumb add"><span>＋<br>사진</span><input type="file" id="photo-input" accept="image/*" multiple hidden></label>` : ''}</div></div>`;
}
function thumbsHTML(refs){
  return refs && refs.length ? `<div class="thumbs">${refs.map(r => `<button type="button" class="thumb" data-act="photo-view" data-ref="${esc(r)}"><img data-photo="${esc(r)}" alt="사진"></button>`).join('')}</div>` : '';
}
/* 이 기기에 저장된 사진을 서버로 옮기고 사진 위치를 바꾼다 */
async function migrateLocalPhotos(d){
  for(const c of (d.complaints || [])) for(const ev of (c.events || [])){
    if(!ev.photos) continue;
    for(let i = 0; i < ev.photos.length; i++){
      const ref = ev.photos[i];
      if(!ref.startsWith('local:')) continue;
      const blob = await idb.get(ref).catch(() => null);
      if(blob) ev.photos[i] = await uploadPhoto(ref.slice(6), blob);
    }
  }
  return d;
}
function photoTotal(){ return S.complaints.reduce((n, c) => n + photoCount(c), 0); }

const store = {
  async addComplaint(data, id){
    id = id || uid();
    mineIds.add(id);
    const {events, ...fields} = data;
    if(SERVER) await write(() => q(sb.rpc('add_complaint', {cid:id, cdata:fields, evs:events, sid:S.site})));
    if(!S.db.complaints.some(c => c.id === id)){ S.db.complaints.unshift(Object.assign({id, site:S.site}, data)); deriveSite(); }
    persist();
    return id;
  },
  /* patch는 덮어쓸 값, ev는 처리 내역에 덧붙일 기록 */
  async update(id, patch, ev){
    patch = Object.assign({}, patch, {updatedAt:now()});
    if(SERVER) await write(() => q(sb.rpc('apply_action', {cid:id, patch, ev:ev || null})));
    const c = find(id);
    if(!c){ if(SERVER) return; throw {code:'gone'}; }
    Object.assign(c, patch);
    if(ev && !c.events.some(x => x.id === ev.id)) c.events.push(ev);
    persist();
  },
  async remove(id){
    if(SERVER) await write(() => q(sb.from('complaints').delete().eq('id', id)));
    S.db.complaints = S.db.complaints.filter(c => c.id !== id); deriveSite(); persist();
  },
  async addStaff(data){
    const id = uid();
    if(SERVER) await write(() => q(sb.from('staff').insert({id, site_id:S.site, data})));
    if(!S.db.staff.some(s => s.id === id)){ S.db.staff.push(Object.assign({id, site:S.site}, data)); deriveSite(); }
    persist();
  },
  async removeStaff(id){
    if(SERVER) await write(() => q(sb.from('staff').delete().eq('id', id)));
    S.db.staff = S.db.staff.filter(s => s.id !== id); deriveSite(); persist();
  },
  async saveSettings(data){
    if(SERVER) await write(() => q(sb.rpc('merge_settings', {patch:data, sid:S.site})));
    S.db.settings[S.site] = Object.assign({}, S.db.settings[S.site], data); deriveSite(); persist();
  },
  async importBackup(d){
    if(SERVER){ await write(() => importToServer(d)); await reload(); return; }
    applyData({complaints:d.complaints, staff:d.staff, settings:{main:d.settings || {}}, sites:S.db.sites}); persist();
  },
  /* 본사: 사업장·계정 관리 */
  async saveSite(site){
    await write(() => q(sb.from('sites').upsert({id:site.id, name:site.name, archived:!!site.archived})));
    const i = S.db.sites.findIndex(x => x.id === site.id);
    if(i >= 0) Object.assign(S.db.sites[i], site); else S.db.sites.push(Object.assign({archived:false}, site));
    S.db.sites.sort(bySiteName); deriveSite();
  },
  async saveUser(u){
    await write(() => q(sb.from('app_users').upsert({email:u.email, role:u.role, site_id:u.role === 'manager' ? u.site : null, name:u.name || null})));
    const i = S.db.users.findIndex(x => x.email === u.email);
    if(i >= 0) S.db.users[i] = u; else S.db.users.push(u);
    S.db.users.sort((a, b) => a.email.localeCompare(b.email));
  },
  async removeUser(email){
    const ok = await write(() => q(sb.rpc('remove_login', {p_email:email})));
    S.db.users = S.db.users.filter(x => x.email !== email);
    if(ok === false) toast('역할은 해제했지만 로그인 계정은 지우지 못했습니다. Supabase → Authentication → Users 에서 직접 지워 주세요.');
  },
  resetPassword(email, pw){ return write(() => q(sb.rpc('set_login_password', {p_email:email, p_password:pw}))); },
  /* 본사가 앱에서 로그인 계정을 만든다. 내 로그인이 바뀌지 않도록 별도 클라이언트로 가입시킨다 */
  async createLogin(email, pw){
    const tmp = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {auth:{persistSession:false, autoRefreshToken:false, detectSessionInUrl:false}});
    const {data, error} = await tmp.auth.signUp({email, password:pw});
    if(error){
      if(/already|registered|exists/i.test(error.message)) return 'exists';
      const e = new Error(error.message); e.code = /signups? not allowed|disabled/i.test(error.message) ? 'signup_off' : 'server'; throw e;
    }
    if(data && data.user && !data.session && (data.user.identities || []).length === 0) return 'exists';   // 이미 있는 이메일(확인 메일 켜진 경우의 응답)
    return data && data.session ? 'created' : 'unconfirmed';
  },
  async rotateStaffLink(){
    const t = await write(() => q(sb.rpc('rotate_staff_link', {sid:S.site})));
    const st = S.db.sites.find(x => x.id === S.site); if(st) st.staffToken = t;
    return t;
  }
};

const find = id => S.complaints.find(c => c.id === id);
const staffName = id => { const s = S.db.staff.find(x => x.id === id); return s ? s.name : (id ? '(명단에서 삭제된 직원)' : '미배정'); };
/* 담당 직원: 여러 명 가능(assignees). 예전 기록은 assignee 한 명만 있으므로 함께 처리한다 */
const assigneesOf = c => (c.assignees && c.assignees.length) ? c.assignees : (c.assignee ? [c.assignee] : []);
const namesOf = c => { const a = assigneesOf(c); return a.length ? a.map(staffName).join(', ') : '미배정'; };
const evNames = e => (e.staffIds && e.staffIds.length ? e.staffIds : [e.staffId]).map(staffName).join(', ');
/* 마지막 (재)지시 이후 완료 보고를 올린 직원들. 모든 담당자가 보고해야 '처리완료(회신 대기)'가 된다 */
function doneBy(c){
  const evs = c.events || []; let from = -1;
  evs.forEach((e, k) => { if(e.type === 'assigned' || e.type === 'rework' || (e.type === 'reassigned' && e.restart)) from = k; });
  return new Set(evs.slice(from + 1).filter(e => e.type === 'done').map(e => e.staffId));
}
const lastEv = (c, type) => (c.events || []).filter(e => e.type === type).slice(-1)[0];
const isOverdue = c => c.due && (c.status === 'assigned' || c.status === 'progress') && c.due < ymd(new Date());
function numbers(){
  const m = {};
  [...S.complaints].sort((a,b) => (a.createdAt||'').localeCompare(b.createdAt||'')).forEach((c,i) => m[c.id] = i+1);
  return m;
}

/* ---------- 보기 ---------- */
function base(){
  if(S.role === 'staff') return S.me ? S.complaints.filter(c => assigneesOf(c).includes(S.me) || c.receivedBy === S.me) : [];
  return S.complaints;
}
function filtered(){
  let b = base();
  if(S.role === 'staff' && S.filter === 'received') S.filter = 'open';       // 직원은 '지시 대기'를 쓰지 않는다(내가 접수한 건은 소장 지시를 기다릴 뿐)
  if(S.filter === 'open') b = b.filter(c => c.status !== 'replied' && !(S.role === 'staff' && c.status === 'received'));
  else if(S.filter !== 'all') b = b.filter(c => c.status === S.filter);
  const q = S.q.trim();
  if(q) b = b.filter(c => [c.title, c.detail, c.location, c.category, assigneesOf(c).map(staffName).join(' ')].some(v => String(v || '').includes(q)));
  return b;
}

function renderBrand(){
  const s = S.settings;
  const img = $('#logo'), mark = $('#logo-mark');
  const src = S.logo || 'logo.svg';
  if(img.dataset.src !== src){
    img.dataset.src = src;
    img.onload = () => { img.hidden = false; mark.hidden = true; };
    img.onerror = () => { img.hidden = true; mark.hidden = false; };
    img.src = src;
  }
  const bn = SERVER && !S.user ? '' : (s.buildingName || (SERVER ? siteName() : ''));
  // 관리소장·직원 화면: 회사명 대신 '사무소 이름 + 관리단'. 본사·임원은 회사명 그대로
  const signedIn = !SERVER || !!S.user;
  let office = signedIn && !S.allSites && bn ? (/관리단$/.test(bn.trim()) ? bn.trim() : `${bn.trim()} 관리단`) : '';
  const shown = office;                    // 로그인 화면(로그인 전)은 항상 선민종합관리(주)
  $('#co-name').textContent = shown || s.company || COMPANY;
  $('#foot-name').textContent = shown || '선민종합관리(주)';
  $('#bc-name').textContent = shown || '선민종합관리(주)';
  $('#bname').textContent = S.panel === 'hq' ? '본사 · 전체 사업장' : bn ? `${bn} 관리사무소` : '접수 · 지시 · 보고 · 회신';
  document.title = `${shown || s.company || COMPANY} 민원관리 System`;
}

/* 로그인 계정에 따라 관리소장 화면 허용 여부와 '나는' 직원을 정한다.
 * 역할·사업장은 서버(app_users 표)가 정하고, 서버도 같은 기준으로 쓰기를 막는다. */
function applyAccount(){
  const email = (S.user && S.user.email || '').toLowerCase();
  const a = S.access || {};
  S.hq = SERVER && a.role === 'hq';
  S.exec = SERVER && a.role === 'exec';          // 임원: 전체 사업장 열람만
  S.allSites = S.hq || S.exec;
  S.canManage = !SERVER || S.hq || (a.role === 'manager' && a.site_id === S.site);
  if(!S.allSites && S.panel === 'hq') S.panel = null;
  S.mgrOnly = SERVER && S.canManage && !S.allSites;   // 관리소장 로그인: 직원 화면 전환 없이 관리소장 화면만
  if(S.mgrOnly) S.role = 'manager';
  if(!S.canManage){
    S.role = S.exec ? 'manager' : 'staff';         // 임원은 관리소장 화면을 읽기 전용으로 본다
    if(S.panel === 'settings' || (S.panel === 'report' && !S.exec)) S.panel = null;
  }
  const st = email && S.staff.find(x => (x.email || '').toLowerCase() === email);
  S.lockMe = !!st;
  if(st) S.me = st.id;
}

/* 홈 화면(바탕화면) 아이콘: 직원 링크로 들어온 기기, 또는 설치 가능한 브라우저에서 */
const UA = navigator.userAgent;
const inKakao = /KAKAOTALK/i.test(UA);
const inAppBrowser = inKakao || /NAVER\(inapp|Instagram|FBAN|FBAV|Line\//i.test(UA);
const isIOS = /iPhone|iPad|iPod/.test(UA);
/* 설치 시 열릴 주소(start_url)에 직원 링크 토큰을 담기 위해 매니페스트를 그때그때 만든다 */
function setManifest(){
  if(location.protocol !== 'https:') return;
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const m = {name:'선민종합관리 민원관리 System', short_name:'민원관리', display:'standalone', background_color:'#EEF1F6', theme_color:'#1E3A7B', lang:'ko',
    start_url:location.origin + location.pathname + (/^#staff=/.test(location.hash) ? location.hash : ''), scope:base,
    icons:[{src:base + 'icon-192.png', sizes:'192x192', type:'image/png'}, {src:base + 'icon-512.png', sizes:'512x512', type:'image/png', purpose:'any maskable'}]};
  const link = document.querySelector('link[rel=manifest]');
  if(link) link.href = URL.createObjectURL(new Blob([JSON.stringify(m)], {type:'application/manifest+json'}));
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; lsSet('installDone', '1'); renderInstall(); });
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function renderInstall(){
  const el = $('#install'); if(!el) return;
  const linkStaff = SERVER && S.user && !S.user.email && S.access && S.access.role === 'staff';
  const show = S.user && !standalone() && !lsGet('installDismiss') && !lsGet('installDone') && (linkStaff || installEvt);
  el.hidden = !show;
  if(!show) return;
  let how, sub = `다음부터는 ${linkStaff ? '링크나 QR 없이 ' : ''}아이콘만 누르면 바로 열립니다.`;
  if(installEvt) how = '<button type="button" class="btn primary" data-act="install">바탕화면에 추가</button>';
  else if(inKakao){ how = '<button type="button" class="btn primary" data-act="open-browser">크롬(기본 브라우저)에서 열기</button>'; sub = '카톡 안에서는 바탕화면에 넣을 수 없습니다. 버튼을 눌러 브라우저로 열면 바로 추가할 수 있습니다.'; }
  else if(inAppBrowser){ how = ''; sub = '지금 앱 안의 브라우저에서 열려 있습니다. 오른쪽 위 메뉴에서 <b>다른 브라우저로 열기</b>(크롬·사파리)를 누른 뒤 바탕화면에 추가하세요.'; }
  else if(isIOS) how = '사파리 아래 <b>공유 버튼(⬆)</b> → <b>홈 화면에 추가</b> → <b>추가</b>';
  else how = '브라우저 메뉴(<b>⋮</b>) → <b>홈 화면에 추가</b>(또는 앱 설치) → <b>추가</b>';
  el.innerHTML = `<div><b>바탕화면에 아이콘 만들기</b><span class="hint">${sub}</span></div>
    <div class="btns">${how}<button type="button" class="btn sm" data-act="install-later">나중에</button></div>`;
}

function render(){
  renderBrand();
  renderInstall();
  renderSync();
  /* 직원 링크로 들어왔는데 연결에 실패한 경우: 로그인 화면 대신 이유를 보여준다 */
  const linkFail = SERVER && S.authReady && !S.user && !!S.linkError;
  const needLogin = SERVER && S.authReady && !S.user && !linkFail;
  document.body.classList.toggle('need-login', SERVER && !S.user && !linkFail);
  document.body.classList.toggle('no-access', linkFail);
  $('#login').hidden = !needLogin;
  $('#acct').hidden = !(SERVER && S.user);
  renderBell();
  if(linkFail){
    $('#no-access').hidden = false;
    $('#no-access .msg').innerHTML = `<strong>직원 접속 링크로 연결하지 못했습니다</strong>${esc(S.linkError)}`;
    return;
  }
  if(SERVER && !S.user) return;
  if(S.user) $('#acct').textContent = S.user.email ? `${S.user.email.split('@')[0]} · 로그아웃` : '직원 (링크 접속) · 연결 끊기';
  applyAccount();
  const noAccess = SERVER && S.user && !S.oldSchema && !(S.access && S.access.role);
  $('#no-access').hidden = !noAccess;
  if(noAccess){
    const anon = !S.user.email;
    $('#no-access .msg').innerHTML = anon
      ? `<strong>직원 접속 링크가 만료되었거나 잘못되었습니다</strong>${S.linkError ? esc(S.linkError) + '<br>' : ''}관리소장에게 새 접속 링크를 받아 다시 열어 주세요. 관리소장은 <b>직원·설정 → 직원 접속 링크</b>에서 만들 수 있습니다.`
      : `<strong>아직 사업장이 지정되지 않은 계정입니다</strong>본사 담당자가 「본사 → 계정 관리」에서 이 이메일(${esc(S.user.email)})의 역할과 사업장을 지정하면 바로 쓸 수 있습니다. 지정된 뒤에는 이 화면을 새로 고침하세요.`;
  }
  document.body.classList.toggle('no-access', noAccess);
  if(noAccess) return;
  const hqPanel = S.panel === 'hq';
  /* 휴대폰: 민원을 고르거나 접수·설정·보고 화면을 열면 전체 화면 시트로 띄우고, 뒤로 가기로 닫는다 */
  const sheet = isNarrow() && !hqPanel && !!(S.panel || S.selectedId);
  document.body.classList.toggle('sheet', sheet);
  $('#hq-tools').hidden = !S.allSites || hqPanel;
  document.body.classList.toggle('hq-mode', !!S.allSites && !hqPanel);
  document.body.classList.toggle('readonly', !!S.exec);
  if(S.allSites && !hqPanel) $('.hq-bar-note').textContent = S.exec ? '임원으로 이 사업장을 열람만 하고 있습니다(접수·지시·회신 불가). 본사 현황으로 돌아가려면 뒤로 가기 버튼을 누르거나 위 목록에서 \'본사 현황\'을 고르세요.' : '본사 담당자로 이 사업장의 관리소장 화면을 보고 있습니다. 본사 현황으로 돌아가려면 뒤로 가기 버튼을 누르거나 위 목록에서 \'본사 현황\'을 고르세요.';
  tipEl.hidden = true;
  const ss = $('#site-select');
  ss.innerHTML = '<option value="">← 본사 현황 (전체)</option>' + S.db.sites.filter(x => !x.archived || x.id === S.site).map(x => `<option value="${esc(x.id)}">${esc(x.name)}${x.archived ? ' (보관)' : ''}</option>`).join('');
  ss.value = S.site;
  $('.seg').hidden = hqPanel;
  $('#new-btn').hidden = hqPanel || !!S.exec;
  $('.seg').hidden = hqPanel || !!S.exec || !!S.mgrOnly;
  $('#mgr-tools [data-act=settings]').hidden = !!S.exec;
  $('.work').classList.toggle('single', hqPanel);
  $('#list').hidden = hqPanel;
  $('#summary').hidden = hqPanel;
  $('#role-manager').hidden = !S.canManage;
  $('#me-select').disabled = S.lockMe;
  $('#role-manager').setAttribute('aria-pressed', S.role === 'manager');
  $('#role-staff').setAttribute('aria-pressed', S.role === 'staff');
  $('#mgr-tools').hidden = S.role !== 'manager' || hqPanel;
  $('#staff-picker').hidden = S.role !== 'staff' || hqPanel;
  const sel = $('#me-select');
  sel.innerHTML = '<option value="">이름 선택</option>' + S.staff.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.duty ? ' · ' + esc(s.duty) : ''}</option>`).join('');
  sel.value = S.staff.some(s => s.id === S.me) ? S.me : '';

  const waiting = S.complaints.filter(c => c.status === 'done').length;
  const al = $('#reply-alert');
  al.hidden = !(S.role === 'manager' && waiting > 0) || hqPanel;
  al.innerHTML = `<span>직원 완료 보고가 올라왔습니다. 민원인에게 결과를 알려 주세요.</span><span>회신 대기 <b>${waiting}</b>건</span>`;

  const warn = S.role !== 'manager' ? '' : (SERVER && !S.hq) ? '' : !SERVER ? '서버가 아직 설정되지 않아 이 기기에만 저장됩니다. README의 「서버 설정」 안내를 따라 주세요.'
    : S.oldSchema ? '서버 설정이 아직 예전 버전입니다. Supabase SQL Editor에서 supabase/schema.sql을 다시 실행해 주세요. 그 전까지는 사업장 구분과 본사 기능이 동작하지 않습니다.' : storageWarn();
  const nt = $('#notice'); nt.hidden = !warn; nt.textContent = warn;

  renderSummary(); renderList(); renderDetail();
  syncHistory();
}

function renderSummary(){
  const b = base();
  const staffView = S.role === 'staff';
  const cnt = k => k === 'all' ? b.length : k === 'open' ? b.filter(c => c.status !== 'replied' && !(staffView && c.status === 'received')).length : b.filter(c => c.status === k).length;
  const keys = ['open', ...ORDER.filter(k => !(staffView && k === 'received')), 'all'];
  const searchVal = $('#q') ? $('#q').value : S.q;
  const hadFocus = document.activeElement && document.activeElement.id === 'q';
  $('#summary').innerHTML = '<div class="chips" role="group" aria-label="상태별 보기">' + keys.map(k => {
    const label = k === 'open' ? '미결' : k === 'all' ? '전체' : ST[k].chip;
    const dot = ST[k] ? `<i class="dot s-${k}"></i>` : '';
    const n = cnt(k);
    const attn = ((k === 'done' || k === 'received') && S.role === 'manager' && n > 0) ? ' attn' : '';
    // 지시 대기·회신 대기(소장 화면): 노란 바탕, 건수가 있으면 반짝이고 숫자가 빨갛게 깜빡
    const wait = (k === 'received' || (k === 'done' && S.role === 'manager')) ? (n ? ' wait spark' : ' wait') : '';   // 지시 대기: 노란 바탕, 건수가 있으면 반짝임
    return `<button type="button" class="chip${attn}${wait}${n ? '' : ' zero'}" data-act="filter" data-f="${k}" aria-pressed="${S.filter === k}">${dot}<span>${label}</span><b>${n}</b></button>`;
  }).join('') + `</div><input type="text" id="q" class="search" placeholder="검색: 동호수·내용·담당" value="${esc(searchVal)}" aria-label="민원 검색">`;
  if(hadFocus){ const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

function renderList(){
  const el = $('#list');
  if(S.role === 'staff' && !S.me){
    el.innerHTML = `<div class="empty"><strong>본인 이름을 선택하세요</strong>오른쪽 위 <b>나는</b> 목록에서 이름을 고르면 내게 지시된 민원만 보입니다.${S.staff.length ? '' : '<br>아직 직원 명단이 없습니다. 관리소장이 <b>직원·설정</b>에서 등록해야 합니다.'}</div>`;
    return;
  }
  const list = filtered();
  const nums = numbers();
  const head = `<div class="list-head"><span>${list.length}건</span><span>최근 접수순</span></div>`;
  if(!list.length){
    if(!S.complaints.length && S.role === 'manager'){
      el.innerHTML = head + `<div class="empty"><strong>아직 접수된 민원이 없습니다</strong>
        <ol class="flow"><li>소장이 민원을 접수합니다</li><li>담당 직원을 정해 지시합니다</li><li>직원이 진행·완료를 보고합니다</li><li>소장이 민원인에게 결과를 회신합니다</li></ol>
        <div class="btns"><button type="button" class="btn" data-act="settings">직원 명단 먼저 등록</button><button type="button" class="btn primary" data-act="new">+ 첫 민원 접수</button></div></div>`;
    } else {
      el.innerHTML = head + `<div class="empty">${S.role === 'staff' ? '이 조건에 해당하는 지시가 없습니다.' : '이 조건에 해당하는 민원이 없습니다.'}</div>`;
    }
    return;
  }
  el.innerHTML = head + list.map(c => `
    <button type="button" class="row" data-act="open" data-id="${esc(c.id)}" aria-current="${S.selectedId === c.id && !S.panel}">
      <span class="l1"><span class="no">#${nums[c.id]}</span><span>${esc(c.category)}</span><span>${esc(c.location)}</span>${receiver(c) ? `<span>· ${esc(receiver(c))} 접수</span>` : ''}</span>
      <span class="t">${esc(c.title)}</span>
      <span class="l3"><span class="pill s-${c.status}">${ST[c.status].label}</span>
        ${c.urgent ? '<span class="tag">긴급</span>' : ''}${c.rework && c.status !== 'replied' && c.status !== 'done' ? '<span class="tag">재작업</span>' : ''}${isOverdue(c) ? '<span class="tag">기한 초과</span>' : ''}
        <span>${esc(namesOf(c))}</span><span>·</span><span>${fmt(c.createdAt)}</span>${photoCount(c) ? `<span>· 사진 ${photoCount(c)}</span>` : ''}</span>
    </button>`).join('');
}

/* 상세 패널: 다른 탭에서 바뀌어 다시 그릴 때 입력 중인 내용은 보존한다 */
let lastKey = null;
function renderDetail(){
  const el = $('#detail');
  // 상태가 바뀌면(다른 기기의 보고 등) 화면의 입력 칸 구성이 달라지므로 새로 그린다
  const cur = S.selectedId && find(S.selectedId);
  const key = [S.panel, S.selectedId, S.role, S.me, cur ? cur.status : ''].join('|');
  const saved = {}, openDet = [];
  let focusId = null;
  if(key !== lastKey) clearPending();
  if(key === lastKey){
    el.querySelectorAll('input[id],textarea[id],select[id]').forEach(i => { if(i.type !== 'file') saved[i.id] = i.type === 'checkbox' ? i.checked : i.value; });
    el.querySelectorAll('details[id]').forEach(d => { if(d.open) openDet.push(d.id); });
    if(el.contains(document.activeElement)) focusId = document.activeElement.id;
  }
  const sheetBar = document.body.classList.contains('sheet') ? `<div class="sheet-bar"><button type="button" class="btn" data-act="close-detail">← 목록으로</button><span>${S.panel === 'new' ? '민원 접수' : S.panel === 'settings' ? '직원·설정' : S.panel === 'report' ? '월간 보고' : '민원 처리'}</span></div>` : '';
  el.innerHTML = sheetBar + (S.panel === 'new' ? newForm() : S.panel === 'settings' ? settingsView() : S.panel === 'report' ? reportView() : S.panel === 'hq' ? hqView() : complaintView());
  if(sheetBar && key !== lastKey) el.scrollTop = 0;
  for(const id in saved){ const i = document.getElementById(id); if(!i) continue; if(i.type === 'checkbox') i.checked = saved[id]; else i.value = saved[id]; }
  openDet.forEach(id => { const d = document.getElementById(id); if(d) d.open = true; });
  if(focusId){ const f = document.getElementById(focusId); if(f) f.focus(); }
  hydratePhotos(el);
  if(S.panel === 'hq') drawHqCharts();
  if(S.panel === 'report' && el.querySelector('#report-preview')){
    // 다시 그려도 저장 안 한 의견이 미리보기에 남도록
    $('#report-preview').innerHTML = reportHTML(S.reportMonth, currentReportMeta());
  }
  if(el.querySelector('#f-reply')){ const c = find(S.selectedId); if(c) prepareShareFiles(shareRefs(c)); }
  lastKey = key;
}
function resetDetail(){ lastKey = null; render(); }

const photoCount = c => (c.events || []).reduce((n, e) => n + (e.photos ? e.photos.length : 0), 0);
/* 직원이 받은 민원이면 그 직원 이름, 소장이 받았으면 빈 값 */
const receiver = c => (c.receivedBy && c.receivedBy !== 'manager') ? staffName(c.receivedBy) : '';

const opts = (arr, sel) => arr.map(v => `<option${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
const staffOpts = sel => '<option value="">담당 직원 선택</option>' + S.staff.map(s => `<option value="${esc(s.id)}"${s.id === sel ? ' selected' : ''}>${esc(s.name)}${s.duty ? ' · ' + esc(s.duty) : ''}</option>`).join('');

/* 1. 접수 */
function newForm(){
  const staffSelf = S.role === 'staff' ? `
    <label class="check"><input type="checkbox" id="n-self"> 내가 바로 처리 (소장 지시 없이 내 담당으로)</label>
    <p class="hint">체크하지 않으면 소장님께 <b>지시 대기</b>로 넘어갑니다. 어느 쪽이든 소장님 화면에 바로 보입니다.</p>` : '';
  return `<div class="d-head"><span class="no">새 민원${S.role === 'staff' ? ' · 접수자 ' + esc(staffName(S.me)) : ''}</span><h2>민원 접수</h2></div>
  <form id="f-new" class="sec">
    <div class="grid2">
      <label class="fld"><span>동</span><input type="text" id="n-dong" inputmode="numeric" placeholder="101" required></label>
      <label class="fld"><span>호수</span><input type="text" id="n-ho" inputmode="numeric" placeholder="1203"></label>
      <label class="fld"><span>분류</span><select id="n-cat">${opts(CATS,'시설')}</select></label>
      <label class="fld"><span>접수 경로</span><select id="n-ch">${opts(CHANNELS,'전화')}</select></label>
    </div>
    <label class="check"><input type="checkbox" id="n-urgent"> 긴급 처리</label>${staffSelf}
    <label class="fld"><span>민원 제목</span><input type="text" id="n-title" placeholder="거실 천장 누수" required></label>
    <label class="fld"><span>민원 내용</span><textarea id="n-detail" placeholder="민원인이 말한 내용을 그대로 적어 두세요."></textarea></label>
    ${photoPicker('현장 사진')}
    <p class="hint">공용부 민원은 동에 장소(예: 지하 2층 주차장)를 적고 호수는 비워 두세요.</p>
    <div class="btns"><button type="button" class="btn" data-act="cancel">취소</button><button type="submit" class="btn primary">접수하기</button></div>
  </form>`;
}

/* ---------- 월간 보고서(관리단 보고용, 관리소장 전용) ----------
 * 한 달 동안 접수된 민원과 그 달에 회신까지 끝난 민원을 집계한다.
 * '처리 완료'는 민원인 회신까지 마친 것(회신완료)을 기준으로 한다. */
function prevMonth(){ const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; }
function monthRange(ym){ const [y, m] = ym.split('-').map(Number); return [new Date(y, m - 1, 1), new Date(y, m, 1)]; }
function monthLabel(ym){ const [y, m] = ym.split('-').map(Number); return `${y}년 ${m}월`; }
const evDate = (c, type) => { const e = lastEv(c, type); return e ? new Date(e.at) : null; };
const closedAt = c => evDate(c, 'replied');
const days = (a, b) => (b - a) / 86400000;
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
const fmtDays = v => v == null ? '-' : `${Math.round(v * 10) / 10}일`;
const fmtPct = v => v == null ? '-' : `${v}%`;

function reportData(ym, src){
  const all = src || S.complaints;
  const [s, e] = monthRange(ym);
  const inM = d => d && d >= s && d < e;
  const closedBy = (c, t) => { const d = closedAt(c); return !!d && d < t; };
  const recv = all.filter(c => inM(new Date(c.createdAt))).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const closedInMonth = all.filter(c => inM(closedAt(c)));
  const carried = all.filter(c => new Date(c.createdAt) < s && !closedBy(c, s));
  const openEnd = all.filter(c => new Date(c.createdAt) < e && !closedBy(c, e));
  const doneRecv = recv.filter(c => closedBy(c, e));
  const avg = list => { const v = list.map(c => days(new Date(c.createdAt), closedAt(c))); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const withDue = recv.filter(c => c.due && lastEv(c, 'done'));
  const onTime = withDue.filter(c => ymd(new Date(lastEv(c, 'done').at)) <= c.due).length;
  const group = (list, key) => {
    const m = new Map();
    list.forEach(c => { const k = key(c); const g = m.get(k) || {key:k, total:0, done:0, open:0, list:[]}; g.total++; if(closedBy(c, e)) g.done++; else g.open++; g.list.push(c); m.set(k, g); });
    return [...m.values()].sort((a, b) => b.total - a.total || String(a.key).localeCompare(String(b.key)));
  };
  const dongKey = c => c.dong ? (/^\d+$/.test(c.dong) ? `${c.dong}동` : c.dong) : (c.location || '-');
  return {
    ym, s, e, recv, closedInMonth, carried, openEnd, doneRecv,
    urgent:recv.filter(c => c.urgent).length,
    byStaffReceived:recv.filter(c => c.receivedBy && c.receivedBy !== 'manager').length,
    avgDays:avg(doneRecv), rate:pct(doneRecv.length, recv.length),
    dueTotal:withDue.length, onTime, dueRate:pct(onTime, withDue.length),
    byCat:group(recv, c => c.category || '기타'),
    byDong:group(recv, dongKey).slice(0, 10),
    byStaff:group(recv.filter(c => assigneesOf(c).length).flatMap(c => assigneesOf(c).map(id => Object.assign({}, c, {__st:id}))), c => staffName(c.__st)).map(g => Object.assign(g, {avg:avg(g.list.filter(c => closedBy(c, e)))}))
  };
}
function reportMeta(ym){
  const s = S.settings, n = (s.reportNotes || {})[ym] || {};
  return {
    to:s.reportTo || (/관리단/.test(s.company || '') ? s.company : `${s.buildingName || ''} 관리단`.trim()),
    from:s.reportFrom || `선민종합관리(주)${s.buildingName ? ' ' + s.buildingName : ''} 관리사무소`,
    note:n.note || '', plan:n.plan || ''
  };
}
function bar(v, max){ return `<span class="rbar"><i style="width:${max ? Math.round(v / max * 100) : 0}%"></i></span>`; }
function reportHTML(ym, meta){
  const d = reportData(ym), nums = numbers();
  const max = Math.max(1, ...d.byCat.map(g => g.total));
  const stLabel = c => ST[c.status] ? ST[c.status].label : c.status;
  const doneText = c => { const ev = lastEv(c, 'done'); return ev ? ev.text : ''; };
  const table = (head, rows, empty) => rows.length
    ? `<table class="rtable"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<p class="rempty">${empty}</p>`;
  return `<article class="report">
    <header class="r-head">
      <div class="r-brand"><svg viewBox="0 0 96 96" width="34" height="34" aria-hidden="true"><rect width="96" height="96" rx="20" fill="#1E3A7B"/><text x="48" y="58" text-anchor="middle" font-family="'Arial Black','Helvetica Neue',Arial,sans-serif" font-weight="900" font-size="38" letter-spacing="-1" fill="#fff">SM</text><rect x="30" y="68" width="36" height="2" rx="1" fill="#4E6497"/></svg><div><b>선민종합관리(주)</b><small>FACILITY MANAGEMENT</small></div></div>
      <table class="r-sign"><tr><th rowspan="2">결<br>재</th><th>담당</th><th>관리소장</th><th>관리단</th></tr><tr><td></td><td></td><td></td></tr></table>
    </header>
    <h1 class="r-title">${monthLabel(ym)} 민원 처리 현황 보고</h1>
    <dl class="r-meta">
      <div><dt>수신</dt><dd>${esc(meta.to)} 귀중</dd></div>
      <div><dt>발신</dt><dd>${esc(meta.from)}</dd></div>
      <div><dt>보고 기간</dt><dd>${ymd(d.s)} ~ ${ymd(new Date(d.e - 86400000))}</dd></div>
      <div><dt>작성일</dt><dd>${ymd(new Date())}</dd></div>
    </dl>

    <h2>1. 처리 현황 요약</h2>
    <div class="r-kpis">
      <div><b>${d.recv.length}</b><span>이달 접수</span></div>
      <div><b>${d.closedInMonth.length}</b><span>이달 처리 완료</span></div>
      <div><b>${fmtPct(d.rate)}</b><span>이달 접수분 처리율</span></div>
      <div><b>${fmtDays(d.avgDays)}</b><span>평균 처리 기간</span></div>
      <div><b>${d.openEnd.length}</b><span>월말 미결</span></div>
      <div><b>${d.urgent}</b><span>긴급 민원</span></div>
    </div>
    <ul class="r-notes">
      <li>전월 이월 미결 ${d.carried.length}건, 이달 접수 ${d.recv.length}건(직원 현장 접수 ${d.byStaffReceived}건) 중 ${d.doneRecv.length}건 회신 완료</li>
      <li>처리 기한 준수: ${d.dueTotal ? `기한이 정해진 ${d.dueTotal}건 중 ${d.onTime}건 기한 내 완료(${fmtPct(d.dueRate)})` : '기한이 정해진 민원 없음'}</li>
      <li>'처리 완료'는 민원인 회신까지 마친 건, 처리 기간은 접수부터 회신까지입니다.</li>
    </ul>

    <h2>2. 분류별 현황</h2>
    ${table(['분류', '접수', '', '완료', '미결'], d.byCat.map(g => `<tr><td>${esc(g.key)}</td><td class="n">${g.total}</td><td class="b">${bar(g.total, max)}</td><td class="n">${g.done}</td><td class="n">${g.open}</td></tr>`), '이달 접수된 민원이 없습니다.')}

    <div class="r-two">
      <section>
        <h2>3. 동별 접수 (상위 10)</h2>
        ${table(['동·장소', '접수', '미결'], d.byDong.map(g => `<tr><td>${esc(g.key)}</td><td class="n">${g.total}</td><td class="n">${g.open}</td></tr>`), '-')}
      </section>
      <section>
        <h2>4. 담당자별 처리</h2>
        ${table(['담당', '배정', '완료', '평균 기간'], d.byStaff.map(g => `<tr><td>${esc(g.key)}</td><td class="n">${g.total}</td><td class="n">${g.done}</td><td class="n">${fmtDays(g.avg)}</td></tr>`), '-')}
      </section>
    </div>

    <h2>5. 이달 접수 민원 목록 (${d.recv.length}건)</h2>
    ${table(['번호', '접수일', '동·호수', '분류', '민원 내용', '처리 내용', '담당', '상태'],
      d.recv.map(c => `<tr><td class="n">${nums[c.id]}</td><td>${fmtDate(ymd(new Date(c.createdAt)))}</td><td>${esc(c.location)}</td><td>${esc(c.category)}</td><td>${c.urgent ? '<b class="r-urg">[긴급]</b> ' : ''}${esc(c.title)}</td><td>${esc(doneText(c))}</td><td>${esc(assigneesOf(c).length ? namesOf(c) : '-')}</td><td>${esc(stLabel(c))}</td></tr>`),
      '이달 접수된 민원이 없습니다.')}

    ${d.carried.length ? `<h2>6. 전월 이월 미결 (${d.carried.length}건)</h2>
    ${table(['번호', '접수일', '동·호수', '민원 내용', '담당', '현재 상태'], d.carried.map(c => `<tr><td class="n">${nums[c.id]}</td><td>${fmtDate(ymd(new Date(c.createdAt)))}</td><td>${esc(c.location)}</td><td>${esc(c.title)}</td><td>${esc(assigneesOf(c).length ? namesOf(c) : '-')}</td><td>${esc(stLabel(c))}</td></tr>`), '-')}` : ''}

    <h2>${d.carried.length ? 7 : 6}. 특이사항 및 관리소장 의견</h2>
    <div class="r-text" id="rv-note">${esc(meta.note) || '<span class="rempty">없음</span>'}</div>
    <h2>${d.carried.length ? 8 : 7}. 다음 달 계획</h2>
    <div class="r-text" id="rv-plan">${esc(meta.plan) || '<span class="rempty">없음</span>'}</div>

    <footer class="r-foot"><svg viewBox="0 0 96 96" width="22" height="22" aria-hidden="true"><rect width="96" height="96" rx="20" fill="#1E3A7B"/><text x="48" y="58" text-anchor="middle" font-family="'Arial Black','Helvetica Neue',Arial,sans-serif" font-weight="900" font-size="38" letter-spacing="-1" fill="#fff">SM</text><rect x="30" y="68" width="36" height="2" rx="1" fill="#4E6497"/></svg><span><b>선민종합관리(주)</b> · FACILITY MANAGEMENT</span><small>사람을 먼저 생각하는 관리 · 신뢰로 완성하는 가치</small></footer>
  </article>`;
}
function reportView(){
  const ym = S.reportMonth || (S.reportMonth = prevMonth());
  const m = reportMeta(ym);
  return `<div class="d-head"><span class="no">${S.exec ? '임원 열람' : '관리소장 전용'}</span><h2>월간 보고서</h2></div>
  <form id="f-monthly" class="sec${S.exec ? ' ro' : ''}">
    <div class="grid2">
      <label class="fld"><span>보고 월</span><input type="month" id="mr-month" value="${esc(ym)}" max="${ymd(new Date()).slice(0, 7)}"></label>
      <label class="fld"><span>수신</span><input type="text" id="mr-to" value="${esc(m.to)}" placeholder="○○ 관리단"></label>
      <label class="fld"><span>발신</span><input type="text" id="mr-from" value="${esc(m.from)}"></label>
    </div>
    <label class="fld"><span>특이사항 및 관리소장 의견</span><textarea id="mr-note" rows="4" placeholder="예) 9월 누수 민원 증가(5건) — 노후 배관 점검 필요. 105동 주차 민원 반복 접수.">${esc(m.note)}</textarea></label>
    <label class="fld"><span>다음 달 계획</span><textarea id="mr-plan" rows="3" placeholder="예) 105동 지하주차장 조명 교체, 동절기 대비 배관 동파 예방 점검">${esc(m.plan)}</textarea></label>
    <div class="btns">
      <button type="submit" class="btn">의견 저장</button>
      <button type="button" class="btn primary" data-act="report-print">인쇄 / PDF 저장</button>
      <button type="button" class="btn" data-act="report-csv">엑셀(CSV) 받기</button>
      <span class="spacer"></span>
      <button type="button" class="btn" data-act="cancel">닫기</button>
    </div>
    <p class="hint">의견을 고치면 아래 미리보기에 바로 반영됩니다. 인쇄 창에서 '대상: PDF로 저장'을 고르면 파일로 저장해 관리단에 보낼 수 있습니다.</p>
  </form>
  <div class="report-preview" id="report-preview">${reportHTML(ym, m)}</div>`;
}
function currentReportMeta(){
  return {to:val('mr-to'), from:val('mr-from'), note:val('mr-note'), plan:val('mr-plan')};
}
/* 인쇄 / PDF 저장. 카카오톡·네이버 등 앱 안의 브라우저는 인쇄를 막아 두므로 크롬에서 열도록 안내한다 */
function safePrint(){
  if(inAppBrowser){ showPrintHelp(); return; }
  try{ window.print(); }catch(e){ showPrintHelp(); }
}
function showPrintHelp(){
  const dlg = $('#popup'); dlg.dataset.k = '';
  $('#popup-title').textContent = '인쇄 / PDF 저장은 크롬에서 해 주세요';
  $('#popup-body').innerHTML = `<p>지금 열려 있는 ${inKakao ? '카카오톡' : '앱'} 안의 브라우저는 인쇄와 PDF 저장을 지원하지 않습니다.</p>
    <p class="hint">휴대폰의 크롬(또는 삼성 인터넷)에서 열면 <b>⋮ → 공유·인쇄 → PDF로 저장</b>으로 파일을 만들 수 있습니다. 크롬에서는 한 번 더 로그인해야 합니다.</p>
    <div class="btns"><button type="button" class="btn primary" data-act="open-browser">크롬(기본 브라우저)에서 열기</button><button type="button" class="btn" data-act="popup-close">닫기</button></div>`;
  if(!dlg.open) dlg.showModal();
}
function printReport(){
  const area = $('#print-area');
  area.innerHTML = reportHTML(S.reportMonth, currentReportMeta());
  safePrint();
}
/* 민원 목록을 엑셀에서 열리는 CSV 로 저장 (names: 직원 명단 — 백업 파일을 볼 때는 그 파일의 명단) */
function complaintsCSV(list, filename, names){
  const nameOf = id => { if(!id) return ''; const st = (names || S.db.staff).find(x => x.id === id); return st ? st.name : staffName(id); };
  const sorted = [...list].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const rows = [['번호', '접수일시', '동', '호', '위치', '분류', '접수경로', '긴급', '제목', '내용', '접수자', '담당', '처리기한', '상태', '완료보고일', '처리내용', '회신일', '회신방법']];
  sorted.forEach((c, i) => {
    const done = lastEv(c, 'done'), rep = lastEv(c, 'replied');
    rows.push([i + 1, fmt(c.createdAt), c.dong || '', c.ho || '', c.location || '', c.category || '', c.channel || '', c.urgent ? '긴급' : '',
      c.title || '', c.detail || '', (c.receivedBy && c.receivedBy !== 'manager') ? nameOf(c.receivedBy) : '관리소장', assigneesOf(c).map(nameOf).join(', '), c.due || '', ST[c.status] ? ST[c.status].label : c.status,
      done ? fmt(done.at) : '', done ? done.text || '' : '', rep ? fmt(rep.at) : '', rep ? rep.method || '' : '']);
  });
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function reportCSV(){ complaintsCSV(reportData(S.reportMonth).recv, `민원_${S.reportMonth}.csv`); }

/* 엑셀(.xlsx) 백업: 민원 · 처리 내역 · 직원 명단 세 시트. 엑셀 도구를 못 받으면 CSV 로 대신 저장 */
let xlsxLib = null;
function loadXLSX(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  if(xlsxLib) return xlsxLib;
  xlsxLib = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; sc.onload = () => res(window.XLSX); sc.onerror = () => { xlsxLib = null; rej(new Error('xlsx')); }; document.head.appendChild(sc); });
  return xlsxLib;
}
function complaintRows(list, names){
  const nameOf = id => { if(!id) return ''; const st = (names || S.db.staff).find(x => x.id === id); return st ? st.name : staffName(id); };
  const sorted = [...list].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
  const main = [['번호', '접수일시', '동', '호', '위치', '분류', '접수경로', '긴급', '제목', '내용', '접수자', '담당', '처리기한', '상태', '완료보고일', '처리내용', '회신일', '회신방법', '사진수']];
  const evs = [['민원번호', '일시', '구분', '담당/작성', '내용', '처리기한', '알린방법', '사진수']];
  sorted.forEach((c, i) => {
    const done = lastEv(c, 'done'), rep = lastEv(c, 'replied');
    main.push([i + 1, fmt(c.createdAt), c.dong || '', c.ho || '', c.location || '', c.category || '', c.channel || '', c.urgent ? '긴급' : '',
      c.title || '', c.detail || '', (c.receivedBy && c.receivedBy !== 'manager') ? nameOf(c.receivedBy) : '관리소장', assigneesOf(c).map(nameOf).join(', '), c.due || '', ST[c.status] ? ST[c.status].label : c.status,
      done ? fmt(done.at) : '', done ? done.text || '' : '', rep ? fmt(rep.at) : '', rep ? rep.method || '' : '', photoCount(c)]);
    (c.events || []).forEach(e => evs.push([i + 1, fmt(e.at), LOG_LABEL[e.type] || e.type, (e.staffIds && e.staffIds.length) ? e.staffIds.map(nameOf).join(', ') : e.staffId ? nameOf(e.staffId) : '관리소장', e.text || '', e.due || '', e.method || '', (e.photos || []).length]));
  });
  return {main, evs};
}
const LOG_LABEL = {received:'접수', assigned:'지시', reassigned:'담당 변경', rework:'재작업 지시', progress:'진행 보고', done:'완료 보고', notice:'중간 안내', replied:'회신 완료'};
async function exportXLSX(list, names, settings, filename){
  const {main, evs} = complaintRows(list, names);
  const staffRows = [['이름', '담당 업무']].concat((names || S.db.staff).map(st => [st.name || '', st.duty || '']));
  try {
    const X = await loadXLSX();
    const wb = X.utils.book_new();
    const add = (rows, name, widths) => { const ws = X.utils.aoa_to_sheet(rows); ws['!cols'] = widths.map(w => ({wch:w})); X.utils.book_append_sheet(wb, ws, name); };
    add(main, '민원', [5, 16, 6, 6, 14, 10, 8, 5, 24, 30, 10, 10, 11, 8, 16, 30, 16, 8, 6]);
    add(evs, '처리내역', [8, 16, 10, 10, 40, 11, 10, 6]);
    add(staffRows, '직원', [12, 16]);
    add([['항목', '값'], ['사업장', (settings && settings.buildingName) || siteName()], ['회사', (settings && settings.company) || COMPANY], ['백업 일시', fmt(now())], ['민원 수', list.length]], '정보', [12, 40]);
    X.writeFile(wb, filename.replace(/\.(csv|json)$/i, '') + '.xlsx');
  } catch(e){
    console.error(e);
    toast('엑셀 도구를 불러오지 못해 CSV 파일로 저장합니다 (엑셀에서 열립니다)');
    complaintsCSV(list, filename.replace(/\.(xlsx|json)$/i, '') + '.csv', names);
  }
}

/* ---------- 본사 화면 (hq 계정 전용) ---------- */
function siteKpis(id){
  const list = S.db.complaints.filter(c => siteOf(c) === id);
  const today = ymd(new Date()), ym = today.slice(0, 7);
  const r = reportData(ym, list);
  return {
    open:list.filter(c => c.status !== 'replied').length,
    received:list.filter(c => c.status === 'received').length,
    done:list.filter(c => c.status === 'done').length,
    overdue:list.filter(isOverdue).length,
    urgent:list.filter(c => c.urgent && c.status !== 'replied').length,
    month:r.recv.length, monthClosed:r.closedInMonth.length,
    staff:S.db.staff.filter(x => siteOf(x) === id).length,
    last:list.reduce((m, c) => (c.updatedAt || c.createdAt) > m ? (c.updatedAt || c.createdAt) : m, '')
  };
}
function hqSummaryHTML(ym){
  const sites = S.db.sites.filter(x => !x.archived);
  const rows = sites.map(st => Object.assign({site:st}, reportData(ym, S.db.complaints.filter(c => siteOf(c) === st.id))));
  const tot = rows.reduce((t, r) => ({recv:t.recv + r.recv.length, closed:t.closed + r.closedInMonth.length, done:t.done + r.doneRecv.length, open:t.open + r.openEnd.length, urgent:t.urgent + r.urgent,
    days:t.days + (r.avgDays != null ? r.avgDays * r.doneRecv.length : 0), carried:t.carried + r.carried.length}), {recv:0, closed:0, done:0, open:0, urgent:0, days:0, carried:0});
  const td = (v, cls = 'n') => `<td class="${cls}">${v}</td>`;
  return `<table class="rtable"><thead><tr><th>사업장</th><th>이월</th><th>접수</th><th>긴급</th><th>처리 완료</th><th>처리율</th><th>평균 기간</th><th>월말 미결</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${esc(r.site.name)}</td>${td(r.carried.length)}${td(r.recv.length)}${td(r.urgent)}${td(r.closedInMonth.length)}${td(fmtPct(r.rate))}${td(fmtDays(r.avgDays))}${td(r.openEnd.length)}</tr>`).join('')}
    <tr class="r-total"><td>합계 (${rows.length}개 사업장)</td>${td(tot.carried)}${td(tot.recv)}${td(tot.urgent)}${td(tot.closed)}${td(fmtPct(pct(tot.done, tot.recv)))}${td(fmtDays(tot.done ? tot.days / tot.done : null))}${td(tot.open)}</tr>
  </tbody></table>`;
}
function hqReportHTML(ym){
  return `<article class="report">
    <header class="r-head">
      <div class="r-brand"><svg viewBox="0 0 96 96" width="34" height="34" aria-hidden="true"><rect width="96" height="96" rx="20" fill="#1E3A7B"/><text x="48" y="58" text-anchor="middle" font-family="'Arial Black','Helvetica Neue',Arial,sans-serif" font-weight="900" font-size="38" letter-spacing="-1" fill="#fff">SM</text><rect x="30" y="68" width="36" height="2" rx="1" fill="#4E6497"/></svg><div><b>선민종합관리(주)</b><small>FACILITY MANAGEMENT</small></div></div>
      <table class="r-sign"><tr><th rowspan="2">결<br>재</th><th>담당</th><th>팀장</th><th>대표</th></tr><tr><td></td><td></td><td></td></tr></table>
    </header>
    <h1 class="r-title">${monthLabel(ym)} 전체 사업장 민원 처리 현황</h1>
    <dl class="r-meta">
      <div><dt>보고 기간</dt><dd>${ymd(monthRange(ym)[0])} ~ ${ymd(new Date(monthRange(ym)[1] - 86400000))}</dd></div>
      <div><dt>작성일</dt><dd>${ymd(new Date())}</dd></div>
    </dl>
    <h2>사업장별 현황</h2>
    ${hqSummaryHTML(ym)}
    <ul class="r-notes"><li>'처리 완료'는 민원인 회신까지 마친 건, 처리율은 이달 접수분 기준, 평균 기간은 접수부터 회신까지입니다.</li></ul>
    <footer class="r-foot"><svg viewBox="0 0 96 96" width="22" height="22" aria-hidden="true"><rect width="96" height="96" rx="20" fill="#1E3A7B"/><text x="48" y="58" text-anchor="middle" font-family="'Arial Black','Helvetica Neue',Arial,sans-serif" font-weight="900" font-size="38" letter-spacing="-1" fill="#fff">SM</text><rect x="30" y="68" width="36" height="2" rx="1" fill="#4E6497"/></svg><span><b>선민종합관리(주)</b> · FACILITY MANAGEMENT</span><small>사람을 먼저 생각하는 관리 · 신뢰로 완성하는 가치</small></footer>
  </article>`;
}
function hqView(){
  const ym = S.hqMonth || (S.hqMonth = ymd(new Date()).slice(0, 7));
  const sites = S.db.sites, active = sites.filter(x => !x.archived);
  const tot = active.reduce((t, st) => { const k = siteKpis(st.id); t.open += k.open; t.done += k.done; t.overdue += k.overdue; t.month += k.month; t.monthClosed += k.monthClosed; return t; }, {open:0, done:0, overdue:0, month:0, monthClosed:0});
  const siteOpts = sel => active.map(x => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  const today = new Date();
  const ICON = {
    bars:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />',
    trend:'<path d="M3 17l5-6 4 3 6-8 3 3M3 21h18" />',
    list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />',
    table:'<path d="M3 5h18v14H3zM3 10h18M3 15h18M9 5v14" />',
    calendar:'<path d="M4 5h16v15H4zM4 10h16M8 3v4M16 3v4" />',
    building:'<path d="M4 21V4h10v17M14 10h6v11M8 8h2M8 12h2M8 16h2M17 14h.01M17 18h.01M2 21h20" />',
    users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />'
  };
  const icon = k => `<span class="hq-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg></span>`;
  const card = (ic, title, sub, body, stat = '') => `<section class="hq-card"><header class="hq-ch">${icon(ic)}<div class="hq-cht"><h3>${title}</h3>${sub ? `<p class="hint">${sub}</p>` : ''}</div>${stat ? `<div class="hq-stat">${stat}</div>` : ''}</header>${body}</section>`;
  const stat = (v, l) => `<b>${v}</b><span>${l}</span>`;
  const mr = reportData(ym, S.db.complaints.filter(c => active.some(st => st.id === siteOf(c))));
  return `<div class="hq">
  <header class="hq-hero">
    <div class="hq-ht"><span class="no">${S.exec ? '임원 열람 전용' : '본사 담당자 전용'} · ${esc(ymd(today))} 기준</span><h2>본사 · 사업장 현황</h2><p>운영 중인 ${active.length}개 사업장의 민원 처리 상태를 한눈에 봅니다.</p></div>
    <div class="hq-kpis">
      <button type="button" data-act="hq-kpi" data-k="sites"><b>${active.length}</b><span>운영 사업장</span></button>
      <button type="button" data-act="hq-kpi" data-k="month"><b>${tot.month}</b><span>이달 접수</span><small>완료 ${tot.monthClosed}건</small></button>
      <button type="button" data-act="hq-kpi" data-k="open"><b>${tot.open}</b><span>미결</span></button>
      <button type="button" class="${tot.done ? 'attn' : ''}" data-act="hq-kpi" data-k="done"><b>${tot.done}</b><span>회신 대기</span></button>
      <button type="button" class="${tot.overdue ? 'bad' : ''}" data-act="hq-kpi" data-k="overdue"><b>${tot.overdue}</b><span>기한 초과</span></button>
    </div>
  </header>
  ${card('bars', '사업장별 미결 현황', '현재 미결 건수를 처리 단계별로 나누어 보여 줍니다. 사업장 줄이나 색 조각을 누르면 해당 민원 목록이 뜹니다.', '<div class="chart" data-chart="open"></div>', stat(tot.open, '미결 합계'))}
  <div class="charts2">
    ${card('trend', '최근 6개월 접수 · 처리 완료', `${esc(monthLabel(ym))}까지 월별 추이`, '<div class="chart" data-chart="trend"></div>', stat(mr.recv.length, `${esc(monthLabel(ym).slice(-3).trim())} 접수`))}
    ${card('list', `${esc(monthLabel(ym))} 분류별 접수`, '전체 사업장 합계, 많은 순', '<div class="chart" data-chart="cat"></div>', mr.byCat.length ? stat(esc(mr.byCat[0].key), '가장 많음') : '')}
  </div>
  ${card('table', '사업장별 현황', '사업장을 누르면 그 사업장 화면으로 들어갑니다.', active.length ? `<div class="tscroll"><table class="rtable hq-table"><thead><tr><th>사업장</th><th>미결</th><th>지시 대기</th><th>회신 대기</th><th>기한 초과</th><th>긴급</th><th>이달 접수</th><th>이달 완료</th><th>직원</th><th>최근 변동</th></tr></thead><tbody>
      ${active.map(st => { const k = siteKpis(st.id); const w = (v, warn) => `<td class="n${warn && v ? ' warn' : ''}">${v}</td>`;
        return `<tr class="click" data-act="hq-enter" data-site="${esc(st.id)}" tabindex="0"><td><b>${esc(st.name)}</b></td>${w(k.open)}${w(k.received, 1)}${w(k.done, 1)}${w(k.overdue, 1)}${w(k.urgent, 1)}${w(k.month)}${w(k.monthClosed)}${w(k.staff)}<td>${k.last ? fmt(k.last) : '-'}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<p class="hint">운영 중인 사업장이 없습니다. 아래에서 사업장을 추가하세요.</p>')}
  ${card('calendar', '전체 사업장 월간 현황', '보고 월을 고르면 사업장별 이월·접수·처리율·월말 미결이 나오고, 결재란이 있는 A4 보고서로 인쇄할 수 있습니다.', `
    <div class="btns"><label class="fld" style="max-width:200px"><span>보고 월</span><input type="month" id="hq-month" value="${esc(ym)}" max="${ymd(new Date()).slice(0, 7)}"></label><span class="spacer"></span><button type="button" class="btn primary" data-act="hq-print">인쇄 / PDF 저장</button></div>
    <div class="tscroll">${hqSummaryHTML(ym)}</div>`)}
  ${S.hq ? card('building', `사업장 관리 <span class="cnt">${sites.length}</span>`, '보관한 사업장은 현황에서 빠지지만 기록은 남고, \'다시 운영\'으로 되돌릴 수 있습니다. 사업장 안의 단지명·연락처·직원 명단은 그 사업장에 들어가 <b>직원·설정</b>에서 정합니다.', `
    ${sites.length ? `<ul class="staff-list">${sites.map(st => `<li><form class="site-row" data-site="${esc(st.id)}"><input type="text" value="${esc(st.name)}" aria-label="사업장 이름" required>${st.archived ? '<span class="tag soft">보관</span>' : ''}<button type="submit" class="btn sm">이름 저장</button><button type="button" class="btn sm${st.archived ? '' : ' danger'}" data-act="hq-archive" data-site="${esc(st.id)}" data-on="${st.archived ? '0' : '1'}">${st.archived ? '다시 운영' : '보관'}</button></form></li>`).join('')}</ul>` : ''}
    <form id="f-site" class="grid2">
      <label class="fld"><span>새 사업장 이름</span><input type="text" id="site-name" required placeholder="예) 청라 에이스하이테크시티"></label>
      <div class="btns" style="align-self:end"><button type="submit" class="btn">사업장 추가</button></div>
    </form>`) : ''}
  ${S.hq ? card('users', `계정 관리 <span class="cnt">${S.db.users.length}</span>`, '관리소장 계정은 여기서 바로 만듭니다(이메일 형식의 아이디 + 비밀번호 6자 이상). 만든 아이디·비밀번호를 소장에게 알려 주세요. 직원은 계정이 필요 없고, 소장이 <b>직원·설정 → 직원 접속 링크</b>로 들여보냅니다.', `
    ${S.db.users.length ? `<div class="tscroll"><table class="rtable"><thead><tr><th>아이디(이메일)</th><th>역할</th><th>사업장</th><th>이름</th><th></th></tr></thead><tbody>
      ${S.db.users.map(u => { const me = u.email === (S.user.email || '').toLowerCase(); return `<tr><td>${esc(u.email)}</td><td>${esc(ROLE_LABEL[u.role] || u.role)}</td><td>${u.role === 'manager' ? esc(siteName(u.site) || u.site || '-') : '전체'}</td><td>${esc(u.name)}</td><td class="n nowrap">${me ? '<span class="hint">나</span>' : `<button type="button" class="btn sm" data-act="hq-user-pw" data-email="${esc(u.email)}">비밀번호 재설정</button> <button type="button" class="btn sm danger" data-act="hq-user-del" data-email="${esc(u.email)}">삭제</button>`}</td></tr>`; }).join('')}
    </tbody></table></div>` : ''}
    <form id="f-user" class="grid2">
      <label class="fld"><span>아이디 (이메일 형식)</span><input type="email" id="u-email" required placeholder="예) cheongna@sunmin.kr"></label>
      <label class="fld"><span>비밀번호 (새 계정이면 필수, 6자 이상)</span><input type="password" id="u-pw" autocomplete="new-password" placeholder="기존 계정은 비워 두면 역할만 바뀜"></label>
      <label class="fld"><span>역할</span><select id="u-role"><option value="manager">관리소장</option><option value="hq">본사 담당자</option><option value="exec">임원 (전체 열람만)</option></select></label>
      <label class="fld"><span>사업장</span><select id="u-site"><option value="">본사 (전체 사업장)</option>${siteOpts(S.site)}</select></label>
      <label class="fld"><span>이름 (선택)</span><input type="text" id="u-name" placeholder="예) 박소장"></label>
      <div class="btns" style="align-self:end"><button type="submit" class="btn primary">계정 만들기 / 지정</button></div>
    </form>
    <p class="hint">이메일은 실제로 쓰지 않아도 되며(메일 발송 없음) 로그인 아이디로만 쓰입니다. 비밀번호를 잊으면 위 목록의 <b>비밀번호 재설정</b>으로 새로 정해 알려 주세요.</p>`) : ''}
  </div>`;
}
/* ---------- 본사 화면 그래프 (외부 라이브러리 없이 SVG 직접 생성) ---------- */
const VIZ = ['var(--viz1)', 'var(--viz2)', 'var(--viz3)', 'var(--viz4)'];
const OPEN_STAGES = [['received', '지시 대기'], ['assigned', '지시됨'], ['progress', '처리중'], ['done', '회신 대기']];
const legendHTML = items => `<div class="viz-legend">${items.map(([label, i]) => `<span><i style="background:${VIZ[i]}"></i>${esc(label)}</span>`).join('')}</div>`;
/* 막대에 쓰는 은은한 그라데이션(위·왼쪽이 조금 밝게) */
const gradDefs = (pre, vertical) => VIZ.map((c, i) => `<linearGradient id="${pre}-g${i}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}"><stop offset="0" stop-color="${c}" stop-opacity=".82"/><stop offset="1" stop-color="${c}"/></linearGradient>`).join('');
const gfill = (pre, i) => `url(#${pre}-g${i})`;
/* 글자 폭 어림(한글 12px, 영숫자 7px)으로 이름을 줄인다 */
const cut = (s, max) => { let out = '', w = 0; for(const ch of String(s)){ w += ch.charCodeAt(0) > 255 ? 12 : 7; if(w > max) return out + '…'; out += ch; } return out; };
/* 한쪽 끝만 둥근 막대(기준선 쪽은 각지게) */
function barPath(x, y, w, h, side){
  const r = Math.min(4, w / 2, h / 2);
  if(side === 'right') return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceStep(max){ const raw = Math.max(1, max) / 4, p = 10 ** Math.floor(Math.log10(raw)), n = raw / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }
const shortMonth = ym => `${Number(ym.slice(5))}월`;

function hqChartData(ym){
  const active = S.db.sites.filter(x => !x.archived), ids = new Set(active.map(x => x.id));
  const all = S.db.complaints.filter(c => ids.has(siteOf(c)));
  const open = active.map(st => {
    const l = all.filter(c => siteOf(c) === st.id && c.status !== 'replied');
    return {id:st.id, name:st.name, v:OPEN_STAGES.map(([k]) => l.filter(c => c.status === k).length), total:l.length};
  }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'ko'));
  const [y, m] = ym.split('-').map(Number);
  const trend = Array.from({length:6}, (_, i) => { const d = new Date(y, m - 6 + i, 1); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`; })
    .map(k => { const r = reportData(k, all); return {ym:k, recv:r.recv.length, closed:r.closedInMonth.length}; });
  const cat = reportData(ym, all).byCat.map(g => ({name:g.key, total:g.total}));
  return {open, trend, cat};
}
/* 1. 사업장별 미결: 단계별 누적 가로 막대, 줄을 누르면 그 사업장으로 */
function chartOpen(d, w){
  const rows = d.open.filter(r => r.total);
  if(!rows.length) return '<p class="hint">미결 민원이 없습니다. 모든 사업장이 회신까지 마쳤습니다.</p>';
  // 좁은 화면(휴대폰)에서는 사업장 이름을 막대 위 줄에 두고 막대를 가로로 꽉 채운다
  const narrow = w < 520, lw = narrow ? 0 : Math.min(170, Math.round(w * 0.3)), bh = narrow ? 24 : 26, gap = narrow ? 10 : 12, nameH = narrow ? 20 : 0, right = 44, pw = w - lw - right;
  const rowH = bh + gap + nameH, max = Math.max(1, ...rows.map(r => r.total)), h = rows.length * rowH;
  let defs = gradDefs('vo', false), body = '';
  rows.forEach((r, i) => {
    const y = i * rowH + gap / 2 + nameH, tw = Math.max(6, r.total / max * pw), id = `vz-clip-${i}`;
    defs += `<clipPath id="${id}"><path d="${barPath(lw, y, tw, bh, 'right')}"/></clipPath>`;
    let x = lw, segs = `<rect x="${lw}" y="${y}" width="${pw}" height="${bh}" rx="4" class="vz-track"/>`;
    r.v.forEach((v, k) => {
      if(!v) return;
      const sw = v / r.total * tw;
      segs += `<rect x="${x.toFixed(1)}" y="${y}" width="${sw.toFixed(1)}" height="${bh}" fill="${gfill('vo', k)}" stroke="var(--surface)" stroke-width="2" data-act="hq-kpi" data-k="site:${esc(r.id)}:${OPEN_STAGES[k][0]}" data-tip="${esc(`${r.name} · ${OPEN_STAGES[k][1]} ${v}건 (누르면 목록)`)}"/>`;
      if(sw >= 24) segs += `<text x="${(x + sw / 2).toFixed(1)}" y="${y + bh / 2}" class="vz-in" text-anchor="middle" dominant-baseline="central">${v}</text>`;
      x += sw;
    });
    body += `<g class="vz-row" data-act="hq-kpi" data-k="site:${esc(r.id)}" tabindex="0" role="button" aria-label="${esc(r.name)} 미결 ${r.total}건, 누르면 목록 보기">
      <rect x="0" y="${y - gap / 2 - nameH}" width="${w}" height="${rowH}" fill="transparent"/>
      ${narrow ? `<text x="0" y="${y - 6}" class="vz-lab">${esc(cut(r.name, w - 60))}</text>` : `<text x="${lw - 8}" y="${y + bh / 2}" class="vz-lab" text-anchor="end" dominant-baseline="central">${esc(cut(r.name, lw - 12))}</text>`}
      ${segs.slice(0, segs.indexOf('/>') + 2)}<g clip-path="url(#${id})">${segs.slice(segs.indexOf('/>') + 2)}</g>
      <text x="${(lw + tw + 6).toFixed(1)}" y="${y + bh / 2}" class="vz-val" dominant-baseline="central">${r.total}</text></g>`;
  });
  return legendHTML(OPEN_STAGES.map(([, l], i) => [l, i])) +
    `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="사업장별 미결 민원 단계별 누적 막대 그래프"><defs>${defs}</defs>${body}</svg>
    <p class="hint">막대 길이는 미결 건수, 색은 처리 단계입니다. 사업장 줄을 누르면 미결 목록이, 색 조각을 누르면 그 단계의 목록이 뜹니다.</p>`;
}
/* 2. 최근 6개월 접수·처리 완료: 월별 두 막대 */
function chartTrend(d, w){
  const t = d.trend, h = 240, top = 26, bottom = 26, left = 36, right = 16;
  const max = Math.max(1, ...t.map(r => Math.max(r.recv, r.closed)));
  const step = niceStep(max), ymax = Math.ceil(max / step) * step;
  const pw = w - left - right, ph = h - top - bottom, gw = pw / t.length;
  const Y = v => top + ph - v / ymax * ph, X = i => left + gw * i + gw / 2;
  let grid = '';
  for(let v = 0; v <= ymax; v += step) grid += `<line x1="${left}" x2="${w - right}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="vz-grid${v ? '' : ' base'}"${v ? ' stroke-dasharray="3 4"' : ''}/><text x="${left - 6}" y="${Y(v).toFixed(1)}" class="vz-ax" text-anchor="end" dominant-baseline="central">${v}</text>`;
  const SER = [['recv', '접수', 0], ['closed', '처리 완료', 3]];   // 접수는 파랑, 처리 완료는 녹색
  const peak = SER.map(([k]) => Math.max(...t.map(r => r[k])));
  // 선: 2px, 점: 지름 8px에 바탕색 테두리 2px, 선 아래는 옅은 면
  let lines = '', dots = '', labels = '';
  SER.forEach(([k, name, col], s) => {
    const pts = t.map((r, i) => [X(i), Y(r[k])]);
    const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    lines += `<path d="${path}L${pts[pts.length - 1][0].toFixed(1)},${Y(0).toFixed(1)}L${pts[0][0].toFixed(1)},${Y(0).toFixed(1)}Z" fill="${VIZ[col]}" opacity=".07"/>`;
    lines += `<path d="${path}" fill="none" stroke="${VIZ[col]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(([x, y], i) => {
      dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${VIZ[col]}" stroke="var(--surface)" stroke-width="2"/>`;
      const v = t[i][k], last = i === t.length - 1;
      // 값 표시는 마지막 달과 각 계열의 최고치만
      if(v && (last || v === peak[s])) labels += `<text x="${x.toFixed(1)}" y="${(y - (s ? -16 : 9)).toFixed(1)}" class="vz-val" text-anchor="middle">${v}</text>`;
    });
  });
  // 달마다 세로 안내선 + 넓은 호버 영역
  let cols = '';
  t.forEach((r, i) => {
    cols += `<g class="vz-col" data-tip="${esc(`${monthLabel(r.ym)} · 접수 ${r.recv}건 · 처리 완료 ${r.closed}건`)}"><rect x="${(left + gw * i).toFixed(1)}" y="${top - 12}" width="${gw.toFixed(1)}" height="${ph + 12}" fill="transparent"/><line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${top - 4}" y2="${Y(0).toFixed(1)}" class="vz-cross"/><text x="${X(i).toFixed(1)}" y="${h - 6}" class="vz-ax" text-anchor="middle">${shortMonth(r.ym)}</text></g>`;
  });
  return legendHTML(SER.map(([, l, col]) => [l, col])) +
    `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="최근 6개월 월별 접수와 처리 완료 건수 추세 선 그래프">${grid}${cols}${lines}${dots}${labels}</svg>
    <details class="viz-table"><summary>표로 보기</summary><table class="rtable"><thead><tr><th>월</th>${t.map(r => `<th class="n">${shortMonth(r.ym)}</th>`).join('')}</tr></thead><tbody>
      ${SER.map(([k, name]) => `<tr><td>${name}</td>${t.map(r => `<td class="n">${r[k]}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}
/* 3. 선택한 달의 분류별 접수: 원형(도넛) 비중 그래프 + 비중 목록. 상위 5개 뒤는 '그 외'로 묶는다 */
const DONUT_MAX = 5, VIZ_MORE = 'var(--viz5)', VIZ_ETC = 'var(--viz-etc)';
function chartCat(d, w, ym){
  if(!d.cat.length) return `<p class="hint">${esc(monthLabel(ym))}에 접수된 민원이 없습니다.</p>`;
  const sum = d.cat.reduce((a, r) => a + r.total, 0);
  let rows = d.cat.slice(0, DONUT_MAX);
  const rest = d.cat.slice(DONUT_MAX);
  if(rest.length === 1) rows = d.cat.slice(0, DONUT_MAX + 1);
  else if(rest.length > 1) rows = rows.concat([{name:`그 외 ${rest.length}개`, total:rest.reduce((a, r) => a + r.total, 0), etc:true, items:rest}]);
  const colors = rows.map((r, i) => r.etc ? VIZ_ETC : (i < 4 ? VIZ[i] : (i === 4 ? VIZ_MORE : VIZ_ETC)));
  const narrow = w < 420, size = narrow ? Math.min(200, w - 32) : Math.min(220, Math.round(w * 0.46)), R = size / 2, r0 = R * 0.62, cx = R, cy = R;
  const h = size;
  let acc = -Math.PI / 2, slices = '';
  rows.forEach((r, i) => {
    const frac = r.total / sum, a0 = acc, a1 = acc + frac * Math.PI * 2; acc = a1;
    const big = frac > 0.5 ? 1 : 0;
    const P = (a, rad) => `${(cx + rad * Math.cos(a)).toFixed(2)},${(cy + rad * Math.sin(a)).toFixed(2)}`;
    const path = frac >= 0.9999
      ? `M${P(0, R)}A${R},${R} 0 1 1 ${P(Math.PI, R)}A${R},${R} 0 1 1 ${P(0, R)}M${P(0, r0)}A${r0},${r0} 0 1 0 ${P(Math.PI, r0)}A${r0},${r0} 0 1 0 ${P(0, r0)}`
      : `M${P(a0, R)}A${R},${R} 0 ${big} 1 ${P(a1, R)}L${P(a1, r0)}A${r0},${r0} 0 ${big} 0 ${P(a0, r0)}Z`;
    const tip = r.etc ? `${r.name} ${r.total}건 (${pct(r.total, sum)}%) · ${r.items.map(x => `${x.name} ${x.total}`).join(', ')}` : `${r.name} ${r.total}건 (${pct(r.total, sum)}%)`;
    slices += `<path d="${path}" fill="${colors[i]}" stroke="var(--surface)" stroke-width="2" fill-rule="evenodd" class="vz-slice" data-tip="${esc(tip)}"/>`;
    // 조각이 충분히 크면 비율을 조각 안에 표시
    if(frac >= 0.1){ const am = (a0 + a1) / 2, rm = (R + r0) / 2; slices += `<text x="${(cx + rm * Math.cos(am)).toFixed(1)}" y="${(cy + rm * Math.sin(am)).toFixed(1)}" class="vz-in" text-anchor="middle" dominant-baseline="central">${Math.round(frac * 100)}%</text>`; }
  });
  const center = `<text x="${cx}" y="${cy - 8}" class="vz-big" text-anchor="middle" dominant-baseline="central">${sum}</text><text x="${cx}" y="${cy + 14}" class="vz-ax" text-anchor="middle" dominant-baseline="central">건 접수</text>`;
  const list = `<ol class="donut-list">${rows.map((r, i) => `<li data-tip="${esc(`${r.name} ${r.total}건`)}"><i style="background:${colors[i]}"></i><span class="dl-name">${esc(r.name)}</span><b>${r.total}</b><span class="dl-pct">${Math.round(r.total / sum * 100)}%</span></li>`).join('')}</ol>`;
  return `<div class="donut${narrow ? ' narrow' : ''}"><svg viewBox="0 0 ${size} ${h}" width="${size}" height="${h}" role="img" aria-label="${esc(monthLabel(ym))} 분류별 접수 비중 원형 그래프">${slices}${center}</svg>${list}</div>
    <details class="viz-table"><summary>표로 보기</summary><table class="rtable"><thead><tr><th>분류</th><th class="n">건수</th><th class="n">비율</th></tr></thead><tbody>
      ${d.cat.map(r => `<tr><td>${esc(r.name)}</td><td class="n">${r.total}</td><td class="n">${fmtPct(pct(r.total, sum))}</td></tr>`).join('')}</tbody></table></details>`;
}
function drawHqCharts(){
  const boxes = document.querySelectorAll('#detail .chart');
  if(!boxes.length) return;
  const d = hqChartData(S.hqMonth);
  boxes.forEach(el => {
    if(!el.clientWidth) return;
    const w = Math.max(240, Math.floor(el.clientWidth)), kind = el.dataset.chart;
    el.innerHTML = kind === 'open' ? chartOpen(d, w) : kind === 'trend' ? chartTrend(d, w) : chartCat(d, w, S.hqMonth);
  });
}
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if(S.panel === 'hq') drawHqCharts(); }, 150); });
/* 그래프 위에 손가락·마우스를 대면 값 풍선 */
const tipEl = document.createElement('div'); tipEl.id = 'tip'; tipEl.hidden = true; document.body.appendChild(tipEl);
function moveTip(e){
  const t = e.target.closest ? e.target.closest('[data-tip]') : null;
  if(!t){ tipEl.hidden = true; return; }
  tipEl.textContent = t.getAttribute('data-tip'); tipEl.hidden = false;
  const r = tipEl.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY - r.height - 12;
  if(x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if(y < 8) y = e.clientY + 16;
  tipEl.style.left = Math.max(8, x) + 'px'; tipEl.style.top = y + 'px';
}
document.addEventListener('pointermove', moveTip);
document.addEventListener('pointerdown', moveTip);
document.addEventListener('scroll', () => { tipEl.hidden = true; }, true);
$('#popup').addEventListener('click', e => { if(e.target === e.currentTarget) e.currentTarget.close(); });
/* 팝업을 직접 닫으면 기록에 남겨 둔 '다시 열기' 표시도 지운다 */
$('#popup').addEventListener('close', () => { const dlg = $('#popup'); if(dlg.dataset.quiet){ delete dlg.dataset.quiet; return; } syncHistory(); });

/* 본사 숫자 타일을 누르면 뜨는 간단한 표 팝업 */
const KPI_DEF = {
  sites:{title:'운영 사업장'}, month:{title:'이달 접수'}, open:{title:'미결 민원'}, done:{title:'회신 대기 (직원 완료 보고 올라옴)'}, overdue:{title:'기한 초과'}
};
function hqKpiList(k){
  const active = S.db.sites.filter(x => !x.archived), ids = new Set(active.map(x => x.id));
  const all = S.db.complaints.filter(c => ids.has(siteOf(c)));
  const ym = ymd(new Date()).slice(0, 7);
  if(k === 'month') return all.filter(c => (c.createdAt || '').slice(0, 7) === ym);
  if(k === 'open') return all.filter(c => c.status !== 'replied');
  if(k === 'done') return all.filter(c => c.status === 'done');
  if(k === 'overdue') return all.filter(isOverdue);
  if(/^site:/.test(k)){ const [, sid, stage] = k.split(':'); return all.filter(c => siteOf(c) === sid && (stage ? c.status === stage : c.status !== 'replied')); }
  return [];
}
/* k: 'sites' | 'month' | 'open' | 'done' | 'overdue' | 'site:<사업장id>[:<단계>]' (미결 그래프에서) */
function openKpiPopup(k){
  let d = KPI_DEF[k], siteId = null, stage = null;
  if(!d && /^site:/.test(k)){
    [, siteId, stage] = k.split(':');
    if(!S.db.sites.some(x => x.id === siteId)) return;
    d = {title:`${siteName(siteId)} · ${stage ? (ST[stage] ? ST[stage].chip : stage) : '미결'}`};
  }
  if(!d) return;
  let body = '';
  if(k === 'sites'){
    const rows = S.db.sites.filter(x => !x.archived).sort(bySiteName).map(st => { const kp = siteKpis(st.id); return `<tr class="click" data-act="hq-enter" data-site="${esc(st.id)}"><td><b>${esc(st.name)}</b></td><td class="n">${kp.open}</td><td class="n${kp.done ? ' warn' : ''}">${kp.done}</td><td class="n${kp.overdue ? ' warn' : ''}">${kp.overdue}</td><td class="n">${kp.month}</td><td class="n">${kp.staff}</td></tr>`; }).join('');
    body = rows ? `<table class="rtable keep"><thead><tr><th>사업장</th><th>미결</th><th>회신 대기</th><th>기한 초과</th><th>이달 접수</th><th>직원</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="hint">운영 중인 사업장이 없습니다.</p>';
  }else{
    // 사업장 이름순으로 묶고, 같은 사업장 안에서는 최근 접수순
    const list = hqKpiList(k).sort((a, b) => siteName(siteOf(a)).localeCompare(siteName(siteOf(b)), 'ko') || (b.createdAt || '').localeCompare(a.createdAt || ''));
    const rows = list.map(c => { const st = ST[c.status]; return `<tr class="click" data-act="hq-enter" data-site="${esc(siteOf(c))}" data-id="${esc(c.id)}"><td>${esc(siteName(siteOf(c)))}</td><td>${esc(c.location || [c.dong, c.ho].filter(Boolean).join(' '))}</td><td class="t">${c.urgent ? '<span class="tag">긴급</span> ' : ''}${esc(c.title || '')}</td><td>${esc(c.category || '')}</td><td><span class="pill" style="--c:var(--st-${esc(c.status)})">${esc(st ? st.chip : c.status)}</span></td><td>${esc(namesOf(c))}</td><td class="nowrap">${k === 'overdue' ? esc(c.due || '') : fmt(c.createdAt).slice(0, 9)}</td></tr>`; }).join('');
    // 휴대폰에서는 표 대신 카드 목록(CSS로 화면 폭에 따라 하나만 보임)
    const cards = list.map(c => { const st = ST[c.status]; return `<li class="pc" data-act="hq-enter" data-site="${esc(siteOf(c))}" data-id="${esc(c.id)}" tabindex="0">
      <div class="pc-l1"><span class="pc-site">${esc(siteName(siteOf(c)))}</span><span class="pill" style="--c:var(--st-${esc(c.status)})">${esc(st ? st.chip : c.status)}</span></div>
      <div class="pc-t">${c.urgent ? '<span class="tag">긴급</span> ' : ''}${esc(c.title || '')}</div>
      <div class="pc-l3">${esc(c.location || [c.dong, c.ho].filter(Boolean).join(' '))} · ${esc(c.category || '')} · ${esc(namesOf(c))} · ${k === 'overdue' ? '기한 ' + esc(c.due || '') : fmt(c.createdAt).slice(0, 9)}</div></li>`; }).join('');
    body = rows ? `<table class="rtable"><thead><tr><th>사업장</th><th>동·호</th><th>제목</th><th>분류</th><th>상태</th><th>담당</th><th>${k === 'overdue' ? '처리 기한' : '접수일'}</th></tr></thead><tbody>${rows}</tbody></table><ul class="popup-list">${cards}</ul>` : '<p class="hint">해당하는 민원이 없습니다.</p>';
  }
  $('#popup-title').textContent = `${d.title} · ${k === 'sites' ? S.db.sites.filter(x => !x.archived).length + '곳' : hqKpiList(k).length + '건'}`;
  $('#popup-body').innerHTML = body + (k === 'sites' ? '<p class="hint">줄을 누르면 그 사업장 화면으로 들어갑니다.</p>' : '<p class="hint">줄을 누르면 그 사업장의 해당 민원이 열립니다. 뒤로 가기를 누르면 이 목록으로 돌아옵니다.</p>')
    + (siteId ? `<div class="btns"><button type="button" class="btn" data-act="hq-enter" data-site="${esc(siteId)}">${esc(siteName(siteId))} 화면으로 들어가기 →</button></div>` : '');
  const dlg = $('#popup'); dlg.dataset.k = k; if(!dlg.open) dlg.showModal(); dlg.scrollTop = 0;
  syncHistory();
}
function printHqReport(){
  $('#print-area').innerHTML = hqReportHTML(S.hqMonth);
  safePrint();
}

function settingsView(){
  const s = S.settings;
  return `<div class="d-head dup"><span class="no">설정</span><h2>직원·설정</h2></div>
  <div class="scards">
  <form id="f-settings" class="sec">
    <h3>관리사무소 정보</h3>
    <p class="hint">민원인 회신 문구 머리말과 문의처에 들어갑니다.</p>
    <div class="grid2">
      <label class="fld"><span>회사명</span><input type="text" id="s-co" value="${esc(s.company)}" placeholder="${COMPANY}"></label>
      <label class="fld"><span>단지·건물명</span><input type="text" id="s-bname" value="${esc(s.buildingName)}" placeholder="○○아파트"></label>
      <label class="fld"><span>관리사무소 연락처</span><input type="tel" id="s-tel" value="${esc(s.officePhone)}" placeholder="02-000-0000"></label>
    </div>
    <label class="fld"><span>기본 지시 문구 (지시할 때 미리 채워짐)</span><input type="text" id="s-order" value="${esc(s.defaultOrder)}" placeholder="${DEFAULT_ORDER}"></label>
    <div>
    </div>
    <div class="btns"><button type="submit" class="btn primary">저장</button></div>
  </form>
  <div class="sec act">
    <h3>로고</h3>
    <div class="logo-preview">
      ${S.logo ? `<img src="${esc(S.logo)}" alt="현재 로고">` : '<span class="hint">이 기기에 올린 로고가 없습니다. 저장소의 <b>logo.png</b>가 있으면 그것을 씁니다.</span>'}
    </div>
    <div class="btns">
      <label class="btn">로고 이미지 올리기<input type="file" id="logo-file" accept="image/*" hidden></label>
      ${S.logo ? '<button type="button" class="btn danger" data-act="logo-clear">이 기기 로고 지우기</button>' : ''}
    </div>
  </div>
  <div class="sec act">
    <h3>직원 명단 <span class="hint">(${S.staff.length}명)</span></h3>
    ${S.staff.length ? `<ul class="staff-list">${S.staff.map(st => `<li><span>${esc(st.name)} <span class="r">${esc(st.duty || '')}${st.email ? ' · ' + esc(st.email) : ''}</span></span><button type="button" class="btn sm danger" data-act="del-staff" data-id="${esc(st.id)}">삭제</button></li>`).join('')}</ul>` : '<p class="hint">등록된 직원이 없습니다. 지시하려면 먼저 직원을 등록하세요.</p>'}
    <form id="f-staff" class="grid2">
      <label class="fld"><span>이름</span><input type="text" id="st-name" required placeholder="이름"></label>
      <label class="fld"><span>담당 업무</span><input type="text" id="st-duty" placeholder="전기 / 설비 / 경비 / 미화"></label>
      <div class="btns" style="align-self:end"><button type="submit" class="btn yellow">직원 추가</button></div>
    </form>
  </div>
  ${staffLinkSection()}
  ${serverSection()}
  <div class="sec act">
    <h3>데이터 백업</h3>
    <p class="hint">${SERVER ? '민원 기록은 서버에 저장됩니다. 만일에 대비해 한 달에 한 번쯤 엑셀 파일로 받아 두세요(민원·처리내역·직원 시트, 사진은 들어가지 않습니다).' : '민원 기록은 이 기기의 브라우저에 저장됩니다. 브라우저 기록을 지우면 함께 지워지니 정기적으로 백업해 두세요.'}</p>
    <div class="btns">
      <button type="button" class="btn primary" data-act="export-xlsx">엑셀 파일로 백업받기</button>
      ${!SERVER || S.hq ? `<button type="button" class="btn" data-act="export">복원용 파일 받기 (.json)</button>
      <label class="btn">복원용 파일 열어보기<input type="file" id="view-file" accept="application/json,.json" hidden></label>
      <label class="btn">복원용 파일 불러오기<input type="file" id="import-file" accept="application/json,.json" hidden></label>` : ''}
    </div>
    ${!SERVER || S.hq ? '<p class="hint">복원용 파일(.json)은 서버에 다시 넣을 때 쓰는 저장용입니다. 「열어보기」로 내용을 표로 확인하고 엑셀로 바꾸거나 서버에 합칠 수 있습니다.</p>' : ''}
    ${backupPreview()}
  </div>
  </div>
  <div class="btns"><button type="button" class="btn" data-act="cancel">닫기</button></div>`;
}
/* 백업 파일 열어보기: 서버에 넣지 않고 내용만 표로 보여 준다 */
function backupPreview(){
  const b = S.backup; if(!b) return '';
  const list = [...(b.data.complaints || [])].sort((x, y) => (y.createdAt || '').localeCompare(x.createdAt || ''));
  const names = b.data.staff || [];
  const nameOf = id => { const st = names.find(x => x.id === id); return st ? st.name : (id ? '?' : '-'); };
  const dates = list.map(c => c.createdAt).filter(Boolean).sort();
  return `<div class="panel-in">
    <div class="conn"><span><b>${esc(b.name)}</b></span><span class="hint">민원 ${list.length}건 · 직원 ${names.length}명${dates.length ? ` · ${fmtDate(ymd(new Date(dates[0])))} ~ ${fmtDate(ymd(new Date(dates[dates.length - 1])))}` : ''}${b.data.settings && b.data.settings.buildingName ? ' · ' + esc(b.data.settings.buildingName) : ''}</span></div>
    <div class="btns"><button type="button" class="btn" data-act="backup-csv">이 파일을 엑셀로 변환</button><button type="button" class="btn" data-act="backup-import">이 파일을 서버에 합치기</button><span class="spacer"></span><button type="button" class="btn sm" data-act="backup-close">닫기</button></div>
    ${list.length ? `<div class="tscroll"><table class="rtable"><thead><tr><th>접수일</th><th>동·호수</th><th>분류</th><th>민원 내용</th><th>담당</th><th>상태</th><th>처리 내용</th></tr></thead><tbody>
      ${list.map(c => { const d = lastEv(c, 'done'); return `<tr><td>${fmt(c.createdAt)}</td><td>${esc(c.location || '')}</td><td>${esc(c.category || '')}</td><td>${c.urgent ? '<b class="r-urg">[긴급]</b> ' : ''}${esc(c.title || '')}</td><td>${esc(assigneesOf(c).map(nameOf).join(', '))}</td><td>${esc(ST[c.status] ? ST[c.status].label : c.status || '')}</td><td>${esc(d ? d.text || '' : '')}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<p class="hint">민원이 없는 파일입니다.</p>'}
  </div>`;
}

/* 사진 저장 용량(무료 1GB) 어림값: 사진 장수 × 평균 크기 */
function storageInfo(){
  const n = photoTotal(), mb = n * PHOTO_AVG_MB;
  return {n, mb, pct:Math.round(mb / STORAGE_FREE_MB * 100)};
}
function storageWarn(){
  const u = storageInfo();
  return u.pct >= 80 ? `사진 저장 공간을 약 ${u.pct}% 썼습니다(사진 ${u.n}장, 약 ${Math.round(u.mb)}MB / 무료 1GB). README의 「사진 용량」을 참고해 요금제를 올리거나 오래된 사진을 정리하세요.` : '';
}

function staffLink(){
  const st = S.db.sites.find(x => x.id === S.site);
  return st && st.staffToken ? location.origin + location.pathname + '#staff=' + st.staffToken : '';
}
function staffLinkSection(){
  if(!SERVER) return '';
  const link = staffLink();
  return `<div class="sec act">
    <h3>직원 접속 링크</h3>
    <p class="hint"><mark class="hl"><b>직원에게 아래 링크를 카톡으로 보내 주세요.</b></mark> 직원은 링크를 한 번 열면 <b>${esc(siteName())}</b> 직원 화면이 열리고, 화면 아래 <b>바탕화면에 추가</b>를 누르면 다음부터 아이콘으로 들어옵니다. <mark class="hl">직원이 바뀌면 <b>링크 새로 만들기</b>를 누르시고 생성된 링크를 전 직원들에게 보내 주세요. 예전 링크는 바로 막힙니다.</mark></p>
    ${link ? `<code class="linktext" id="staff-link">${esc(link)}</code>
      <div class="btns">
        <button type="button" class="btn yellow" data-act="link-copy">링크 복사</button>
        <span class="spacer"></span>
        <button type="button" class="btn danger" data-act="link-rotate">링크 새로 만들기</button>
      </div>`
    : `<div class="btns"><button type="button" class="btn primary" data-act="link-rotate">직원 접속 링크 만들기</button></div>`}
  </div>`;
}

function serverSection(){
  if(SERVER && !S.hq) return '';   // 서버·사진 용량 정보는 본사 담당자에게만
  if(!SERVER){
    return `<div class="sec act">
      <h3>서버</h3>
      <p class="hint">아직 서버가 설정되지 않아 이 기기에만 저장됩니다. 저장소의 README 「서버 설정」을 따라 Supabase를 만들고 <code>config.js</code>에 주소와 키를 넣으면, 같은 주소로 접속한 모든 기기가 같은 기록을 봅니다.</p>
    </div>`;
  }
  const u = storageInfo();
  return `<div class="sec act">
    <h3>서버</h3>
    <div class="conn"><span>로그인 <code>${esc(S.user.email)}</code></span><span class="hint">${S.sync.state === 'error' ? '연결 오류: ' + esc(S.sync.msg) : '모든 기기가 같은 서버 데이터베이스를 씁니다. 다른 기기의 변경은 바로 반영됩니다.'}</span></div>
    <div class="conn"><span>사진 저장 <b>${u.n}장 · 약 ${Math.round(u.mb)}MB</b> / 무료 1GB (약 ${u.pct}%)</span><span class="hint">어림값입니다. 정확한 사용량은 Supabase 대시보드 → Storage에서 볼 수 있습니다.</span></div>
    <div class="btns"><button type="button" class="btn" data-act="sync-now">지금 새로 고침</button><span class="spacer"></span><button type="button" class="btn danger" data-act="logout">로그아웃</button></div>
  </div>`;
}

const EV = {
  received:{c:'--st-received', t:e => e.staffId ? `민원 접수 (${staffName(e.staffId)})` : '민원 접수'},
  assigned:{c:'--st-assigned', t:e => e.self ? `${staffName(e.staffId)} 직접 처리 시작` : `${evNames(e)}에게 지시`},
  reassigned:{c:'--st-assigned', t:e => `${evNames(e)}에게 재지시`},
  rework:{c:'--urgent', t:e => `재작업 지시 → ${evNames(e)}`},
  progress:{c:'--st-progress', t:e => `${staffName(e.staffId)} 진행 보고`},
  done:{c:'--st-done', t:e => `${staffName(e.staffId)} 완료 보고`},
  notice:{c:'--accent', t:e => `민원인 중간 안내${e.method ? ` (${e.method})` : ''}`},
  replied:{c:'--st-replied', t:e => `민원인 회신 완료${e.method ? ` (${e.method})` : ''}`}
};

function complaintView(){
  const c = find(S.selectedId);
  if(!c){
    return `<div class="empty"><strong>${S.role === 'manager' ? '민원을 선택하세요' : '지시를 선택하세요'}</strong>${S.role === 'manager'
      ? '왼쪽 목록에서 민원을 고르면 처리 내역과 지시·회신 화면이 열립니다. <b>회신 대기</b> 숫자는 직원 완료 보고가 올라와 민원인에게 알려야 하는 건입니다.'
      : '왼쪽 목록에서 지시를 고르면 지시 내용을 보고 진행·완료 보고를 올릴 수 있습니다.'}</div>`;
  }
  const no = numbers()[c.id];
  const mine = S.role === 'staff' && assigneesOf(c).includes(S.me);
  const order = (c.instruction && c.status !== 'received') ? `<div class="order${c.rework ? ' rework' : ''}"><span class="k">${c.rework ? '재작업 지시' : '지시 사항'} · ${esc(namesOf(c))}${assigneesOf(c).length > 1 && (c.status === 'assigned' || c.status === 'progress') ? ` · 완료 보고 ${doneBy(c).size}/${assigneesOf(c).length}` : ''}${c.due ? ' · 기한 ' + fmtDate(c.due) : ''}</span><p>${esc(c.instruction)}</p></div>` : '';
  return `
  <div class="d-head">
    <span class="no">#${no} · 접수 ${fmt(c.createdAt)}</span>
    <h2>${esc(c.title)}</h2>
    <div class="pills"><span class="pill s-${c.status}">${ST[c.status].label}</span>${c.urgent ? '<span class="tag">긴급</span>' : ''}${isOverdue(c) ? '<span class="tag">기한 초과</span>' : ''}</div>
  </div>
  <dl class="meta">
    <div><dt>동·호수</dt><dd>${esc(c.location)}</dd></div>
    <div><dt>접수자</dt><dd>${esc(receiver(c) || '관리소장')}</dd></div>
    <div><dt>분류 · 경로</dt><dd>${esc(c.category)} · ${esc(c.channel)}</dd></div>
  </dl>
  ${c.detail ? `<p class="body-text">${esc(c.detail)}</p>` : ''}
  ${order}
  <div class="sec"><h3>처리 내역</h3>
    <ol class="tl">${(c.events || []).map(e => { const d = EV[e.type] || EV.received; return `<li style="--c:var(${d.c})"><div class="h"><b>${esc(d.t(e))}</b><time>${fmt(e.at)}</time>${e.due ? `<span class="sub">기한 ${fmtDate(e.due)}</span>` : ''}</div>${e.text ? `<p>${esc(e.text)}</p>` : ''}${thumbsHTML(e.photos)}</li>`; }).join('')}</ol>
  </div>
  ${S.role === 'manager' ? managerActions(c) : staffActions(c, mine)}`;
}

/* 2·4. 관리소장: 지시 · 담당 변경 · 추가 지시 · 중간 안내 · 회신 · 재작업 */
function managerActions(c){
  let html = '';
  const noStaff = !S.staff.length ? '<p class="hint">직원 명단이 비어 있습니다. <b>직원·설정</b>에서 먼저 등록하세요.</p>' : '';
  const assignForm = (title, defaultDue) => `<form id="f-assign" class="sec">
      ${title ? `<h3>${title}</h3>` : ''}${noStaff}
      <div class="grid2">
        <fieldset class="fld multi"><legend>담당 직원 <small>(여러 명 선택 가능)</small></legend>
          <div class="chk-grid">${S.staff.map(st => `<label class="chk"><input type="checkbox" name="as-staff" id="as-s-${esc(st.id)}" value="${esc(st.id)}"${assigneesOf(c).includes(st.id) ? ' checked' : ''}><span>${esc(st.name)}${st.duty ? `<small>${esc(st.duty)}</small>` : ''}</span></label>`).join('')}</div>
        </fieldset>
        <label class="fld"><span>처리 기한</span><input type="date" id="as-due" value="${esc(c.due || defaultDue || '')}"></label>
      </div>
      <label class="fld"><span>지시 사항</span><textarea id="as-text" required placeholder="예) 오늘 오후 세대 방문해 누수 위치 확인, 윗집 1303호 협조 요청 후 결과 보고">${esc(S.settings.defaultOrder || '')}</textarea></label>
      <div class="btns"><button type="submit" class="btn primary">지시 보내기</button></div>
    </form>`;
  if(c.status === 'received'){
    html += `<div class="act">${assignForm('직원에게 지시', c.urgent ? ymd(new Date()) : '')}</div>`;
  }
  if(c.status === 'assigned' || c.status === 'progress'){
    html += `<details class="more" id="dt-assign"><summary>담당 변경 · 추가 지시</summary>${assignForm('')}</details>`;
  }
  if(c.status !== 'replied'){
    const final = c.status === 'done';
    html += `<${final ? 'div class="act"' : 'details class="more" id="dt-notice"'}>
      ${final ? '<h3>민원인에게 처리 결과 회신</h3>' : '<summary>민원인에게 중간 안내</summary>'}
      <form id="f-reply" class="sec" data-final="${final}">
        <p class="hint">문구를 고친 뒤 <b>카톡으로 보내기</b>(휴대폰)나 <b>문구 복사</b>로 보내고, 보낸 뒤 아래 버튼으로 기록하세요.</p>
        <textarea id="rp-text" rows="9">${esc(replyTemplate(c))}</textarea>
        ${shareRefs(c).length ? `<label class="check"><input type="checkbox" id="rp-photos" checked> ${final ? '완료' : '진행'} 사진 ${shareRefs(c).length}장도 함께 보내기 <small>(문구와 사진을 한 장의 안내 이미지로 만들어 한 번에 보냅니다)</small></label>${thumbsHTML(shareRefs(c))}` : ''}
        <div class="btns">
          <button type="button" class="btn kakao" id="share-btn" data-act="share-kakao">카톡으로 보내기</button>
          <button type="button" class="btn" data-act="copy-reply">문구 복사</button>
          <span class="spacer"></span>
          <input type="hidden" id="rp-method" value="">
          <button type="submit" class="btn primary">${final ? '회신완료로 기록' : '안내 기록'}</button>
        </div>
      </form>
    ${final ? '</div>' : '</details>'}`;
  }
  if(c.status === 'done'){
    html += `<details class="more" id="dt-rework"><summary>보고가 부족하면: 재작업 지시</summary>
      <form id="f-redo" class="sec">
        <label class="fld"><span>${esc(namesOf(c))}에게 다시 지시할 내용</span><textarea id="rw-text" required placeholder="예) 천장 얼룩 부분 사진 첨부 후 재보고 바랍니다"></textarea></label>
        <label class="fld" style="max-width:220px"><span>새 처리 기한</span><input type="date" id="rw-due" value="${esc(c.due || '')}"></label>
        <div class="btns"><button type="submit" class="btn danger">재작업 지시</button></div>
      </form></details>`;
  }
  html += `<div class="btns" style="justify-content:flex-end"><button type="button" class="btn sm danger" data-act="del" data-id="${esc(c.id)}">민원 삭제</button></div>`;
  return html;
}

/* 3. 직원: 진행 보고 · 완료 보고 */
function staffActions(c, mine){
  const receivedByMe = !mine && c.receivedBy === S.me;
  if(!mine){
    if(receivedByMe){
      // 내가 접수한 민원: 소장이 지시하기 전에는 기다리고, 지시된 뒤에는 나도 진행·완료 보고를 올릴 수 있다
      if(c.status === 'received') return '<div class="act"><p class="hint">내가 접수한 민원입니다. 소장님 지시를 기다리고 있습니다.</p></div>';
      if(c.status === 'replied') return '<div class="act"><p class="hint">내가 접수한 민원입니다. 회신까지 끝났습니다.</p></div>';
    }else return '<p class="hint">내게 지시된 민원이 아닙니다.</p>';
  }
  if(c.status === 'done') return '<div class="act"><p class="hint">완료 보고를 올렸습니다. 소장이 확인 후 민원인에게 회신합니다.</p></div>';
  if(c.status === 'replied') return '<div class="act"><p class="hint">민원인 회신까지 끝난 민원입니다.</p></div>';
  const dn = doneBy(c), others = assigneesOf(c).filter(id => id !== S.me && !dn.has(id));
  const note = receivedByMe ? `<p class="hint">내가 접수한 민원입니다. 담당: ${esc(namesOf(c))}. 내 보고를 올리면 소장에게 알려집니다.</p>` : dn.has(S.me) ? `<p class="hint"><b>내 완료 보고는 올렸습니다.</b>${others.length ? ` 아직 보고하지 않은 담당자: ${esc(others.map(staffName).join(', '))}. 모두 완료하면 소장에게 회신 대기로 알려집니다.` : ''}</p>` : (assigneesOf(c).length > 1 ? `<p class="hint">함께 담당: ${esc(assigneesOf(c).filter(id => id !== S.me).map(staffName).join(', '))}. 모든 담당자가 완료 보고를 올리면 회신 대기가 됩니다.</p>` : '');
  return `<div class="act">${note}<form id="f-report" class="sec">
    <h3>처리 결과 보고</h3>
    <label class="fld"><span>보고 내용</span><textarea id="rp-report" required placeholder="예) 1303호 욕실 배관 누수 확인. 배관 교체 완료, 1203호 천장 건조 후 도배는 세대에서 진행하기로 함"></textarea></label>
    ${photoPicker('처리 전·후 사진')}
    <div class="btns"><button type="submit" class="btn" value="progress">진행 보고</button><button type="submit" class="btn primary" value="done">완료 보고</button></div>
    <p class="hint">진행 보고는 상태를 ‘처리중’으로, 완료 보고는 ‘처리완료’로 바꾸고 소장에게 회신 대기로 알립니다.</p>
  </form></div>`;
}

/* 민원인 안내 문구 자동 생성 */
/* 회신에 함께 보낼 사진: 완료 회신이면 마지막 완료 보고, 중간 안내면 마지막 진행 보고의 사진 */
function shareRefs(c){
  if(c.status === 'done'){
    const evs = c.events || []; let from = -1;
    evs.forEach((e, k) => { if(e.type === 'assigned' || e.type === 'rework' || (e.type === 'reassigned' && e.restart)) from = k; });
    const all = evs.slice(from + 1).filter(e => e.type === 'done').flatMap(e => e.photos || []);
    if(all.length) return all;
  }
  const ev = lastEv(c, c.status === 'done' ? 'done' : 'progress');
  return (ev && ev.photos) || [];
}
/* 휴대폰 공유창은 버튼을 누른 직후에만 열 수 있어, 사진 파일을 미리 준비해 둔다 */
const shareFiles = new Map();
function prepareShareFiles(refs){
  refs.forEach(ref => {
    if(shareFiles.has(ref)) return;
    shareFiles.set(ref, null);
    photoURL(ref).then(u => fetch(u)).then(r => r.blob())
      .then(b => shareFiles.set(ref, new File([b], ref.split('/').pop(), {type:'image/jpeg'})))
      .catch(() => shareFiles.delete(ref));
  });
}
/* 카카오톡은 사진과 함께 공유한 글을 빼 버린다. 그래서 회신 문구와 사진을 한 장의 이미지(안내문)로 만들어
   한 번에 보낸다. 문구는 클립보드에도 복사해 두어 필요하면 붙여넣을 수 있다. */
const photosChecked = () => { const e = document.getElementById('rp-photos'); return !!(e && e.checked); };
function shareLabel(){ return '카톡으로 보내기'; }
function updateShareBtn(){}
function wrapLines(ctx, text, maxW){
  const out = [];
  String(text).split('\n').forEach(par => {
    if(!par){ out.push(''); return; }
    let line = '';
    for(const ch of par){
      const t = line + ch;
      if(ctx.measureText(t).width > maxW && line){
        // 가능하면 띄어쓰기에서 줄을 나눈다
        const sp = line.lastIndexOf(' ');
        if(sp > line.length * 0.5){ out.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else { out.push(line); line = ch; }
      } else line = t;
    }
    out.push(line);
  });
  return out;
}
async function buildReplyCard(text, files, c){
  const W = 1080, P = 64, FW = W - P * 2, font = '"IBM Plex Sans KR","Noto Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif';
  const imgs = [];
  for(const f of files.slice(0, 4)){ try{ imgs.push(await createImageBitmap(f)); }catch(e){} }
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  ctx.font = `38px ${font}`;
  const lines = wrapLines(ctx, text.trim(), FW), LH = 58;
  const title = ($('#co-name') && $('#co-name').textContent.trim()) || COMPANY;
  const headH = 170, textH = lines.length * LH + 40;
  const photoHs = imgs.map(im => Math.min(1300, Math.round(im.height * FW / im.width)));
  const H = headH + 48 + textH + photoHs.reduce((a, h) => a + h + 28, 0) + 36;
  cv.width = W; cv.height = H;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  // 머리띠
  ctx.fillStyle = '#1E3A7B'; ctx.fillRect(0, 0, W, headH);
  ctx.fillStyle = '#ffffff'; ctx.font = `700 44px ${font}`; ctx.textBaseline = 'top';
  ctx.fillText(title.length > 24 ? title.slice(0, 23) + '…' : title, P, 40);
  ctx.fillStyle = '#C9D4EC'; ctx.font = `30px ${font}`;
  ctx.fillText(c.status === 'done' || c.status === 'replied' ? '민원 처리 결과 안내' : '민원 처리 안내', P, 104);
  // 본문
  let y = headH + 48;
  ctx.fillStyle = '#141B2D'; ctx.font = `38px ${font}`;
  lines.forEach(l => { ctx.fillText(l, P, y); y += LH; });
  y += 40;
  // 사진
  imgs.forEach((im, i) => {
    const h = photoHs[i];
    const sw = im.width, sh = Math.min(im.height, Math.round(h * im.width / FW));
    ctx.drawImage(im, 0, 0, sw, sh, P, y, FW, h);
    ctx.strokeStyle = '#D3D9E5'; ctx.lineWidth = 2; ctx.strokeRect(P, y, FW, h);
    y += h + 28;
  });
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
  const name = `회신_${(c.location || '민원').replace(/\s+/g, '')}.jpg`;
  return new File([blob], name, {type:'image/jpeg'});
}
async function shareKakao(){
  const c = find(S.selectedId); if(!c) return;
  const text = val('rp-text');
  const withPhotos = photosChecked();
  const files = withPhotos ? shareRefs(c).map(r => shareFiles.get(r)).filter(Boolean) : [];
  const after = () => { const m = document.getElementById('rp-method'); if(m) m.value = '카톡'; };
  if(navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
  if(!navigator.share){
    after();
    toast('문구를 복사했습니다. PC 카톡 대화창에 붙여넣기(Ctrl+V) 하세요. 사진은 크게 보기에서 저장해 보내세요.');
    return;
  }
  const fail = err => { if(err && err.name === 'AbortError') return; after(); toast('공유창을 열지 못했습니다. 문구를 복사했으니 카톡에 붙여넣기 하세요.'); };
  let data = {text};
  if(withPhotos && files.length && navigator.canShare){
    try{
      const card = await buildReplyCard(text, files, c);
      if(navigator.canShare({files:[card]})) data = {files:[card], text};
    }catch(e){ console.error(e); }
  }
  navigator.share(data).then(() => {
    after();
    toast(data.files ? '문구와 사진을 한 장의 안내 이미지로 보냈습니다. 아래에서 기록 버튼을 누르세요.' : '보냈으면 아래에서 기록 버튼을 누르세요.' + (withPhotos && !data.files ? ' 사진은 이 기기에서 함께 보낼 수 없어 크게 보기에서 저장해 보내세요.' : ''));
  }).catch(fail);
}

function replyTemplate(c){
  const s = S.settings;
  const head = [s.company || COMPANY, s.buildingName ? `${s.buildingName} 관리사무소` : '관리사무소'].join(' ');
  const tel = s.officePhone ? `\n문의: 관리사무소 ${s.officePhone}` : '';
  const name = c.location ? `${c.location} 입주민님, 안녕하세요.\n` : '안녕하세요.\n';
  const where = c.title || c.category;
  if(c.status === 'done'){
    const d = lastEv(c, 'done');
    return `[${head}]\n${name}접수하신 민원(${where})의 처리 결과를 알려드립니다.\n\n■ 처리 내용: ${d ? d.text : ''}\n■ 처리 일시: ${d ? fmt(d.at) : ''}\n\n불편을 드려 죄송합니다. 처리 후에도 불편하신 점이 있으면 언제든 연락 주세요.${tel}`;
  }
  const st = {received:'접수되어 담당자를 배정하고 있습니다', assigned:`담당 직원에게 전달되었습니다${c.due ? ` (처리 예정일 ${fmtDate(c.due)})` : ''}`, progress:`현재 처리 중입니다${c.due ? ` (처리 예정일 ${fmtDate(c.due)})` : ''}`}[c.status] || '';
  const p = lastEv(c, 'progress');
  return `[${head}]\n${name}접수하신 민원(${where})은 ${st}.${p && c.status === 'progress' ? `\n\n■ 진행 상황: ${p.text}` : ''}\n\n처리가 끝나면 다시 안내드리겠습니다.${tel}`;
}

/* ---------- 동작 ---------- */
let toastT;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
function failMsg(e){
  if(e && e.code === 'quota_exceeded') return '저장 공간이 가득 찼습니다. 백업 후 오래된 민원을 삭제하거나 로고 이미지를 작게 줄이세요.';
  if(e && e.code === 'gone') return '다른 기기에서 삭제된 민원입니다.';
  if(e && e.code === 'forbidden') return '권한이 없는 작업입니다. (서버: ' + String(e.message || '').slice(0, 120) + ')';
  if(e && e.code === 'signup_off') return 'Supabase → Authentication → Sign In / Providers 에서 "Allow new users to sign up"을 켜야 계정을 만들 수 있습니다.';
  if(e && e.code === 'auth') return '로그인이 풀렸습니다. 다시 로그인해 주세요.';
  if(e && e.code === 'network' || e instanceof TypeError) return '인터넷 연결을 확인하세요. 저장되지 않았습니다.';
  if(e && /Could not find the function|schema cache/i.test(e.message || '')) return '서버 설정이 예전 버전입니다. Supabase SQL Editor에서 supabase/schema.sql(새 버전)을 다시 실행해 주세요.';
  if(e && e.code === 'server') return '서버에 저장하지 못했습니다: ' + e.message;
  return '저장하지 못했습니다. 잠시 후 다시 시도하세요.';
}
async function run(form, fn, okMsg){
  const btns = form ? form.querySelectorAll('button') : [];
  btns.forEach(b => b.disabled = true);
  try { await fn(); toast(okMsg); resetDetail(); }
  catch(e){ console.error(e); toast(failMsg(e)); render(); }
  finally { btns.forEach(b => b.disabled = false); }
}
async function copyText(text, fallbackEl){
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); }
  catch(e){ if(fallbackEl){ fallbackEl.focus(); fallbackEl.select && fallbackEl.select(); } toast('자동 복사가 막혀 있습니다. 선택된 글을 Ctrl+C로 복사하세요.'); }
}
const val = id => (document.getElementById(id).value || '').trim();
const event = (type, extra) => Object.assign({id:uid(), type, at:now()}, extra);

function readImage(file, maxW){
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/png'));
      };
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

let delArm = null;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const a = b.dataset.act;
  if(a === 'page-reload'){ location.reload(); }
  else if(a === 'install'){ if(installEvt){ installEvt.prompt(); installEvt.userChoice.then(() => { installEvt = null; renderInstall(); }); } }
  else if(a === 'install-later'){ lsSet('installDismiss', '1'); renderInstall(); }
  else if(a === 'open-browser'){
    // 카카오톡 안 브라우저 → 기기의 기본 브라우저(크롬·사파리)로 같은 주소 열기
    location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href);
  }
  else if(a === 'hq'){ if(!S.allSites) return; goHq(); }
  else if(a === 'exit-cancel'){ hideExitAsk(); syncHistory(); }
  else if(a === 'exit-app'){
    hideExitAsk();
    const before = location.href;
    history.back();                                        // 앞 페이지가 있으면 그리로 나간다
    setTimeout(() => { if(location.href === before && !document.hidden){ try{ window.close(); }catch(e){} setTimeout(() => { if(!document.hidden) toast('휴대폰의 뒤로 버튼을 한 번 더 누르거나 홈 버튼을 눌러 나가 주세요.'); }, 200); } }, 400);
  }
  else if(a === 'call-open'){
    const id = b.dataset.id, c = S.db.complaints.find(x => x.id === id);
    callQueue = []; renderCall();
    if(c && S.allSites && siteOf(c) !== S.site) enterSite(siteOf(c), false, id);
    else if(c){ S.selectedId = id; S.panel = null; S.filter = 'all'; render(); }
  }
  else if(a === 'close-detail'){ closeSheet(); }
  else if(a === 'hq-enter'){
    if(!S.allSites) return;
    const dlg = $('#popup');
    if(dlg.open){ dlg.dataset.quiet = '1'; dlg.close(); }   // 닫힘은 기록하지 않고, 다음 화면만 기록 → 뒤로 가면 이 팝업으로
    enterSite(b.dataset.site, false, b.dataset.id || null);
  }
  else if(a === 'hq-kpi'){ if(!S.allSites) return; openKpiPopup(b.dataset.k); }
  else if(a === 'popup-close'){ $('#popup').close(); }
  else if(a === 'hq-print'){ if(S.allSites) printHqReport(); }
  else if(a === 'hq-archive'){
    if(!S.hq) return;
    const st = S.db.sites.find(x => x.id === b.dataset.site); if(!st) return;
    const on = b.dataset.on === '1';
    if(on && !confirm(`'${st.name}' 사업장을 보관할까요? 현황에서 빠지지만 기록은 남습니다.`)) return;
    run(null, () => store.saveSite({id:st.id, name:st.name, archived:on}), on ? '보관했습니다' : '다시 운영합니다');
  }
  else if(a === 'hq-user-del'){
    if(!S.hq) return;
    if(!confirm(`${b.dataset.email} 계정을 삭제할까요? 그 아이디로는 더 이상 로그인할 수 없습니다. (민원 기록은 남습니다)`)) return;
    run(null, () => store.removeUser(b.dataset.email), '계정을 삭제했습니다');
  }
  else if(a === 'hq-user-pw'){
    if(!S.hq) return;
    const pw = prompt(`${b.dataset.email}의 새 비밀번호 (6자 이상)`); if(pw == null) return;
    if(pw.trim().length < 6){ toast('비밀번호는 6자 이상이어야 합니다'); return; }
    run(null, () => store.resetPassword(b.dataset.email, pw.trim()), '비밀번호를 바꿨습니다. 소장에게 알려 주세요.');
  }
  else if(a === 'link-rotate'){
    if(!S.canManage) return;
    if(staffLink() && !confirm('링크를 새로 만들까요? 예전 링크로 들어와 있던 직원 휴대폰은 모두 막히고, 새 링크를 다시 열어야 합니다.')) return;
    run(null, () => store.rotateStaffLink(), '직원 접속 링크를 만들었습니다');
  }
  else if(a === 'link-copy'){ copyText(staffLink()); }
  else if(a === 'role'){ if(S.mgrOnly || (b.dataset.role === 'manager' && !S.canManage)) return; S.role = b.dataset.role; lsSet('role', S.role); S.panel = null; S.filter = 'open'; S.selectedId = null; render(); }
  else if(a === 'filter'){ S.filter = b.dataset.f; render(); }
  else if(a === 'open'){ S.selectedId = b.dataset.id; S.panel = null; render(); if(matchMedia('(max-width:820px)').matches) $('#detail').scrollIntoView({block:'start'}); }
  else if(a === 'new'){
    if(S.role === 'staff' && !S.me){ toast('먼저 오른쪽 위에서 내 이름을 선택하세요'); $('#me-select').focus(); return; }
    S.panel = 'new'; render(); $('#detail').scrollIntoView({block:'nearest'}); const f = document.getElementById('n-dong'); if(f) f.focus(); }
  else if(a === 'report'){ if(!S.canManage && !S.exec) return; S.panel = 'report'; render(); $('#detail').scrollIntoView({block:'start'}); }
  else if(a === 'report-print'){ if(S.canManage || S.exec) printReport(); }
  else if(a === 'report-csv'){ if(S.canManage || S.exec) reportCSV(); }
  else if(a === 'settings'){ if(!S.canManage) return; S.panel = 'settings'; render(); $('#detail').scrollIntoView({block:'nearest'}); }
  else if(a === 'cancel'){ S.panel = null; render(); }
  else if(a === 'copy'){ copyText(b.dataset.text); }
  else if(a === 'share-kakao'){ shareKakao(); }
  else if(a === 'copy-reply'){ const t = document.getElementById('rp-text'); copyText(t.value, t); }
  else if(a === 'reset-reply'){ const c = find(S.selectedId); if(c) document.getElementById('rp-text').value = replyTemplate(c); }
  else if(a === 'sync-now'){ reload().then(() => toast('새로 고쳤습니다')); }
  else if(a === 'logout'){
    if(!confirm('로그아웃할까요? 다시 쓰려면 아이디와 비밀번호를 넣어야 합니다.')) return;
    sb.auth.signOut().then(() => { S.panel = null; S.selectedId = null; });
  }
  else if(a === 'photo-remove'){ const [p] = pendingPhotos.splice(+b.dataset.i, 1); if(p) URL.revokeObjectURL(p.url); renderDetail(); }
  else if(a === 'photo-view'){
    const v = $('#viewer'), img = $('#viewer-img');
    img.removeAttribute('src');
    photoURL(b.dataset.ref).then(u => { img.src = u; $('#viewer-dl').href = u; }).catch(() => toast('사진을 불러오지 못했습니다'));
    v.showModal();
  }
  else if(a === 'viewer-close'){ $('#viewer').close(); }
  else if(a === 'del-staff'){ run(null, () => store.removeStaff(b.dataset.id), '직원을 명단에서 뺐습니다'); }
  else if(a === 'logo-clear'){ try { localStorage.removeItem(LOGO_KEY); } catch(e){} S.logo = ''; toast('이 기기 로고를 지웠습니다'); resetDetail(); }
  else if(a === 'export-xlsx'){ exportXLSX(S.complaints, S.db.staff.filter(x => siteOf(x) === S.site), S.settings, `민원백업_${siteName() || '사업장'}_${ymd(new Date())}`); }
  else if(a === 'backup-csv'){ if(S.backup) exportXLSX(S.backup.data.complaints || [], S.backup.data.staff || [], S.backup.data.settings, S.backup.name); }
  else if(a === 'backup-close'){ S.backup = null; resetDetail(); }
  else if(a === 'backup-import'){
    if(!S.backup) return;
    const d = S.backup.data;
    if(!confirm(SERVER ? `민원 ${d.complaints.length}건이 든 백업을 서버 기록에 합칠까요? 같은 민원은 백업 내용으로 덮어씁니다.` : `민원 ${d.complaints.length}건이 든 백업으로 지금 데이터를 바꿀까요?`)) return;
    S.selectedId = null; S.backup = null;
    run(null, () => store.importBackup(d), '백업을 불러왔습니다');
  }
  else if(a === 'export'){
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], {type:'application/json'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `민원백업_${ymd(new Date())}.json`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  else if(a === 'del'){
    if(delArm !== b.dataset.id){ delArm = b.dataset.id; b.textContent = '한 번 더 누르면 삭제됩니다'; setTimeout(() => { if(delArm === b.dataset.id){ delArm = null; b.textContent = '민원 삭제'; } }, 4000); return; }
    delArm = null; const id = b.dataset.id; S.selectedId = null;
    run(null, () => store.remove(id), '민원을 삭제했습니다');
  }
});
document.addEventListener('input', e => {
  // 월간 보고서 의견을 고치면 미리보기에 바로 반영
  if(e.target.id === 'mr-note' || e.target.id === 'mr-plan'){
    const el = document.getElementById(e.target.id === 'mr-note' ? 'rv-note' : 'rv-plan');
    if(el) el.innerHTML = esc(e.target.value) || '<span class="rempty">없음</span>';
  }
  if(e.target.id === 'q'){ S.q = e.target.value; renderList(); }
});
document.addEventListener('change', async e => {
  if(e.target.id === 'mr-month' && e.target.value){ S.reportMonth = e.target.value; resetDetail(); return; }
  if(e.target.id === 'photo-input' && e.target.files.length){
    const files = [...e.target.files].slice(0, PHOTO_LIMIT - pendingPhotos.length);
    toast('사진 준비 중…');
    for(const file of files){
      try { const blob = await compressPhoto(file); pendingPhotos.push({blob, url:URL.createObjectURL(blob)}); }
      catch(err){ toast('사진 하나를 읽지 못했습니다 (' + file.name + ')'); }
    }
    if(e.target.files.length > files.length) toast(`사진은 한 번에 ${PHOTO_LIMIT}장까지 올릴 수 있습니다`);
    else toast(`사진 ${files.length}장을 붙였습니다`);
    renderDetail();
    return;
  }
  if(e.target.id === 'logo-file' && e.target.files[0]){
    try { const data = await readImage(e.target.files[0], 400); if(!lsSet(LOGO_KEY, data)) throw 0; S.logo = data; toast('로고를 바꿨습니다'); resetDetail(); }
    catch(err){ toast('이미지를 읽지 못했습니다'); }
  }
  if(e.target.id === 'view-file' && e.target.files[0]){
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if(!Array.isArray(d.complaints)) throw new Error('형식');
      S.backup = {name:e.target.files[0].name, data:d}; resetDetail();
      setTimeout(() => { const el = document.querySelector('.panel-in'); if(el) el.scrollIntoView({block:'start', behavior:'smooth'}); }, 50);
    } catch(err){ toast('백업 파일을 읽지 못했습니다'); }
    finally { e.target.value = ''; }
    return;
  }
  if(e.target.id === 'import-file' && e.target.files[0]){
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if(!Array.isArray(d.complaints)) throw new Error('형식');
      if(!confirm(SERVER ? `민원 ${d.complaints.length}건이 든 백업을 서버 기록에 합칠까요? 같은 민원은 백업 내용으로 덮어씁니다.` : `민원 ${d.complaints.length}건이 든 백업으로 지금 데이터를 바꿀까요?`)) return;
      S.selectedId = null;
      run(null, () => store.importBackup(d), '백업을 불러왔습니다');
    } catch(err){ toast('백업 파일을 읽지 못했습니다'); }
    finally { e.target.value = ''; }
  }
});
/* 본사: 사업장 바꾸기 */
/* 본사 담당자가 사업장에 들어가면 브라우저 기록을 한 칸 쌓아, 휴대폰 뒤로 가기 버튼으로 본사 화면에 돌아올 수 있게 한다 */
function enterSite(id, fromHistory, selectId){
  if(!S.db.sites.some(x => x.id === id)) return;
  S.site = id; lsSet('site', id);
  S.panel = null; S.selectedId = null; S.filter = 'open'; S.q = '';
  S.role = 'manager'; lsSet('role', 'manager');
  deriveSite(); applyAccount();
  if(selectId && S.complaints.some(c => c.id === selectId)){ S.selectedId = selectId; const c = find(selectId); if(c && c.status === 'replied') S.filter = 'all'; }
  resetDetail(); window.scrollTo({top:0});
}
$('#site-select').addEventListener('change', e => { if(!S.allSites) return; if(e.target.value) enterSite(e.target.value); else goHq(); });
function goHq(){ S.panel = 'hq'; S.selectedId = null; render(); window.scrollTo({top:0}); }
const isNarrow = () => matchMedia('(max-width:820px)').matches;
function closeSheet(){ if(S.panel === 'hq') return; S.panel = null; S.selectedId = null; render(); }
/* ---------- 브라우저 기록: 화면이 바뀔 때마다 한 칸 쌓아, 뒤로 가기가 항상 직전 화면으로 ----------
   화면 = 사업장 + 열린 패널(접수/설정/보고/본사) + 선택한 민원 + 역할 + 열린 팝업. 필터·검색어는 화면으로 치지 않는다. */
let restoring = false, exitAsking = null;
function showExitAsk(){
  exitAsking = JSON.stringify(viewSnap());
  let el = document.getElementById('exitask');
  if(!el){
    el = document.createElement('div'); el.id = 'exitask'; el.setAttribute('role', 'alertdialog');
    el.innerHTML = '<b>앱에서 나가시겠습니까?</b><span>뒤로 버튼을 한 번 더 누르면 나갑니다.</span><div class="btns"><button type="button" class="btn" data-act="exit-cancel">계속 쓰기</button><button type="button" class="btn primary" data-act="exit-app">나가기</button></div>';
    document.body.appendChild(el);
  }
  el.hidden = false;
}
function hideExitAsk(){ exitAsking = null; const el = document.getElementById('exitask'); if(el) el.hidden = true; }
const viewSnap = () => ({site:S.site, panel:S.panel, sel:S.selectedId, role:S.role, popup:$('#popup').open ? ($('#popup').dataset.k || null) : null});
function syncHistory(){
  if(restoring || (SERVER && !S.user)) return;
  const v = viewSnap(), cur = history.state && history.state.view;
  if(exitAsking){ if(JSON.stringify(v) === exitAsking) return; hideExitAsk(); }   // 나가기 확인 중에는 화면이 바뀔 때만 다시 기록
  if(cur && JSON.stringify(cur) === JSON.stringify(v)) return;
  // 맨 아래에는 '나가기 확인'용 칸을 하나 깔아 두어, 첫 화면에서 뒤로 가기를 누르면 바로 나가지 않고 묻는다
  try{ if(cur) history.pushState({view:v}, ''); else { history.replaceState({guard:1}, ''); history.pushState({view:v}, ''); } }catch(e){}
}
window.addEventListener('popstate', e => {
  if(e.state && e.state.guard){
    // 첫 화면에서 뒤로 가기: 바로 나가지 않고 묻는다. 여기서 한 번 더 뒤로 가기를 누르면 그대로 나가진다
    // (휴대폰의 확인창·대화상자는 뒤로 가기에 막히거나 닫혀 버려 쓰지 않는다)
    showExitAsk();
    return;
  }
  const v = e.state && e.state.view; if(!v || (SERVER && !S.user)) return;
  restoring = true;
  try{
    if(S.allSites && v.site && v.site !== S.site && S.db.sites.some(x => x.id === v.site)){ S.site = v.site; lsSet('site', v.site); deriveSite(); }
    S.panel = v.panel === 'hq' && !S.allSites ? null : v.panel;
    S.selectedId = v.sel && S.complaints.some(c => c.id === v.sel) ? v.sel : null;
    if(!S.mgrOnly && (v.role === 'staff' || (v.role === 'manager' && S.canManage))) { S.role = v.role; lsSet('role', S.role); }
    const dlg = $('#popup');
    if(v.popup){ resetDetail(); openKpiPopup(v.popup); }
    else { if(dlg.open){ dlg.dataset.quiet = '1'; dlg.close(); } resetDetail(); }
    if(S.panel === 'hq') window.scrollTo({top:0});
  }finally{ restoring = false; }
});
window.addEventListener('resize', () => { if(document.body.classList.contains('sheet') !== (isNarrow() && S.panel !== 'hq' && !!(S.panel || S.selectedId))) render(); });
try{ history.replaceState(null, ''); }catch(e){}   // 새로 고침 뒤에는 처음 화면부터 기록
document.addEventListener('change', e => { if(e.target.id === 'hq-month' && e.target.value){ S.hqMonth = e.target.value; resetDetail(); } });
document.addEventListener('change', e => {
  if(e.target.id === 'rp-photos') updateShareBtn();
  if(e.target.id === 'u-role'){ const st = $('#u-site'); if(e.target.value !== 'manager') st.value = ''; else if(!st.value) st.selectedIndex = 1; }
  if(e.target.id === 'u-site'){ const r = $('#u-role'); if(!e.target.value){ if(r.value === 'manager') r.value = 'hq'; } else if(r.value !== 'manager') r.value = 'manager'; }
});
$('#me-select').addEventListener('change', e => { S.me = e.target.value || null; lsSet('meStaff', S.me || ''); S.selectedId = null; render(); });

document.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, c = find(S.selectedId);
  if(f.id === 'f-new'){
    const at = now(), ch = val('n-ch'), dong = val('n-dong'), ho = val('n-ho');
    const location = /^\d+$/.test(dong) ? `${dong}동${ho ? ' ' + ho + (/^\d+$/.test(ho) ? '호' : '') : ''}` : [dong, ho].filter(Boolean).join(' ');
    const byStaff = S.role === 'staff' && S.me;
    const self = byStaff && document.getElementById('n-self').checked;
    const data = { title:val('n-title'), detail:val('n-detail'), location, dong, ho,
      category:val('n-cat'), channel:ch, urgent:document.getElementById('n-urgent').checked, status:'received',
      receivedBy: byStaff ? S.me : 'manager',
      assignee:null, assignees:[], instruction:'', due:'', rework:false, createdAt:at, updatedAt:at,
      events:[event('received', Object.assign({at, text:`${ch}(으)로 접수`}, byStaff ? {staffId:S.me} : {}))] };
    if(self){
      Object.assign(data, {status:'assigned', assignee:S.me, assignees:[S.me], instruction:'직접 접수 후 처리'});
      data.events.push(event('assigned', {staffId:S.me, self:true, text:'직접 접수해 처리 시작'}));
    }
    const msg = !byStaff ? '민원을 접수했습니다. 담당 직원에게 지시하세요.'
      : self ? '접수했습니다. 처리 후 보고를 올려 주세요.' : '접수했습니다. 소장님께 지시 대기로 전달됩니다.';
    run(f, async () => {
      const id = uid();
      const photos = await uploadPending(id);
      if(photos.length) data.events[0].photos = photos;
      await store.addComplaint(data, id); S.selectedId = id; S.panel = null; S.filter = 'open';
    }, msg);
  }
  else if(f.id === 'f-assign' && c){
    const sids = [...f.querySelectorAll('input[name=as-staff]:checked')].map(i => i.value);
    if(!sids.length){ toast('담당 직원을 한 명 이상 선택하세요'); return; }
    const text = val('as-text'), due = val('as-due');
    const prev = assigneesOf(c), type = prev.length ? 'reassigned' : 'assigned';
    const keep = c.status === 'progress' && sids.some(id => prev.includes(id));
    const names = sids.map(staffName).join(', ');
    run(f, () => store.update(c.id, { assignee:sids[0], assignees:sids, instruction:text, due, status: keep ? 'progress' : 'assigned', rework:false },
      event(type, {staffId:sids[0], staffIds:sids, text, due, restart:!keep}), `지시: ${c.location} → ${names}`), `${names}에게 지시했습니다`);
  }
  else if(f.id === 'f-redo' && c){
    const text = val('rw-text'), due = val('rw-due') || c.due;
    run(f, () => store.update(c.id, { instruction:text, due, status:'assigned', rework:true },
      event('rework', {staffId:assigneesOf(c)[0], staffIds:assigneesOf(c), text, due}), `재작업 지시: ${c.location}`), '재작업을 지시했습니다');
  }
  else if(f.id === 'f-reply' && c){
    const final = f.dataset.final === 'true', text = val('rp-text'), method = val('rp-method');
    const patch = final ? {status:'replied', repliedAt:now()} : {};
    run(f, () => store.update(c.id, patch, event(final ? 'replied' : 'notice', {text, method}), `${final ? '회신 완료' : '중간 안내'}: ${c.location}`), final ? '회신완료로 기록했습니다' : '중간 안내를 기록했습니다');
  }
  else if(f.id === 'f-report' && c){
    const kind = (e.submitter && e.submitter.value) || 'progress', text = val('rp-report');
    const patch = { status:kind };
    let waiting = [];
    if(kind === 'done'){
      patch.rework = false;
      const had = doneBy(c); had.add(S.me);
      waiting = assigneesOf(c).includes(S.me) ? assigneesOf(c).filter(id => !had.has(id)) : [];   // 담당이 아닌 접수자의 완료 보고는 바로 완료
      if(waiting.length) patch.status = 'progress';           // 다른 담당자의 완료 보고가 남아 있으면 아직 처리중
    }
    run(f, async () => store.update(c.id, patch, event(kind, Object.assign({staffId:S.me, text}, await uploadPending(c.id).then(p => p.length ? {photos:p} : {}))), `${kind === 'done' ? '완료 보고' : '진행 보고'}: ${c.location} (${staffName(S.me)})`), kind === 'done' ? (waiting.length ? `완료 보고를 올렸습니다. ${waiting.map(staffName).join(', ')}님의 보고를 기다립니다` : '완료 보고를 올렸습니다') : '진행 보고를 올렸습니다');
  }
  else if(f.id === 'f-login'){
    const btn = f.querySelector('button'); btn.disabled = true;
    sb.auth.signInWithPassword({email:val('lg-email'), password:document.getElementById('lg-pw').value})
      .then(({error}) => { if(error) toast(/invalid/i.test(error.message) ? '아이디 또는 비밀번호가 틀렸습니다' : '로그인하지 못했습니다: ' + error.message); })
      .catch(() => toast('인터넷 연결을 확인하세요'))
      .finally(() => { btn.disabled = false; });
  }
  else if(f.id === 'f-monthly'){
    if(!S.canManage) return;
    const m = currentReportMeta(), ym = S.reportMonth;
    const notes = Object.assign({}, S.settings.reportNotes, {[ym]:{note:m.note, plan:m.plan}});
    run(f, () => store.saveSettings({reportNotes:notes, reportTo:m.to, reportFrom:m.from}), `${monthLabel(ym)} 보고서 의견을 저장했습니다`);
  }
  else if(f.id === 'f-site'){
    if(!S.hq) return;
    const name = val('site-name');
    run(f, () => store.saveSite({id:'s' + uid(), name, archived:false}), `'${name}' 사업장을 추가했습니다`);
  }
  else if(f.classList.contains('site-row')){
    if(!S.hq) return;
    const st = S.db.sites.find(x => x.id === f.dataset.site), name = (f.querySelector('input').value || '').trim();
    if(!st || !name) return;
    run(f, () => store.saveSite({id:st.id, name, archived:st.archived}), '이름을 저장했습니다');
  }
  else if(f.id === 'f-user'){
    if(!S.hq) return;
    const email = val('u-email').toLowerCase(), pw = document.getElementById('u-pw').value.trim(), role = val('u-role'), site = val('u-site'), name = val('u-name');
    if(role === 'manager' && !site){ toast('관리소장은 사업장을 골라야 합니다. 본사 담당자·임원이면 역할을 바꾸세요'); return; }
    if(pw && pw.length < 6){ toast('비밀번호는 6자 이상이어야 합니다'); return; }
    const exists = S.db.users.some(u => u.email === email);
    if(!pw && !exists){ toast('새 계정은 비밀번호가 필요합니다'); return; }
    run(f, async () => {
      let how = 'assigned';
      if(pw){
        how = await store.createLogin(email, pw);
        if(how === 'exists') await store.resetPassword(email, pw);
      }
      await store.saveUser({email, role, site:role === 'manager' ? site : null, name});
      if(how === 'unconfirmed') toast('계정은 만들었지만 Supabase의 Email → Confirm email 이 켜져 있어 로그인이 안 될 수 있습니다. 꺼 주세요.');
      return how;
    }, `${email} → ${ROLE_LABEL[role]}${role === 'manager' ? ' (' + siteName(site) + ')' : ''}${pw ? ' · 비밀번호 설정됨' : ''}`);
  }
  else if(f.id === 'f-settings'){
    run(f, () => store.saveSettings({company:val('s-co') || COMPANY, buildingName:val('s-bname'), officePhone:val('s-tel'), defaultOrder:val('s-order')}), '저장했습니다');
  }
  else if(f.id === 'f-staff'){
    run(f, () => store.addStaff({name:val('st-name'), duty:val('st-duty'), createdAt:now()}), '직원을 추가했습니다');
  }
});

/* 앱이 이미 열린 상태에서 직원 링크를 누르면(주소의 #만 바뀜) 처음부터 다시 시작해 링크를 적용 */
window.addEventListener('hashchange', () => { if(/^#staff=/.test(location.hash)) location.reload(); });

/* 서버 없이 쓸 때: 같은 PC에서 관리소장 창과 직원 창을 따로 열어도 서로 반영 */
window.addEventListener('storage', e => { if(e.key === KEY && !SERVER){ loadLocal(); render(); } });

/* 처음 로그인했는데 서버가 비어 있고 이 기기에 예전 기록이 있으면 서버로 옮길지 묻는다 */
async function offerMigration(){
  const local = readLocal();
  if(!local || lsGet(MIGRATED_KEY) || !((local.complaints || []).length || (local.staff || []).length)) return;
  if(S.complaints.length || S.staff.length) return;
  if(!confirm(`이 기기에 예전 기록(민원 ${(local.complaints || []).length}건, 직원 ${(local.staff || []).length}명)이 있습니다. 서버로 옮길까요?`)){ lsSet(MIGRATED_KEY, 'skip'); return; }
  try { await write(() => importToServer(local)); lsSet(MIGRATED_KEY, '1'); await reload(); toast('예전 기록을 서버로 옮겼습니다'); }
  catch(e){ console.error(e); toast(failMsg(e)); }
}

async function onSignedIn(user){
  const first = !S.user;
  S.user = user;
  if(!first) return;
  setSync('saving', '불러오는 중');
  try {
    // touch_access: 역할을 돌려주면서 사용자 id↔이메일을 기록(사진 저장소 권한 확인용). 예전 서버면 my_access 로
    let acc;
    try { acc = await q(sb.rpc('touch_access')); }
    catch(e1){ if(/Could not find the function|schema cache/i.test(e1.message || '')) acc = await q(sb.rpc('my_access')); else throw e1; }
    S.access = acc || {}; S.oldSchema = false;
  }
  catch(e){
    console.error(e);
    // 사업장 기능이 없는 예전 서버: 예전 방식(관리소장 여부만)으로 동작하고 SQL 재실행을 안내
    S.oldSchema = e.code !== 'network' && e.code !== 'auth';
    let mgr = false;
    if(S.oldSchema){ try { mgr = !!(await q(sb.rpc('is_manager'))); } catch(e2){ mgr = true; } }
    S.access = S.oldSchema ? {role:mgr ? 'manager' : 'staff', site_id:'main'} : {};
  }
  const a = S.access;
  S.hq = a.role === 'hq'; S.exec = a.role === 'exec'; S.allSites = S.hq || S.exec;
  if(S.allSites){ S.site = lsGet('site') || 'main'; S.panel = 'hq'; }
  else if(a.site_id) S.site = a.site_id;
  if(a.role === 'staff'){ S.role = 'staff'; lsSet('role', 'staff'); }
  render();
  await reload();
  if(S.allSites && !S.db.sites.some(x => x.id === S.site && !x.archived)){ const f = S.db.sites.find(x => !x.archived); if(f){ S.site = f.id; deriveSite(); render(); } }
  subscribe();
  if(a.role === 'manager') offerMigration();
}
function onSignedOut(){
  S.user = null; S.access = {}; S.hq = false; S.exec = false; S.allSites = false; S.panel = null;
  knownIds = null; callQueue = []; renderCall();
  if(channel){ sb.removeChannel(channel); channel = null; }
  applyData(emptyData());
  photoCache.clear();
  render();
}

async function boot(){
  if(!SERVER){ loadLocal(); render(); return; }
  if(!window.supabase || !window.supabase.createClient){
    document.body.classList.add('need-login');
    $('#login').hidden = false;
    $('#login').innerHTML = '<div class="empty"><strong>서버 연결 프로그램을 불러오지 못했습니다</strong>인터넷 연결을 확인하고 새로 고침해 주세요.</div>';
    return;
  }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  setManifest();
  render();
  let session = ((await sb.auth.getSession()).data || {}).session;
  /* 직원 접속 링크(#staff=토큰): 익명 로그인 뒤 이 기기를 그 사업장 직원으로 등록 */
  const m = location.hash.match(/^#staff=([A-Za-z0-9]{16,})$/);
  if(m){
    // 주소의 #staff=… 는 일부러 남겨 둔다: 즐겨찾기나 홈 화면 아이콘으로 열어도 다시 연결되도록
    if(session && session.user.email){
      toast('이미 로그인된 계정이 있어 직원 링크를 적용하지 않았습니다. 직원 휴대폰에서 열어 주세요.');
    } else {
      try {
        if(!session){ const r = await sb.auth.signInAnonymously(); if(r.error) throw r.error; session = r.data.session; }
        await q(sb.rpc('claim_staff_link', {p_token:m[1]}));
      } catch(e){
        console.error(e);
        S.linkError = /anonymous/i.test(e.message) ? '서버에서 직원 링크 접속(Anonymous sign-ins)이 꺼져 있습니다. 본사에 문의하세요.' : /invalid/i.test(e.message) ? '이 링크는 더 이상 유효하지 않습니다.' : '연결에 실패했습니다. 인터넷을 확인하고 다시 열어 주세요.';
      }
    }
  }
  S.authReady = true;
  if(session) await onSignedIn(session.user); else render();
  sb.auth.onAuthStateChange((ev, session) => {
    if(session && session.user) onSignedIn(session.user);
    else if(ev === 'SIGNED_OUT') onSignedOut();
  });
}
boot();
})();

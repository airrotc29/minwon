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
const METHODS = ['문자','카톡','전화','방문'];

/* ---------- 저장소 ----------
 * 기본: 이 기기 브라우저(localStorage)
 * GitHub 연결 시: 비공개 저장소의 data.json 하나를 모든 기기가 같이 읽고 쓴다.
 * 쓰기는 "바꿀 내용(함수)"을 최신 데이터에 적용해 커밋하고, 그사이 다른 기기가 먼저
 * 저장했으면(sha 불일치) 최신본을 다시 받아 같은 변경을 다시 적용한다. */
const KEY = 'sunmin.minwon.v1';
const GH_KEY = 'sunmin.minwon.github';
const LOGO_KEY = 'sunmin.minwon.logo';
const DATA_PATH = 'data.json';
const POLL_MS = 20000;
const DEFAULT_SETTINGS = {company:COMPANY, buildingName:'', officePhone:''};

const S = {
  role: lsGet('role') || 'manager', filter:'open', q:'', selectedId:null, panel:null,
  me: lsGet('meStaff'), complaints:[], staff:[], settings:Object.assign({}, DEFAULT_SETTINGS),
  logo: lsGet(LOGO_KEY) || '',
  sync:{mode:'local', state:'', at:null, msg:''}
};

function emptyData(){ return {complaints:[], staff:[], settings:Object.assign({}, DEFAULT_SETTINGS)}; }
function snapshot(){ return {complaints:S.complaints, staff:S.staff, settings:S.settings}; }
function applyData(d){
  d = d || emptyData();
  S.complaints = d.complaints || [];
  S.staff = d.staff || [];
  S.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings);
  delete S.settings.logo;
}
function loadLocal(){
  try { applyData(JSON.parse(lsGet(KEY) || 'null')); } catch(e){ console.error(e); }
}
function saveLocal(d){
  if(!lsSet(KEY, JSON.stringify(d))) throw {code:'quota_exceeded'};
}

/* GitHub Contents API */
const gh = {
  cfg:null, sha:null, etag:null, timer:null,
  load(){ try { this.cfg = JSON.parse(lsGet(GH_KEY) || 'null'); } catch(e){ this.cfg = null; } return this.cfg; },
  url(){ return `https://api.github.com/repos/${this.cfg.repo}/contents/${DATA_PATH}`; },
  headers(extra){ return Object.assign({'Authorization':`Bearer ${this.cfg.token}`, 'Accept':'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28'}, extra); },
  async fetchData(force){
    const h = this.headers(!force && this.etag ? {'If-None-Match':this.etag} : {});
    const r = await fetch(this.url() + '?t=' + Date.now(), {headers:h, cache:'no-store'});
    if(r.status === 304) return {changed:false};
    if(r.status === 404){ this.sha = null; this.etag = null; return {changed:true, data:null, missing:true}; }
    if(!r.ok) throw ghError(r.status, await r.text());
    this.etag = r.headers.get('ETag');
    const meta = await r.json();
    let b64 = meta.content;
    if(!b64 || meta.encoding === 'none'){
      // 1MB가 넘으면 Contents API가 본문을 주지 않으므로 blob으로 받는다
      const br = await fetch(`https://api.github.com/repos/${this.cfg.repo}/git/blobs/${meta.sha}`, {headers:this.headers(), cache:'no-store'});
      if(!br.ok) throw ghError(br.status, await br.text());
      b64 = (await br.json()).content;
    }
    this.sha = meta.sha;
    return {changed:true, data:JSON.parse(b64dec(b64))};
  },
  async put(data, message){
    const body = {message, content:b64enc(JSON.stringify(data, null, 1))};
    if(this.sha) body.sha = this.sha;
    const r = await fetch(this.url(), {method:'PUT', headers:this.headers({'Content-Type':'application/json'}), body:JSON.stringify(body)});
    if(r.status === 409 || r.status === 422) return false;  // 다른 기기가 먼저 저장함
    if(!r.ok) throw ghError(r.status, await r.text());
    const j = await r.json();
    this.sha = j.content.sha;
    this.etag = null;
    return true;
  }
};
function ghError(status, text){
  const e = new Error(text); e.status = status;
  e.code = status === 401 ? 'gh_auth' : status === 403 ? 'gh_forbidden' : status === 404 ? 'gh_notfound' : 'gh_other';
  return e;
}
function b64enc(str){
  const bytes = new TextEncoder().encode(str);
  let bin = ''; for(let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(b64){
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length); for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
const clone = o => JSON.parse(JSON.stringify(o));

function renderSync(){
  const el = $('#sync'); if(!el) return;
  el.hidden = S.sync.mode !== 'github';
  el.className = 'sync ' + (S.sync.state || '');
  const t = S.sync.at ? `${p2(S.sync.at.getHours())}:${p2(S.sync.at.getMinutes())}` : '';
  el.textContent = S.sync.state === 'saving' ? (S.sync.msg || '저장 중…') : S.sync.state === 'error' ? `연결 오류: ${S.sync.msg}` : `동기화됨 ${t}`;
  el.title = '누르면 지금 바로 새로 고칩니다';
}
function setSync(state, msg){ S.sync.state = state; S.sync.msg = msg || ''; if(state === 'ok') S.sync.at = new Date(); renderSync(); }

/* 모든 변경은 commit(설명, 변경함수)로. 변경함수는 데이터 사본 d를 고친다. */
let queue = Promise.resolve(), committing = 0;
function commit(message, mutate){
  committing++;
  const job = queue.then(async () => {
    if(S.sync.mode !== 'github'){
      const d = clone(snapshot()); const ret = mutate(d); saveLocal(d); applyData(d); return ret;
    }
    setSync('saving');
    for(let attempt = 0; attempt < 5; attempt++){
      if(attempt > 0){ const f = await gh.fetchData(true); applyData(f.data); }
      const d = clone(snapshot());
      const ret = mutate(d);
      if(await gh.put(d, message)){
        applyData(d); saveLocal(d); setSync('ok'); return ret;
      }
    }
    throw {code:'gh_conflict'};
  });
  queue = job.catch(() => {});
  job.then(() => committing--, () => committing--);
  return job;
}

async function pull(force){
  if(S.sync.mode !== 'github' || committing) return;
  try {
    const f = await gh.fetchData(force);
    if(f.changed){ applyData(f.data); saveLocal(snapshot()); render(); }
    setSync('ok');
  } catch(e){
    console.error(e);
    setSync('error', syncErrMsg(e));
  }
}
function syncErrMsg(e){
  if(e && e.code === 'gh_auth') return '토큰이 틀렸거나 만료되었습니다';
  if(e && e.code === 'gh_forbidden') return '토큰 권한이 부족합니다(Contents 읽기·쓰기)';
  if(e && e.code === 'gh_notfound') return '저장소를 찾을 수 없습니다';
  if(!navigator.onLine) return '인터넷 연결 없음';
  return '서버 연결 오류';
}
function startPolling(){
  clearInterval(gh.timer);
  gh.timer = setInterval(() => { if(document.visibilityState === 'visible') pull(); }, POLL_MS);
}
document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'visible') pull(); });
window.addEventListener('online', () => pull());

async function connectGitHub(repo, token){
  gh.cfg = {repo, token}; gh.sha = null; gh.etag = null;
  const f = await gh.fetchData(true);       // 실패하면 여기서 오류
  lsSet(GH_KEY, JSON.stringify(gh.cfg));
  S.sync.mode = 'github';
  const local = snapshot();
  const localHas = local.complaints.length || local.staff.length;
  if(f.missing || !f.data){
    // 서버가 비어 있으면 이 기기 데이터를 처음 데이터로 올린다
    await gh.put(localHas ? local : emptyData(), '민원 처리부 데이터 시작');
    if(!localHas) applyData(emptyData());
  } else {
    const remoteHas = (f.data.complaints || []).length || (f.data.staff || []).length;
    if(localHas && !remoteHas && confirm('서버 데이터가 비어 있습니다. 이 기기에 있던 민원·직원 기록을 서버로 올릴까요?')){
      if(!await gh.put(local, '이 기기 데이터 올리기')) throw {code:'gh_conflict'};
    } else {
      applyData(f.data);
    }
  }
  saveLocal(snapshot());
  setSync('ok');
  startPolling();
}
function disconnectGitHub(){
  clearInterval(gh.timer);
  try { localStorage.removeItem(GH_KEY); } catch(e){}
  gh.cfg = null; gh.sha = null; gh.etag = null;
  S.sync = {mode:'local', state:'', at:null, msg:''};
  renderSync();
}

const store = {
  addComplaint(data){
    const id = uid();
    return commit(`민원 접수: ${data.location} ${data.title}`, d => { d.complaints.unshift(Object.assign({id}, data)); return id; });
  },
  /* patch는 덮어쓸 값, ev는 처리 내역에 덧붙일 기록 */
  update(id, patch, ev, message){
    return commit(message || '민원 처리', d => {
      const c = d.complaints.find(x => x.id === id);
      if(!c) throw {code:'gone'};
      Object.assign(c, patch, {updatedAt:now()});
      if(ev) c.events = [...(c.events || []), ev];
    });
  },
  remove(id){ return commit('민원 삭제', d => { d.complaints = d.complaints.filter(c => c.id !== id); }); },
  addStaff(data){ return commit(`직원 추가: ${data.name}`, d => { d.staff.push(Object.assign({id:uid()}, data)); }); },
  removeStaff(id){ return commit('직원 삭제', d => { d.staff = d.staff.filter(s => s.id !== id); }); },
  saveSettings(data){ return commit('설정 변경', d => { d.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings, data); }); },
  replaceAll(data){ return commit('백업 불러오기', d => { d.complaints = data.complaints || []; d.staff = data.staff || []; d.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings); }); }
};
const find = id => S.complaints.find(c => c.id === id);
const staffName = id => { const s = S.staff.find(x => x.id === id); return s ? s.name : (id ? '(명단에서 삭제된 직원)' : '미배정'); };
const lastEv = (c, type) => (c.events || []).filter(e => e.type === type).slice(-1)[0];
const isOverdue = c => c.due && (c.status === 'assigned' || c.status === 'progress') && c.due < ymd(new Date());
function numbers(){
  const m = {};
  [...S.complaints].sort((a,b) => (a.createdAt||'').localeCompare(b.createdAt||'')).forEach((c,i) => m[c.id] = i+1);
  return m;
}

/* ---------- 보기 ---------- */
function base(){
  if(S.role === 'staff') return S.me ? S.complaints.filter(c => c.assignee === S.me) : [];
  return S.complaints;
}
function filtered(){
  let b = base();
  if(S.filter === 'open') b = b.filter(c => c.status !== 'replied');
  else if(S.filter !== 'all') b = b.filter(c => c.status === S.filter);
  const q = S.q.trim();
  if(q) b = b.filter(c => [c.title, c.detail, c.location, c.complainant, c.phone, c.category, staffName(c.assignee)].some(v => String(v || '').includes(q)));
  return b;
}

function renderBrand(){
  const s = S.settings;
  const img = $('#logo'), mark = $('#logo-mark');
  const src = S.logo || 'logo.png';
  if(img.dataset.src !== src){
    img.dataset.src = src;
    img.onload = () => { img.hidden = false; mark.hidden = true; };
    img.onerror = () => { img.hidden = true; mark.hidden = false; };
    img.src = src;
  }
  $('#co-name').textContent = s.company || COMPANY;
  $('#bname').textContent = s.buildingName ? `${s.buildingName} 관리사무소` : '접수 · 지시 · 보고 · 회신';
  document.title = `${s.company || COMPANY} 민원 처리부`;
}

function render(){
  renderBrand();
  $('#role-manager').setAttribute('aria-pressed', S.role === 'manager');
  $('#role-staff').setAttribute('aria-pressed', S.role === 'staff');
  $('#mgr-tools').hidden = S.role !== 'manager';
  $('#staff-picker').hidden = S.role !== 'staff';
  const sel = $('#me-select');
  sel.innerHTML = '<option value="">이름 선택</option>' + S.staff.map(s => `<option value="${esc(s.id)}">${esc(s.name)}${s.duty ? ' · ' + esc(s.duty) : ''}</option>`).join('');
  sel.value = S.staff.some(s => s.id === S.me) ? S.me : '';

  const waiting = S.complaints.filter(c => c.status === 'done').length;
  const al = $('#reply-alert');
  al.hidden = !(S.role === 'manager' && waiting > 0);
  al.innerHTML = `<span>직원 완료 보고가 올라왔습니다. 민원인에게 결과를 알려 주세요.</span><span>회신 대기 <b>${waiting}</b>건 →</span>`;

  renderSummary(); renderList(); renderDetail();
}

function renderSummary(){
  const b = base();
  const cnt = k => k === 'all' ? b.length : k === 'open' ? b.filter(c => c.status !== 'replied').length : b.filter(c => c.status === k).length;
  const keys = ['open', ...ORDER.filter(k => S.role === 'manager' || k !== 'received'), 'all'];
  const searchVal = $('#q') ? $('#q').value : S.q;
  const hadFocus = document.activeElement && document.activeElement.id === 'q';
  $('#summary').innerHTML = keys.map(k => {
    const label = k === 'open' ? '미결' : k === 'all' ? '전체' : ST[k].chip;
    const dot = ST[k] ? `<i class="dot s-${k}"></i>` : '';
    const attn = (k === 'done' && S.role === 'manager' && cnt(k) > 0) ? ' attn' : '';
    return `<button type="button" class="chip${attn}" data-act="filter" data-f="${k}" aria-pressed="${S.filter === k}">${dot}<b>${cnt(k)}</b><span>${label}</span></button>`;
  }).join('') + `<input type="text" id="q" class="search" placeholder="검색: 이름·동호수·내용" value="${esc(searchVal)}" aria-label="민원 검색">`;
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
      <span class="l1"><span class="no">#${nums[c.id]}</span><span>${esc(c.category)}</span><span>${esc(c.location)}</span></span>
      <span class="t">${esc(c.title)}</span>
      <span class="l3"><span class="pill s-${c.status}">${ST[c.status].label}</span>
        ${c.urgent ? '<span class="tag">긴급</span>' : ''}${c.rework && c.status !== 'replied' && c.status !== 'done' ? '<span class="tag">재작업</span>' : ''}${isOverdue(c) ? '<span class="tag">기한 초과</span>' : ''}
        <span>${esc(c.assignee ? staffName(c.assignee) : '미배정')}</span><span>·</span><span>${fmt(c.createdAt)}</span></span>
    </button>`).join('');
}

/* 상세 패널: 다른 탭에서 바뀌어 다시 그릴 때 입력 중인 내용은 보존한다 */
let lastKey = null;
function renderDetail(){
  const el = $('#detail');
  const key = [S.panel, S.selectedId, S.role, S.me].join('|');
  const saved = {}, openDet = [];
  let focusId = null;
  if(key === lastKey){
    el.querySelectorAll('input[id],textarea[id],select[id]').forEach(i => { if(i.type !== 'file') saved[i.id] = i.type === 'checkbox' ? i.checked : i.value; });
    el.querySelectorAll('details[id]').forEach(d => { if(d.open) openDet.push(d.id); });
    if(el.contains(document.activeElement)) focusId = document.activeElement.id;
  }
  el.innerHTML = S.panel === 'new' ? newForm() : S.panel === 'settings' ? settingsView() : complaintView();
  for(const id in saved){ const i = document.getElementById(id); if(!i) continue; if(i.type === 'checkbox') i.checked = saved[id]; else i.value = saved[id]; }
  openDet.forEach(id => { const d = document.getElementById(id); if(d) d.open = true; });
  if(focusId){ const f = document.getElementById(focusId); if(f) f.focus(); }
  lastKey = key;
}
function resetDetail(){ lastKey = null; render(); }

const opts = (arr, sel) => arr.map(v => `<option${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
const staffOpts = sel => '<option value="">담당 직원 선택</option>' + S.staff.map(s => `<option value="${esc(s.id)}"${s.id === sel ? ' selected' : ''}>${esc(s.name)}${s.duty ? ' · ' + esc(s.duty) : ''}</option>`).join('');

/* 1. 접수 */
function newForm(){
  return `<div class="d-head"><span class="no">새 민원</span><h2>민원 접수</h2></div>
  <form id="f-new" class="sec">
    <div class="grid2">
      <label class="fld"><span>민원인 이름</span><input type="text" id="n-name" placeholder="홍길동" autocomplete="off" required></label>
      <label class="fld"><span>연락처</span><input type="tel" id="n-phone" placeholder="010-0000-0000" autocomplete="off" required></label>
      <label class="fld"><span>동</span><input type="text" id="n-dong" inputmode="numeric" placeholder="101" required></label>
      <label class="fld"><span>호수</span><input type="text" id="n-ho" inputmode="numeric" placeholder="1203"></label>
      <label class="fld"><span>분류</span><select id="n-cat">${opts(CATS,'시설')}</select></label>
      <label class="fld"><span>접수 경로</span><select id="n-ch">${opts(CHANNELS,'전화')}</select></label>
    </div>
    <label class="check"><input type="checkbox" id="n-urgent"> 긴급 처리</label>
    <label class="fld"><span>민원 제목</span><input type="text" id="n-title" placeholder="거실 천장 누수" required></label>
    <label class="fld"><span>민원 내용</span><textarea id="n-detail" placeholder="민원인이 말한 내용을 그대로 적어 두세요."></textarea></label>
    <p class="hint">공용부 민원은 동에 장소(예: 지하 2층 주차장)를 적고 호수는 비워 두세요.</p>
    <div class="btns"><button type="button" class="btn" data-act="cancel">취소</button><button type="submit" class="btn primary">접수하기</button></div>
  </form>`;
}

function settingsView(){
  const s = S.settings;
  return `<div class="d-head"><span class="no">설정</span><h2>직원·설정</h2></div>
  <form id="f-settings" class="sec">
    <h3>관리사무소 정보</h3>
    <p class="hint">민원인 회신 문구 머리말과 문의처에 들어갑니다.</p>
    <div class="grid2">
      <label class="fld"><span>회사명</span><input type="text" id="s-co" value="${esc(s.company)}" placeholder="${COMPANY}"></label>
      <label class="fld"><span>단지·건물명</span><input type="text" id="s-bname" value="${esc(s.buildingName)}" placeholder="○○아파트"></label>
      <label class="fld"><span>관리사무소 연락처</span><input type="tel" id="s-tel" value="${esc(s.officePhone)}" placeholder="02-000-0000"></label>
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
    ${S.staff.length ? `<ul class="staff-list">${S.staff.map(st => `<li><span>${esc(st.name)} <span class="r">${esc(st.duty || '')}</span></span><button type="button" class="btn sm danger" data-act="del-staff" data-id="${esc(st.id)}">삭제</button></li>`).join('')}</ul>` : '<p class="hint">등록된 직원이 없습니다. 지시하려면 먼저 직원을 등록하세요.</p>'}
    <form id="f-staff" class="grid2">
      <label class="fld"><span>이름</span><input type="text" id="st-name" required placeholder="이름"></label>
      <label class="fld"><span>담당 업무</span><input type="text" id="st-duty" placeholder="전기 / 설비 / 경비 / 미화"></label>
      <div class="btns" style="align-self:end"><button type="submit" class="btn">직원 추가</button></div>
    </form>
  </div>
  ${githubSection()}
  <div class="sec act">
    <h3>데이터 백업</h3>
    <p class="hint">민원 기록은 이 기기의 브라우저에 저장됩니다. 브라우저 기록을 지우면 함께 지워지니 정기적으로 백업 파일을 받아 두세요. 다른 PC로 옮길 때도 백업 파일을 불러오면 됩니다.</p>
    <div class="btns">
      <button type="button" class="btn" data-act="export">백업 파일 받기</button>
      <label class="btn">백업 불러오기<input type="file" id="import-file" accept="application/json,.json" hidden></label>
    </div>
  </div>
  <div class="btns"><button type="button" class="btn" data-act="cancel">닫기</button></div>`;
}

function githubSection(){
  if(S.sync.mode === 'github' && gh.cfg){
    return `<div class="sec act">
      <h3>여러 기기 같이 쓰기 (GitHub)</h3>
      <div class="conn"><span>연결된 저장소 <code>${esc(gh.cfg.repo)}</code></span><span class="hint">${S.sync.state === 'error' ? '연결 오류: ' + esc(S.sync.msg) : '모든 기기가 이 저장소의 data.json을 같이 씁니다. 20초마다 새 내용을 받아옵니다.'}</span></div>
      <p class="hint">직원 휴대폰에서 아래 링크를 한 번 열면 자동으로 연결됩니다. 링크에 접속 토큰이 들어 있으니 직원에게만 개별로 보내세요.</p>
      <div class="btns">
        <button type="button" class="btn" data-act="gh-link" data-role="staff">직원용 연결 링크 복사</button>
        <button type="button" class="btn" data-act="gh-link" data-role="manager">관리소장용 링크 복사</button>
        <button type="button" class="btn" data-act="sync-now">지금 새로 고침</button>
        <span class="spacer"></span>
        <button type="button" class="btn danger" data-act="gh-disconnect">이 기기 연결 끊기</button>
      </div>
    </div>`;
  }
  return `<form id="f-gh" class="sec act">
    <h3>여러 기기 같이 쓰기 (GitHub)</h3>
    <p class="hint">지금은 이 기기에만 저장됩니다. 비공개 GitHub 저장소와 토큰을 넣으면 소장님 PC와 직원 휴대폰이 같은 민원 기록을 함께 씁니다. 처음 연결할 때 이 기기 기록을 서버로 올릴 수 있습니다.</p>
    <div class="grid2">
      <label class="fld"><span>데이터 저장소 (비공개)</span><input type="text" id="gh-repo" placeholder="airrotc29/minwon-data" required autocomplete="off"></label>
      <label class="fld"><span>토큰</span><input type="password" id="gh-token" placeholder="github_pat_…" required autocomplete="off"></label>
    </div>
    <div class="btns"><button type="submit" class="btn primary">연결</button></div>
  </form>`;
}

const EV = {
  received:{c:'--st-received', t:() => '민원 접수'},
  assigned:{c:'--st-assigned', t:e => `${staffName(e.staffId)}에게 지시`},
  reassigned:{c:'--st-assigned', t:e => `${staffName(e.staffId)}에게 재지시`},
  rework:{c:'--urgent', t:e => `재작업 지시 → ${staffName(e.staffId)}`},
  progress:{c:'--st-progress', t:e => `${staffName(e.staffId)} 진행 보고`},
  done:{c:'--st-done', t:e => `${staffName(e.staffId)} 완료 보고`},
  notice:{c:'--accent', t:e => `민원인 중간 안내 (${e.method || ''})`},
  replied:{c:'--st-replied', t:e => `민원인 회신 완료 (${e.method || ''})`}
};

function complaintView(){
  const c = find(S.selectedId);
  if(!c){
    return `<div class="empty"><strong>${S.role === 'manager' ? '민원을 선택하세요' : '지시를 선택하세요'}</strong>${S.role === 'manager'
      ? '왼쪽 목록에서 민원을 고르면 처리 내역과 지시·회신 화면이 열립니다. <b>회신 대기</b> 숫자는 직원 완료 보고가 올라와 민원인에게 알려야 하는 건입니다.'
      : '왼쪽 목록에서 지시를 고르면 지시 내용을 보고 진행·완료 보고를 올릴 수 있습니다.'}</div>`;
  }
  const no = numbers()[c.id];
  const mine = S.role === 'staff' && c.assignee === S.me;
  const tel = (c.phone || '').replace(/[^0-9+]/g, '');
  const order = (c.instruction && c.status !== 'received') ? `<div class="order${c.rework ? ' rework' : ''}"><span class="k">${c.rework ? '재작업 지시' : '지시 사항'} · ${esc(staffName(c.assignee))}${c.due ? ' · 기한 ' + fmtDate(c.due) : ''}</span><p>${esc(c.instruction)}</p></div>` : '';
  return `
  <div class="d-head">
    <span class="no">#${no} · 접수 ${fmt(c.createdAt)}</span>
    <h2>${esc(c.title)}</h2>
    <div class="pills"><span class="pill s-${c.status}">${ST[c.status].label}</span>${c.urgent ? '<span class="tag">긴급</span>' : ''}${isOverdue(c) ? '<span class="tag">기한 초과</span>' : ''}</div>
  </div>
  <dl class="meta">
    <div><dt>민원인</dt><dd>${esc(c.complainant || '-')}</dd></div>
    <div><dt>연락처</dt><dd>${c.phone ? `<a class="phone" href="tel:${esc(tel)}">${esc(c.phone)}</a><button type="button" class="btn sm" data-act="copy" data-text="${esc(c.phone)}">복사</button>` : '-'}</dd></div>
    <div><dt>동·호수</dt><dd>${esc(c.location)}</dd></div>
    <div><dt>분류 · 경로</dt><dd>${esc(c.category)} · ${esc(c.channel)}</dd></div>
  </dl>
  ${c.detail ? `<p class="body-text">${esc(c.detail)}</p>` : ''}
  ${order}
  <div class="sec"><h3>처리 내역</h3>
    <ol class="tl">${(c.events || []).map(e => { const d = EV[e.type] || EV.received; return `<li style="--c:var(${d.c})"><div class="h"><b>${esc(d.t(e))}</b><time>${fmt(e.at)}</time>${e.due ? `<span class="sub">기한 ${fmtDate(e.due)}</span>` : ''}</div>${e.text ? `<p>${esc(e.text)}</p>` : ''}</li>`; }).join('')}</ol>
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
        <label class="fld"><span>담당 직원</span><select id="as-staff" required>${staffOpts(c.assignee)}</select></label>
        <label class="fld"><span>처리 기한</span><input type="date" id="as-due" value="${esc(c.due || defaultDue || '')}"></label>
      </div>
      <label class="fld"><span>지시 사항</span><textarea id="as-text" required placeholder="예) 오늘 오후 세대 방문해 누수 위치 확인, 윗집 1303호 협조 요청 후 결과 보고"></textarea></label>
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
        <p class="hint">${c.phone ? `연락처 <span class="phone">${esc(c.phone)}</span> · ` : ''}문구를 고친 뒤 복사해 문자나 카톡으로 보내고, 보낸 방법을 기록하세요.</p>
        <textarea id="rp-text" rows="9">${esc(replyTemplate(c))}</textarea>
        <div class="btns">
          <button type="button" class="btn" data-act="copy-reply">문구 복사</button>
          ${c.phone ? '<button type="button" class="btn" data-act="sms">문자 앱 열기</button>' : ''}
          <button type="button" class="btn" data-act="reset-reply">기본 문구로</button>
          <span class="spacer"></span>
          <select id="rp-method" style="width:auto" aria-label="보낸 방법">${opts(METHODS,'문자')}</select>
          <button type="submit" class="btn primary">${final ? '회신완료로 기록' : '안내 기록'}</button>
        </div>
      </form>
    ${final ? '</div>' : '</details>'}`;
  }
  if(c.status === 'done'){
    html += `<details class="more" id="dt-rework"><summary>보고가 부족하면: 재작업 지시</summary>
      <form id="f-redo" class="sec">
        <label class="fld"><span>${esc(staffName(c.assignee))}에게 다시 지시할 내용</span><textarea id="rw-text" required placeholder="예) 천장 얼룩 부분 사진 첨부 후 재보고 바랍니다"></textarea></label>
        <label class="fld" style="max-width:220px"><span>새 처리 기한</span><input type="date" id="rw-due" value="${esc(c.due || '')}"></label>
        <div class="btns"><button type="submit" class="btn danger">재작업 지시</button></div>
      </form></details>`;
  }
  html += `<div class="btns" style="justify-content:flex-end"><button type="button" class="btn sm danger" data-act="del" data-id="${esc(c.id)}">민원 삭제</button></div>`;
  return html;
}

/* 3. 직원: 진행 보고 · 완료 보고 */
function staffActions(c, mine){
  if(!mine) return '<p class="hint">내게 지시된 민원이 아닙니다.</p>';
  if(c.status === 'done') return '<div class="act"><p class="hint">완료 보고를 올렸습니다. 소장이 확인 후 민원인에게 회신합니다.</p></div>';
  if(c.status === 'replied') return '<div class="act"><p class="hint">민원인 회신까지 끝난 민원입니다.</p></div>';
  return `<div class="act"><form id="f-report" class="sec">
    <h3>처리 결과 보고</h3>
    <label class="fld"><span>보고 내용</span><textarea id="rp-report" required placeholder="예) 1303호 욕실 배관 누수 확인. 배관 교체 완료, 1203호 천장 건조 후 도배는 세대에서 진행하기로 함"></textarea></label>
    <div class="btns"><button type="submit" class="btn" value="progress">진행 보고</button><button type="submit" class="btn primary" value="done">완료 보고</button></div>
    <p class="hint">진행 보고는 상태를 ‘처리중’으로, 완료 보고는 ‘처리완료’로 바꾸고 소장에게 회신 대기로 알립니다.</p>
  </form></div>`;
}

/* 민원인 안내 문구 자동 생성 */
function replyTemplate(c){
  const s = S.settings;
  const head = [s.company || COMPANY, s.buildingName ? `${s.buildingName} 관리사무소` : '관리사무소'].join(' ');
  const tel = s.officePhone ? `\n문의: 관리사무소 ${s.officePhone}` : '';
  const name = c.complainant ? `${c.complainant}님, 안녕하세요.\n` : '';
  const where = [c.location, c.title].filter(Boolean).join(' / ');
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
  if(e && e.code === 'gh_conflict') return '다른 기기와 동시에 저장이 겹쳤습니다. 잠시 후 다시 시도하세요.';
  if(e && String(e.code).startsWith('gh_')) return '서버(GitHub)에 저장하지 못했습니다: ' + syncErrMsg(e);
  if(e instanceof TypeError) return '인터넷 연결을 확인하세요. 저장되지 않았습니다.';
  return '저장하지 못했습니다. 잠시 후 다시 시도하세요.';
}
async function run(form, fn, okMsg){
  const btns = form ? form.querySelectorAll('button') : [];
  btns.forEach(b => b.disabled = true);
  try { await fn(); toast(okMsg); resetDetail(); }
  catch(e){ console.error(e); if(S.sync.mode === 'github' && e && String(e.code).startsWith('gh_')) setSync('error', syncErrMsg(e)); toast(failMsg(e)); render(); }
  finally { btns.forEach(b => b.disabled = false); }
}
async function copyText(text, fallbackEl){
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); }
  catch(e){ if(fallbackEl){ fallbackEl.focus(); fallbackEl.select && fallbackEl.select(); } toast('자동 복사가 막혀 있습니다. 선택된 글을 Ctrl+C로 복사하세요.'); }
}
const val = id => (document.getElementById(id).value || '').trim();
const event = (type, extra) => Object.assign({type, at:now()}, extra);

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
  if(a === 'role'){ S.role = b.dataset.role; lsSet('role', S.role); S.panel = null; S.filter = 'open'; S.selectedId = null; render(); }
  else if(a === 'filter'){ S.filter = b.dataset.f; render(); }
  else if(a === 'open'){ S.selectedId = b.dataset.id; S.panel = null; render(); if(matchMedia('(max-width:820px)').matches) $('#detail').scrollIntoView({block:'start'}); }
  else if(a === 'new'){ S.panel = 'new'; render(); $('#detail').scrollIntoView({block:'nearest'}); const f = document.getElementById('n-name'); if(f) f.focus(); }
  else if(a === 'settings'){ S.panel = 'settings'; render(); $('#detail').scrollIntoView({block:'nearest'}); }
  else if(a === 'cancel'){ S.panel = null; render(); }
  else if(a === 'copy'){ copyText(b.dataset.text); }
  else if(a === 'copy-reply'){ const t = document.getElementById('rp-text'); copyText(t.value, t); }
  else if(a === 'sms'){
    const c = find(S.selectedId); if(!c) return;
    const tel = c.phone.replace(/[^0-9+]/g, '');
    const sep = /iPhone|iPad|Mac/.test(navigator.userAgent) ? '&' : '?';
    location.href = `sms:${tel}${sep}body=${encodeURIComponent(val('rp-text'))}`;
  }
  else if(a === 'reset-reply'){ const c = find(S.selectedId); if(c) document.getElementById('rp-text').value = replyTemplate(c); }
  else if(a === 'sync-now'){ pull(true); }
  else if(a === 'gh-disconnect'){
    if(!confirm('이 기기의 서버 연결을 끊을까요? 서버 데이터는 그대로 남고, 이 기기에는 마지막으로 받은 내용이 남습니다.')) return;
    disconnectGitHub(); toast('연결을 끊었습니다'); resetDetail();
  }
  else if(a === 'gh-link'){
    const payload = encodeURIComponent(b64enc(JSON.stringify({repo:gh.cfg.repo, token:gh.cfg.token, role:b.dataset.role})));
    copyText(location.origin + location.pathname + '#connect=' + payload);
  }
  else if(a === 'del-staff'){ run(null, () => store.removeStaff(b.dataset.id), '직원을 명단에서 뺐습니다'); }
  else if(a === 'logo-clear'){ try { localStorage.removeItem(LOGO_KEY); } catch(e){} S.logo = ''; toast('이 기기 로고를 지웠습니다'); resetDetail(); }
  else if(a === 'export'){
    const blob = new Blob([JSON.stringify(snapshot(), null, 2)], {type:'application/json'});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `민원백업_${ymd(new Date())}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  else if(a === 'del'){
    if(delArm !== b.dataset.id){ delArm = b.dataset.id; b.textContent = '한 번 더 누르면 삭제됩니다'; setTimeout(() => { if(delArm === b.dataset.id){ delArm = null; b.textContent = '민원 삭제'; } }, 4000); return; }
    delArm = null; const id = b.dataset.id; S.selectedId = null;
    run(null, () => store.remove(id), '민원을 삭제했습니다');
  }
});
document.addEventListener('input', e => {
  if(e.target.id === 'q'){ S.q = e.target.value; renderList(); }
});
document.addEventListener('change', async e => {
  if(e.target.id === 'logo-file' && e.target.files[0]){
    try { const data = await readImage(e.target.files[0], 400); if(!lsSet(LOGO_KEY, data)) throw 0; S.logo = data; toast('로고를 바꿨습니다'); resetDetail(); }
    catch(err){ toast('이미지를 읽지 못했습니다'); }
  }
  if(e.target.id === 'import-file' && e.target.files[0]){
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if(!Array.isArray(d.complaints)) throw new Error('형식');
      if(!confirm(`민원 ${d.complaints.length}건이 든 백업으로 지금 데이터를 바꿀까요?`)) return;
      S.selectedId = null;
      run(null, () => store.replaceAll(d), '백업을 불러왔습니다');
    } catch(err){ toast('백업 파일을 읽지 못했습니다'); }
    finally { e.target.value = ''; }
  }
});
$('#me-select').addEventListener('change', e => { S.me = e.target.value || null; lsSet('meStaff', S.me || ''); S.selectedId = null; render(); });

document.addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target, c = find(S.selectedId);
  if(f.id === 'f-new'){
    const at = now(), ch = val('n-ch'), dong = val('n-dong'), ho = val('n-ho');
    const location = /^\d+$/.test(dong) ? `${dong}동${ho ? ' ' + ho + (/^\d+$/.test(ho) ? '호' : '') : ''}` : [dong, ho].filter(Boolean).join(' ');
    const data = { title:val('n-title'), detail:val('n-detail'), location, dong, ho, complainant:val('n-name'), phone:val('n-phone'),
      category:val('n-cat'), channel:ch, urgent:document.getElementById('n-urgent').checked, status:'received',
      assignee:null, instruction:'', due:'', rework:false, createdAt:at, updatedAt:at, events:[event('received', {at, text:`${ch}(으)로 접수`})] };
    run(f, async () => { const id = await store.addComplaint(data); S.selectedId = id; S.panel = null; S.filter = 'open'; }, '민원을 접수했습니다. 담당 직원에게 지시하세요.');
  }
  else if(f.id === 'f-assign' && c){
    const sid = val('as-staff'); if(!sid){ toast('담당 직원을 선택하세요'); return; }
    const text = val('as-text'), due = val('as-due');
    const type = c.assignee ? 'reassigned' : 'assigned';
    const keep = c.status === 'progress' && c.assignee === sid;
    run(f, () => store.update(c.id, { assignee:sid, instruction:text, due, status: keep ? 'progress' : 'assigned', rework:false },
      event(type, {staffId:sid, text, due}), `지시: ${c.location} → ${staffName(sid)}`), `${staffName(sid)}에게 지시했습니다`);
  }
  else if(f.id === 'f-redo' && c){
    const text = val('rw-text'), due = val('rw-due') || c.due;
    run(f, () => store.update(c.id, { instruction:text, due, status:'assigned', rework:true },
      event('rework', {staffId:c.assignee, text, due}), `재작업 지시: ${c.location}`), '재작업을 지시했습니다');
  }
  else if(f.id === 'f-reply' && c){
    const final = f.dataset.final === 'true', text = val('rp-text'), method = val('rp-method');
    const patch = final ? {status:'replied', repliedAt:now()} : {};
    run(f, () => store.update(c.id, patch, event(final ? 'replied' : 'notice', {text, method}), `${final ? '회신 완료' : '중간 안내'}: ${c.location}`), final ? '회신완료로 기록했습니다' : '중간 안내를 기록했습니다');
  }
  else if(f.id === 'f-report' && c){
    const kind = (e.submitter && e.submitter.value) || 'progress', text = val('rp-report');
    const patch = { status:kind };
    if(kind === 'done') patch.rework = false;
    run(f, () => store.update(c.id, patch, event(kind, {staffId:S.me, text}), `${kind === 'done' ? '완료 보고' : '진행 보고'}: ${c.location} (${staffName(S.me)})`), kind === 'done' ? '완료 보고를 올렸습니다' : '진행 보고를 올렸습니다');
  }
  else if(f.id === 'f-gh'){
    const repo = val('gh-repo').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''), token = val('gh-token');
    if(!/^[\w.-]+\/[\w.-]+$/.test(repo)){ toast('저장소는 "계정/저장소이름" 형식으로 넣으세요'); return; }
    const btns = f.querySelectorAll('button'); btns.forEach(x => x.disabled = true);
    connectGitHub(repo, token)
      .then(() => { toast('연결했습니다. 이제 다른 기기와 함께 씁니다.'); resetDetail(); })
      .catch(err => { console.error(err); gh.cfg = null; S.sync.mode = 'local'; renderSync(); toast('연결 실패: ' + syncErrMsg(err)); })
      .finally(() => btns.forEach(x => x.disabled = false));
  }
  else if(f.id === 'f-settings'){
    run(f, () => store.saveSettings({company:val('s-co') || COMPANY, buildingName:val('s-bname'), officePhone:val('s-tel')}), '저장했습니다');
  }
  else if(f.id === 'f-staff'){
    run(f, () => store.addStaff({name:val('st-name'), duty:val('st-duty'), createdAt:now()}), '직원을 추가했습니다');
  }
});

/* 같은 PC에서 관리소장 창과 직원 창을 따로 열어도 서로 반영 */
window.addEventListener('storage', e => { if(e.key === KEY && S.sync.mode === 'local'){ loadLocal(); render(); } });

/* 직원 연결 링크(#connect=...)로 열면 자동 연결 */
async function boot(){
  loadLocal();
  const m = location.hash.match(/^#connect=(.+)$/);
  if(m){
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const c = JSON.parse(b64dec(decodeURIComponent(m[1])));
      if(c.repo && c.token){ lsSet(GH_KEY, JSON.stringify({repo:c.repo, token:c.token})); if(c.role) { S.role = c.role; lsSet('role', c.role); } }
    } catch(e){ toast('연결 링크가 올바르지 않습니다'); }
  }
  render();
  if(gh.load()){
    S.sync.mode = 'github';
    setSync('saving', '불러오는 중');
    await pull(true);
    startPolling();
  }
}
boot();
})();

// 선민종합관리 민원관리 System · 앱이 꺼져 있어도 울리는 알림(웹 푸시) 보내기
// Supabase 대시보드 → Edge Functions → 새 함수 이름 'send-push' → 이 파일 내용을 붙여넣고 Deploy
// → 함수 설정에서 'Enforce JWT verification(JWT 확인)'을 끕니다(DB가 비밀 머리글로 부르기 때문).
// 알림 서명 키(VAPID)는 처음 실행될 때 스스로 만들어 DB(push_secret)에 저장하므로 따로 넣을 값이 없습니다.
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const sb = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function secrets() {
  const { data, error } = await sb.from('push_secret').select('*').eq('id', 1).maybeSingle();
  if (error || !data) throw new Error('push_secret 없음: schema.sql을 먼저 실행하세요');
  if (data.vapid_private && data.vapid_public) return data;
  const k = webpush.generateVAPIDKeys();
  // 동시에 두 번 불려도 한 번만 저장되도록 비어 있을 때만 채운다
  await sb.from('push_secret').update({ vapid_public: k.publicKey, vapid_private: k.privateKey }).eq('id', 1).is('vapid_private', null);
  const { data: again } = await sb.from('push_secret').select('*').eq('id', 1).single();
  await sb.from('push_config').update({ vapid_public: again.vapid_public }).eq('id', 1);
  return again;
}

const place = c => c.location || [c.dong, c.ho].filter(Boolean).join(' ') || '';
const short = (t, n = 60) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// 누구에게 무엇을 보낼지 정한다(순수 함수: 시험하기 쉽도록 분리)
export function plan(p, c, subs) {
  const d = (c && c.data) || {};
  const notActor = s => !p.actor || s.user_id !== p.actor;
  const inSite = s => s.site_id === p.site_id;
  if (p.kind === 'new') {
    return {
      to: subs.filter(s => inSite(s) && (s.role === 'manager' || s.role === 'staff') && notActor(s)),
      msg: { title: `🔔 새 민원 접수${d.urgent ? ' (긴급)' : ''}`, body: short(`${place(d)} ${d.category || ''} · ${d.title || ''}`), tag: `new-${p.id}` },
    };
  }
  if (p.kind === 'assigned' || p.kind === 'reassigned' || p.kind === 'rework') {
    const ev = p.event || {};
    const ids = (ev.staffIds && ev.staffIds.length ? ev.staffIds : [ev.staffId]).filter(Boolean);
    return {
      to: subs.filter(s => inSite(s) && s.role === 'staff' && ids.includes(s.staff_id) && notActor(s)),
      msg: { title: p.kind === 'rework' ? '🔁 재작업 지시' : '📋 새 지시가 왔습니다', body: short(`${place(d)} · ${d.title || ''}${ev.text ? ' — ' + ev.text : ''}`), tag: `job-${p.id}` },
    };
  }
  if (p.kind === 'done' && d.status === 'done') {
    return {
      to: subs.filter(s => inSite(s) && s.role === 'manager' && notActor(s)),
      msg: { title: '💬 완료 보고 · 민원인에게 회신해 주세요', body: short(`${place(d)} · ${d.title || ''}`), tag: `done-${p.id}` },
    };
  }
  return { to: [], msg: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const k = await secrets();
    if (req.method === 'GET') return json({ publicKey: k.vapid_public });          // 앱이 알림 등록에 쓰는 공개 키
    if (req.headers.get('x-push-secret') !== k.hook) return json({ error: 'forbidden' }, 403);
    const p = await req.json();
    const { data: c } = await sb.from('complaints').select('id, site_id, data').eq('id', p.id).maybeSingle();
    if (!c) return json({ sent: 0, reason: 'gone' });
    const { data: subs } = await sb.from('push_subs').select('*').eq('site_id', p.site_id);
    const { to, msg } = plan(p, c, subs || []);
    if (!msg || !to.length) return json({ sent: 0 });
    webpush.setVapidDetails('mailto:admin@sunmin.kr', k.vapid_public, k.vapid_private);
    let sent = 0;
    await Promise.all(to.map(async (s) => {
      try { await webpush.sendNotification(s.sub, JSON.stringify({ ...msg, id: p.id }), { TTL: 60 * 60 * 12, urgency: 'high' }); sent++; }
      catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await sb.from('push_subs').delete().eq('endpoint', s.endpoint); }
    }));
    return json({ sent, of: to.length });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
});

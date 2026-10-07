// 선민종합관리 민원관리 System · 월간 보고서 'AI 검토 결과' 만들기
// Supabase 대시보드 → Edge Functions → 새 함수 이름 'ai-review' → 이 파일 내용을 붙여넣고 Deploy
// → 'Enforce JWT verification(JWT 확인)'은 켜 둡니다(로그인한 관리소장·본사만 부를 수 있게).
// → Edge Functions → Secrets 에 ANTHROPIC_API_KEY 를 넣습니다(키는 저장소·앱 코드에 절대 넣지 않습니다).
// 앱은 그 달의 집계(건수·분류·동·담당·민원 요지)만 보냅니다. 민원인 전화번호·이름은 보내지 않습니다.
import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SYSTEM = `당신은 공동주택·집합건물 위탁관리회사(선민종합관리)의 관리소장을 돕는 보고서 검토자입니다.
관리소장이 관리단(입주자대표·관리위원회)에 제출하는 월간 민원 처리 현황 보고서의 두 칸을 씁니다.
- 특이사항 및 관리소장 의견: 이달 수치와 전월 대비 변화, 반복·집중된 민원(분류·동·장소), 긴급 건, 미결·이월 건과 그 사유, 기한 준수, 담당자 처리 부담 등 데이터가 보여 주는 사실을 근거로 관리소장의 판단을 적습니다.
- 다음 달 계획: 위 의견에서 나온 후속 조치(점검·보수·안내문·업체 협의·예산 검토 등)와 계절 요인(다음 달 기준)을 구체적으로 적습니다.
원칙:
- 받은 데이터에 있는 숫자와 사실만 씁니다. 없는 수치·업체명·비용·날짜를 지어내지 않습니다. 추정은 "~로 보임", "~ 확인 예정"처럼 표시합니다.
- 관리단이 읽는 공식 보고 문체(합니다체 대신 간결한 개조식 "~함", "~ 예정")로 씁니다.
- 각 항목은 "- "로 시작하는 한 줄로, 의견 3~6줄, 계획 3~6줄로 씁니다. 머리말·맺음말·마크다운 굵게 표시는 쓰지 않습니다.
- 민원인 개인을 특정할 수 있는 정보는 쓰지 않습니다.
출력 형식(이 두 태그만 출력):
<note>
- ...
</note>
<plan>
- ...
</plan>`;

const pick = (text: string, tag: string) => {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
  try {
    // 부른 사람이 관리소장(그 사업장) 또는 본사인지 확인한다
    const auth = req.headers.get('Authorization') || '';
    const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } }, auth: { persistSession: false },
    });
    const { data: acc, error: accErr } = await user.rpc('my_access');
    if (accErr) return json({ error: '권한을 확인하지 못했습니다' }, 401);
    const body = await req.json();
    const role = acc && acc.role;
    if (!(role === 'hq' || (role === 'manager' && acc.site_id === body.site))) return json({ error: '관리소장·본사만 쓸 수 있습니다' }, 403);

    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return json({ error: 'ANTHROPIC_API_KEY 비밀값이 없습니다' }, 500);
    const data = JSON.stringify(body.data || {}).slice(0, 60000);

    const client = new Anthropic({ apiKey: key });
    // fallbacks "default": 드물게 요청이 거절되면 서버가 권장 대체 모델로 다시 실행한다
    const res = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: `다음은 ${body.month || ''} 민원 처리 데이터(JSON)입니다. 이 데이터를 근거로 두 칸을 작성하세요.\n\n${data}` }],
    } as any);
    if (res.stop_reason === 'refusal') return json({ error: 'AI가 이 요청에 답하지 않았습니다. 잠시 후 다시 시도하세요.' }, 502);
    const text = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    const note = pick(text, 'note'), plan = pick(text, 'plan');
    if (!note && !plan) return json({ error: 'AI 결과 형식이 올바르지 않습니다' }, 502);
    return json({ note, plan, model: res.model });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

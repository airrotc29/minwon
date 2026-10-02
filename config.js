/* 서버(Supabase) 연결 정보
 * Supabase 대시보드 → Project Settings → API(또는 Data API / API Keys)에서 복사해 넣습니다.
 *   supabaseUrl : Project URL        예) https://abcdefgh.supabase.co
 *   supabaseKey : Publishable key(sb_publishable_…) 또는 anon public key
 * 이 키는 웹페이지에 공개되는 용도의 키입니다. 데이터는 로그인한 사람만 볼 수 있도록
 * supabase/schema.sql의 보안 규칙(RLS)으로 막혀 있습니다.
 * service_role / secret 키는 절대 넣지 마세요.
 * 두 값이 비어 있으면 서버 없이 이 기기에만 저장합니다. */
window.MINWON_CONFIG = {
  supabaseUrl: 'https://yqmlesdwcuaqlqzrptpp.supabase.co',
  supabaseKey: ''
};

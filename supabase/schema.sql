-- 선민종합관리 민원 처리부 · Supabase 데이터베이스 설정 (여러 사업장 지원)
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run 을 누르세요.
-- 여러 번 실행해도 안전하고, 예전 버전에서 올릴 때 기존 민원 기록은 '기본 사업장(main)'에 그대로 남습니다.
--
-- 역할 (app_users 표에서 지정, 본사 담당자가 앱의 「본사」 화면에서 관리)
--   hq      본사 담당자 : 모든 사업장을 보고 관리, 사업장·계정 관리
--   manager 관리소장    : 자기 사업장의 지시·회신·재작업·삭제·직원 명단·설정·월간 보고
--   staff   직원        : 자기 사업장의 접수, 진행·완료 보고, 사진 올리기만
--                        (아이디·비밀번호 없이 관리소장이 만든 '직원 접속 링크'로 들어온다 → staff_sessions)
--
-- Supabase 대시보드에서 한 번 켜 둘 것 (Authentication → Sign In / Providers):
--   · Anonymous sign-ins: ON      (직원이 링크만으로 들어오기 위해)
--   · Allow new users to sign up: ON, Email → Confirm email: OFF  (본사가 앱에서 관리소장 계정을 만들기 위해)
--   지정되지 않은 계정은 로그인해도 아무것도 볼 수 없으므로 가입이 열려 있어도 기록은 보호됩니다.

-- 1) 표 ------------------------------------------------------------------
create table if not exists public.sites (             -- 사업장(단지·건물)
  id         text primary key,
  name       text not null,
  archived   boolean not null default false,          -- 계약 종료 등으로 더 쓰지 않는 사업장
  created_at timestamptz not null default now()
);
create table if not exists public.complaints (        -- 민원 한 건
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,      -- 동·호수, 제목, 상태, 담당, 기한 …
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.events (            -- 처리 내역(접수·지시·보고·회신), 추가만 함
  id           text primary key,
  complaint_id text not null references public.complaints(id) on delete cascade,
  data         jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists events_complaint_id_idx on public.events(complaint_id);
create table if not exists public.staff (             -- 직원 명단
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.settings (          -- 사업장별 설정 (id = 사업장 id)
  id   text primary key,
  data jsonb not null default '{}'::jsonb
);
create table if not exists public.staff_sessions (    -- 직원 링크로 들어온 기기(익명 로그인) → 사업장
  user_id    uuid primary key,
  site_id    text not null references public.sites(id),
  token      text not null,                           -- 들어올 때 쓴 링크 토큰(링크를 새로 만들면 무효)
  created_at timestamptz not null default now()
);
create table if not exists public.user_roles (        -- 로그인한 사용자 id → 이메일 (사진 저장소처럼 이메일을 못 읽는 곳에서 역할 확인용)
  user_id    uuid primary key,
  email      text not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.app_users (         -- 로그인 계정 → 역할·사업장
  email      text primary key,
  role       text not null check (role in ('hq', 'manager', 'staff')),
  site_id    text references public.sites(id),        -- hq 는 비움
  name       text,
  created_at timestamptz not null default now()
);

-- 사업장 칸 추가(예전 버전에서 올릴 때) — 기존 기록은 모두 기본 사업장 'main'
alter table public.complaints add column if not exists site_id text not null default 'main';
alter table public.events     add column if not exists site_id text not null default 'main';
alter table public.staff      add column if not exists site_id text not null default 'main';
alter table public.sites      add column if not exists staff_token text unique;   -- 직원 접속 링크
create extension if not exists pgcrypto with schema extensions;
create index if not exists complaints_site_idx on public.complaints(site_id);
create index if not exists events_site_idx     on public.events(site_id);
create index if not exists staff_site_idx      on public.staff(site_id);

-- 기본 사업장 보장: 예전 설정의 단지명을 이름으로 쓴다
insert into public.sites(id, name)
  select 'main', coalesce(nullif(data->>'buildingName', ''), '사업장 1') from public.settings where id = 'main'
  on conflict (id) do nothing;
insert into public.sites(id, name) values ('main', '사업장 1') on conflict (id) do nothing;
update public.events e set site_id = c.site_id from public.complaints c where c.id = e.complaint_id and e.site_id <> c.site_id;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'complaints_site_fk') then
    alter table public.complaints add constraint complaints_site_fk foreign key (site_id) references public.sites(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_site_fk') then
    alter table public.staff add constraint staff_site_fk foreign key (site_id) references public.sites(id);
  end if;
end $$;

-- 2) 계정 ---------------------------------------------------------------
-- 본사 담당자(총괄) 계정. 바꾸려면 이메일을 고쳐 다시 실행하거나 앱 「본사 → 계정 관리」에서 지정하세요.
insert into public.app_users(email, role, site_id, name) values ('airrotc29@naver.com', 'hq', null, '본사')
  on conflict (email) do update set role = 'hq', site_id = null;

-- 예전 버전(app_managers 표)에서 올리기: 관리소장 → main 관리소장, 나머지 로그인 계정 → main 직원
do $$ begin
  if to_regclass('public.app_managers') is not null then
    insert into public.app_users(email, role, site_id)
      select lower(email), 'manager', 'main' from public.app_managers on conflict (email) do nothing;
    insert into public.app_users(email, role, site_id)
      select lower(u.email), 'staff', 'main' from auth.users u
      where u.email is not null and lower(u.email) not in (select email from public.app_users)
      on conflict (email) do nothing;
    drop table public.app_managers;
  end if;
end $$;

-- 로그인한 사람의 역할·사업장 (서버 보안 규칙과 앱 화면이 같은 기준을 쓴다)
--   이메일 계정 → app_users / 직원 링크(익명 로그인) → staff_sessions (링크 토큰이 현재 것과 같을 때만)
--   사진 저장소(Storage)처럼 이메일을 못 읽는 곳에서는 user_roles(사용자 id → 이메일)로 다시 app_users 를 찾는다
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('role', role, 'site_id', site_id, 'name', name)
       from app_users where email = lower(nullif(auth.jwt() ->> 'email', ''))),
    (select jsonb_build_object('role', a.role, 'site_id', a.site_id, 'name', a.name)
       from user_roles ur join app_users a on a.email = ur.email where ur.user_id = auth.uid()),
    (select jsonb_build_object('role', 'staff', 'site_id', ss.site_id, 'link', true)
       from staff_sessions ss join sites s on s.id = ss.site_id
       where ss.user_id = auth.uid() and ss.token = s.staff_token and not s.archived),
    '{}'::jsonb);
$$;
-- 로그인 직후 앱이 호출: 사용자 id ↔ 이메일을 기록해 두고 역할을 돌려준다
create or replace function public.touch_access()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_email text := lower(nullif(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then return '{}'::jsonb; end if;
  if v_email is not null then
    insert into user_roles(user_id, email, updated_at) values (auth.uid(), v_email, now())
      on conflict (user_id) do update set email = excluded.email, updated_at = now();
  end if;
  return my_access();
end $$;
create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select public.my_access() ->> 'role';
$$;
create or replace function public.my_site()
returns text language sql stable security definer set search_path = public as $$
  select public.my_access() ->> 'site_id';
$$;

-- 직원 접속 링크: 관리소장(또는 본사)이 만들고, 새로 만들면 예전 링크로 들어온 기기는 모두 막힌다
create or replace function public.rotate_staff_link(sid text)
returns text language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not can_manage(sid) then raise exception 'forbidden'; end if;
  t := encode(extensions.gen_random_bytes(18), 'hex');
  update sites set staff_token = t where id = sid;
  if not found then raise exception 'gone'; end if;
  return t;
end $$;
-- 직원 기기가 링크를 열 때(익명 로그인 뒤) 호출: 토큰이 맞으면 이 기기를 그 사업장 직원으로 등록
create or replace function public.claim_staff_link(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_site sites%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_site from sites where staff_token = p_token and not archived and p_token is not null and p_token <> '';
  if not found then raise exception 'invalid link'; end if;
  insert into staff_sessions(user_id, site_id, token) values (auth.uid(), v_site.id, p_token)
    on conflict (user_id) do update set site_id = excluded.site_id, token = excluded.token, created_at = now();
  return jsonb_build_object('site_id', v_site.id, 'name', v_site.name);
end $$;
-- 본사: 관리소장 비밀번호 재설정 / 로그인 계정 삭제 (앱 「본사 → 계정 관리」에서 사용)
create or replace function public.set_login_password(p_email text, p_password text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_hq() then raise exception 'forbidden'; end if;
  if length(coalesce(p_password, '')) < 6 then raise exception 'password too short'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
    where lower(email) = lower(p_email);
  if not found then raise exception 'not found'; end if;
end $$;
-- 역할 지정을 먼저 지우고(이후 로그인해도 아무것도 못 봄), 로그인 계정 삭제는 권한이 없으면 건너뛰고 false 를 돌려준다
create or replace function public.remove_login(p_email text)
returns boolean language plpgsql security definer set search_path = public as $$
declare ok boolean := true;
begin
  if not is_hq() then raise exception 'forbidden'; end if;
  if lower(p_email) = lower(coalesce(auth.jwt() ->> 'email', '')) then raise exception 'self'; end if;
  delete from app_users where email = lower(p_email);
  delete from user_roles where email = lower(p_email);
  begin
    delete from auth.users where lower(email) = lower(p_email);
  exception when insufficient_privilege or undefined_table then ok := false;
  end;
  return ok;
end $$;
create or replace function public.is_hq()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'hq', false);
$$;
create or replace function public.can_view(sid text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_hq() or (public.my_site() is not null and public.my_site() = sid);
$$;
create or replace function public.can_manage(sid text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_hq() or (public.my_role() = 'manager' and public.my_site() = sid);
$$;
create or replace function public.is_manager()          -- 예전 앱 호환
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('hq', 'manager'), false);
$$;

-- 3) 보안 규칙 ------------------------------------------------------------
-- 보기: 자기 사업장만(본사는 전체) / 직접 쓰기: 그 사업장 관리소장과 본사만
-- (직원의 접수·보고는 아래 add_complaint, apply_action 함수가 내용을 검사한 뒤 대신 저장)
alter table public.sites      enable row level security;
alter table public.complaints enable row level security;
alter table public.events     enable row level security;
alter table public.staff      enable row level security;
alter table public.settings   enable row level security;
alter table public.app_users  enable row level security;
alter table public.staff_sessions enable row level security;   -- 함수로만 다룬다(직접 읽기·쓰기 불가)
alter table public.user_roles     enable row level security;

do $$
declare t text;
begin
  foreach t in array array['complaints','events','staff'] loop
    execute format('drop policy if exists "로그인 사용자" on public.%I', t);
    execute format('drop policy if exists "보기" on public.%I', t);
    execute format('drop policy if exists "관리소장 쓰기" on public.%I', t);
    execute format('create policy "보기" on public.%I for select to authenticated using (public.can_view(site_id))', t);
    execute format('create policy "관리소장 쓰기" on public.%I for all to authenticated using (public.can_manage(site_id)) with check (public.can_manage(site_id))', t);
  end loop;
end $$;
drop policy if exists "로그인 사용자" on public.settings;
drop policy if exists "보기" on public.settings;
drop policy if exists "관리소장 쓰기" on public.settings;
create policy "보기"        on public.settings for select to authenticated using (public.can_view(id));
create policy "관리소장 쓰기" on public.settings for all to authenticated using (public.can_manage(id)) with check (public.can_manage(id));
drop policy if exists "보기" on public.sites;
drop policy if exists "본사 쓰기" on public.sites;
create policy "보기"    on public.sites for select to authenticated using (public.can_view(id));
create policy "본사 쓰기" on public.sites for all to authenticated using (public.is_hq()) with check (public.is_hq());
drop policy if exists "본사" on public.app_users;
create policy "본사" on public.app_users for all to authenticated using (public.is_hq()) with check (public.is_hq());

-- 민원 접수: 민원과 첫 처리 내역을 한 번에 저장 (직원도 가능, 본사는 사업장(sid)을 지정)
drop function if exists public.add_complaint(text, jsonb, jsonb);
create or replace function public.add_complaint(cid text, cdata jsonb, evs jsonb, sid text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_site text;
begin
  if my_role() is null then raise exception 'forbidden'; end if;
  v_site := coalesce(sid, my_site());
  if v_site is null then raise exception 'site required'; end if;
  if not can_view(v_site) then raise exception 'forbidden'; end if;
  if not can_manage(v_site) then
    if coalesce(cdata->>'status', '') not in ('received', 'assigned') then raise exception 'forbidden'; end if;
    if exists (select 1 from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) e
               where e->>'type' not in ('received', 'assigned')) then raise exception 'forbidden'; end if;
  end if;
  insert into complaints(id, site_id, data) values (cid, v_site, cdata);
  insert into events(id, complaint_id, site_id, data)
    select e->>'id', cid, v_site, e from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) e;
end $$;

-- 처리: 바뀐 칸만 합치고(덮어쓰지 않음) 처리 내역 한 줄 추가
-- 직원은 진행 보고(progress)·완료 보고(done)만 가능
create or replace function public.apply_action(cid text, patch jsonb, ev jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_site text;
begin
  select site_id into v_site from complaints where id = cid;
  if not found then raise exception 'gone'; end if;
  if not can_view(v_site) then raise exception 'forbidden'; end if;
  if not can_manage(v_site) then
    if ev is null or ev->>'type' not in ('progress', 'done') then raise exception 'forbidden'; end if;
    if exists (select 1 from jsonb_object_keys(coalesce(patch, '{}'::jsonb)) k
               where k not in ('status', 'rework', 'updatedAt')) then raise exception 'forbidden'; end if;
    if coalesce(patch->>'status', 'progress') not in ('progress', 'done') then raise exception 'forbidden'; end if;
  end if;
  update complaints set data = data || coalesce(patch, '{}'::jsonb), updated_at = now() where id = cid;
  if ev is not null then
    insert into events(id, complaint_id, site_id, data) values (ev->>'id', cid, v_site, ev);
  end if;
end $$;

-- 설정: 바뀐 칸만 합치기 (그 사업장 관리소장·본사만)
drop function if exists public.merge_settings(jsonb);
create or replace function public.merge_settings(patch jsonb, sid text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_site text;
begin
  v_site := coalesce(sid, my_site());
  if v_site is null or not can_manage(v_site) then raise exception 'forbidden'; end if;
  insert into settings(id, data) values (v_site, coalesce(patch, '{}'::jsonb))
  on conflict (id) do update set data = settings.data || excluded.data;
end $$;

do $$
declare f text;
begin
  foreach f in array array['my_access()', 'my_role()', 'my_site()', 'is_hq()', 'can_view(text)', 'can_manage(text)', 'is_manager()',
                           'add_complaint(text, jsonb, jsonb, text)', 'apply_action(text, jsonb, jsonb)', 'merge_settings(jsonb, text)',
                           'rotate_staff_link(text)', 'claim_staff_link(text)', 'set_login_password(text, text)', 'remove_login(text)', 'touch_access()'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- 4) 실시간 반영(다른 기기의 변경을 바로 받기) ----------------------------
do $$
declare t text;
begin
  foreach t in array array['complaints','events','staff','settings','sites','app_users'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 5) 사진 저장소(비공개, 사진 한 장 최대 5MB) ------------------------------
-- 사진은 photos/<민원id>/<파일명> 으로 저장되며, 그 민원을 볼 수 있는 사람만 볼 수 있다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "사진 보기" on storage.objects;
drop policy if exists "사진 올리기" on storage.objects;
drop policy if exists "사진 바꾸기" on storage.objects;
drop policy if exists "사진 지우기" on storage.objects;
create policy "사진 보기"   on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (public.is_hq() or exists (
    select 1 from public.complaints c where c.id = split_part(name, '/', 1) and public.can_view(c.site_id))));
create policy "사진 올리기" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.my_role() is not null);
create policy "사진 바꾸기" on storage.objects for update to authenticated using (bucket_id = 'photos' and public.is_manager());
create policy "사진 지우기" on storage.objects for delete to authenticated using (bucket_id = 'photos' and public.is_manager());

-- 6) 바뀐 함수가 앱에 바로 보이도록 API 목록 새로 고침 ----------------------
notify pgrst, 'reload schema';

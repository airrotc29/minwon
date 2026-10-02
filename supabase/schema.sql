-- 선민종합관리 민원 처리부 · Supabase 데이터베이스 설정
-- Supabase 대시보드 → SQL Editor → New query 에 이 파일 전체를 붙여넣고 Run 을 누르세요.
-- 여러 번 실행해도 안전합니다.

-- 1) 표 ------------------------------------------------------------------
create table if not exists public.complaints (      -- 민원 한 건
  id         text primary key,
  data       jsonb not null default '{}'::jsonb,     -- 동·호수, 제목, 상태, 담당, 기한 …
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.events (          -- 처리 내역(접수·지시·보고·회신), 추가만 함
  id           text primary key,
  complaint_id text not null references public.complaints(id) on delete cascade,
  data         jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists events_complaint_id_idx on public.events(complaint_id);
create table if not exists public.staff (           -- 직원 명단
  id         text primary key,
  data       jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists public.settings (        -- 단지 설정(한 줄: id = 'main')
  id   text primary key,
  data jsonb not null default '{}'::jsonb
);

-- 2) 관리소장 계정 목록 -------------------------------------------------
-- 여기에 적힌 이메일로 로그인한 사람만 관리소장 기능(지시·회신·삭제·직원 명단·설정)을 씁니다.
-- 나머지 계정(직원 공용 계정 등)은 접수, 진행·완료 보고, 사진 올리기만 할 수 있습니다.
-- 소장님 계정을 바꾸거나 추가하려면 아래 insert 줄의 이메일을 고쳐 다시 실행하세요.
create table if not exists public.app_managers (email text primary key);
alter table public.app_managers enable row level security;   -- 화면에서는 읽기·쓰기 불가
insert into public.app_managers(email) values ('airrotc29@naver.com') on conflict do nothing;

create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_managers
                 where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- 3) 보안 규칙 ------------------------------------------------------------
-- 보기: 로그인한 사람 모두 / 직접 쓰기: 관리소장만
-- (직원의 접수·보고는 아래 add_complaint, apply_action 함수가 내용을 검사한 뒤 대신 저장)
alter table public.complaints enable row level security;
alter table public.events     enable row level security;
alter table public.staff      enable row level security;
alter table public.settings   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['complaints','events','staff','settings'] loop
    execute format('drop policy if exists "로그인 사용자" on public.%I', t);
    execute format('drop policy if exists "보기" on public.%I', t);
    execute format('drop policy if exists "관리소장 쓰기" on public.%I', t);
    execute format('create policy "보기" on public.%I for select to authenticated using (true)', t);
    execute format('create policy "관리소장 쓰기" on public.%I for all to authenticated using (public.is_manager()) with check (public.is_manager())', t);
  end loop;
end $$;

-- 민원 접수: 민원과 첫 처리 내역을 한 번에 저장(직원도 가능)
create or replace function public.add_complaint(cid text, cdata jsonb, evs jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not is_manager() then
    if coalesce(cdata->>'status', '') not in ('received', 'assigned') then raise exception 'forbidden'; end if;
    if exists (select 1 from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) e
               where e->>'type' not in ('received', 'assigned')) then raise exception 'forbidden'; end if;
  end if;
  insert into complaints(id, data) values (cid, cdata);
  insert into events(id, complaint_id, data)
    select e->>'id', cid, e from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) e;
end $$;

-- 처리: 바뀐 칸만 합치고(덮어쓰지 않음) 처리 내역 한 줄 추가
-- 직원은 진행 보고(progress)·완료 보고(done)만 가능
create or replace function public.apply_action(cid text, patch jsonb, ev jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not is_manager() then
    if ev is null or ev->>'type' not in ('progress', 'done') then raise exception 'forbidden'; end if;
    if exists (select 1 from jsonb_object_keys(coalesce(patch, '{}'::jsonb)) k
               where k not in ('status', 'rework', 'updatedAt')) then raise exception 'forbidden'; end if;
    if coalesce(patch->>'status', 'progress') not in ('progress', 'done') then raise exception 'forbidden'; end if;
  end if;
  update complaints set data = data || coalesce(patch, '{}'::jsonb), updated_at = now() where id = cid;
  if not found then raise exception 'gone'; end if;
  if ev is not null then
    insert into events(id, complaint_id, data) values (ev->>'id', cid, ev);
  end if;
end $$;

-- 설정: 바뀐 칸만 합치기(보안 규칙에 따라 관리소장만)
create or replace function public.merge_settings(patch jsonb)
returns void language sql security invoker set search_path = public as $$
  insert into settings(id, data) values ('main', patch)
  on conflict (id) do update set data = settings.data || excluded.data;
$$;

revoke execute on function public.is_manager()                      from public, anon;
revoke execute on function public.add_complaint(text, jsonb, jsonb) from public, anon;
revoke execute on function public.apply_action(text, jsonb, jsonb)  from public, anon;
revoke execute on function public.merge_settings(jsonb)             from public, anon;
grant  execute on function public.is_manager()                      to authenticated;
grant  execute on function public.add_complaint(text, jsonb, jsonb) to authenticated;
grant  execute on function public.apply_action(text, jsonb, jsonb)  to authenticated;
grant  execute on function public.merge_settings(jsonb)             to authenticated;

-- 4) 실시간 반영(다른 기기의 변경을 바로 받기) ----------------------------
do $$
declare t text;
begin
  foreach t in array array['complaints','events','staff','settings'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 5) 사진 저장소(비공개, 사진 한 장 최대 5MB) ------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "사진 보기" on storage.objects;
drop policy if exists "사진 올리기" on storage.objects;
drop policy if exists "사진 바꾸기" on storage.objects;
drop policy if exists "사진 지우기" on storage.objects;
create policy "사진 보기"   on storage.objects for select to authenticated using (bucket_id = 'photos');
create policy "사진 올리기" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "사진 바꾸기" on storage.objects for update to authenticated using (bucket_id = 'photos');
create policy "사진 지우기" on storage.objects for delete to authenticated using (bucket_id = 'photos');

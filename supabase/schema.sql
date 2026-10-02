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

-- 2) 보안: 로그인한 사람만 읽고 쓸 수 있음 ------------------------------
alter table public.complaints enable row level security;
alter table public.events     enable row level security;
alter table public.staff      enable row level security;
alter table public.settings   enable row level security;

drop policy if exists "로그인 사용자" on public.complaints;
drop policy if exists "로그인 사용자" on public.events;
drop policy if exists "로그인 사용자" on public.staff;
drop policy if exists "로그인 사용자" on public.settings;
create policy "로그인 사용자" on public.complaints for all to authenticated using (true) with check (true);
create policy "로그인 사용자" on public.events     for all to authenticated using (true) with check (true);
create policy "로그인 사용자" on public.staff      for all to authenticated using (true) with check (true);
create policy "로그인 사용자" on public.settings   for all to authenticated using (true) with check (true);

-- 3) 여러 기기가 동시에 고쳐도 내용이 섞이지 않게 하는 함수 ---------------
-- 민원 접수: 민원과 첫 처리 내역을 한 번에 저장
create or replace function public.add_complaint(cid text, cdata jsonb, evs jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  insert into complaints(id, data) values (cid, cdata);
  insert into events(id, complaint_id, data)
    select e->>'id', cid, e from jsonb_array_elements(coalesce(evs, '[]'::jsonb)) e;
end $$;

-- 처리: 바뀐 칸만 합치고(덮어쓰지 않음) 처리 내역 한 줄 추가
create or replace function public.apply_action(cid text, patch jsonb, ev jsonb)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update complaints set data = data || coalesce(patch, '{}'::jsonb), updated_at = now() where id = cid;
  if not found then raise exception 'gone'; end if;
  if ev is not null then
    insert into events(id, complaint_id, data) values (ev->>'id', cid, ev);
  end if;
end $$;

-- 설정: 바뀐 칸만 합치기
create or replace function public.merge_settings(patch jsonb)
returns void language sql security invoker set search_path = public as $$
  insert into settings(id, data) values ('main', patch)
  on conflict (id) do update set data = settings.data || excluded.data;
$$;

revoke execute on function public.add_complaint(text, jsonb, jsonb) from public, anon;
revoke execute on function public.apply_action(text, jsonb, jsonb)  from public, anon;
revoke execute on function public.merge_settings(jsonb)             from public, anon;
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

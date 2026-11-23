-- GHASTA CHAT database setup
-- Run the entire file in Supabase Dashboard > SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  email text unique,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists email text unique;

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  type text not null check (type in ('room','direct')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id,user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '' check (char_length(body) <= 5000),
  file_name text,
  file_path text,
  file_size bigint,
  file_type text,
  created_at timestamptz not null default now(),
  constraint message_has_content check (body <> '' or file_path is not null)
);

create index if not exists messages_conversation_created_idx
  on public.messages(conversation_id, created_at);

alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;

create or replace function public.is_conversation_member(cid uuid)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members
    where conversation_id = cid and user_id = auth.uid()
  );
$$;

create policy "profiles are visible to signed-in users"
on public.profiles for select to authenticated using (true);
create policy "users create own profile"
on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "users update own profile"
on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members can view conversations"
on public.conversations for select to authenticated
using (public.is_conversation_member(id));
create policy "creator can create conversation"
on public.conversations for insert to authenticated
with check (created_by = auth.uid());

create policy "members can view membership"
on public.conversation_members for select to authenticated
using (public.is_conversation_member(conversation_id));
create policy "users can join when added by security definer functions"
on public.conversation_members for insert to authenticated
with check (user_id = auth.uid() and public.is_conversation_member(conversation_id));

create policy "members can read messages"
on public.messages for select to authenticated
using (public.is_conversation_member(conversation_id));
create policy "members can send messages as themselves"
on public.messages for insert to authenticated
with check (user_id = auth.uid() and public.is_conversation_member(conversation_id));

-- Create a default public team room and add its creator.
create or replace function public.create_default_room()
returns uuid language plpgsql security definer
set search_path = public
as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  insert into public.conversations(title,type,created_by)
  values ('عام','room',auth.uid()) returning id into cid;
  insert into public.conversation_members(conversation_id,user_id) values(cid,auth.uid());
  return cid;
end;
$$;

create or replace function public.create_conversation(p_title text, p_type text)
returns uuid language plpgsql security definer
set search_path = public
as $$
declare cid uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_type <> 'room' then raise exception 'Invalid conversation type'; end if;
  if length(trim(p_title)) < 1 or length(p_title) > 50 then raise exception 'Invalid title'; end if;
  insert into public.conversations(title,type,created_by)
  values(trim(p_title),'room',auth.uid()) returning id into cid;
  insert into public.conversation_members(conversation_id,user_id) values(cid,auth.uid());
  return cid;
end;
$$;

create or replace function public.create_direct_conversation(p_other_user uuid)
returns uuid language plpgsql security definer
set search_path = public
as $$
declare cid uuid; existing_id uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_other_user = auth.uid() then raise exception 'Cannot message yourself'; end if;
  if not exists(select 1 from public.profiles where id=p_other_user) then raise exception 'User not found'; end if;
  select c.id into existing_id
  from public.conversations c
  join public.conversation_members a on a.conversation_id=c.id and a.user_id=auth.uid()
  join public.conversation_members b on b.conversation_id=c.id and b.user_id=p_other_user
  where c.type='direct'
  and (select count(*) from public.conversation_members x where x.conversation_id=c.id)=2
  limit 1;
  if existing_id is not null then return existing_id; end if;
  insert into public.conversations(title,type,created_by)
  values ('محادثة خاصة','direct',auth.uid()) returning id into cid;
  insert into public.conversation_members(conversation_id,user_id)
  values (cid,auth.uid()),(cid,p_other_user);
  return cid;
end;
$$;

grant execute on function public.create_default_room() to authenticated;
grant execute on function public.create_conversation(text,text) to authenticated;
grant execute on function public.create_direct_conversation(uuid) to authenticated;

-- Private bucket. Set file size limit in Dashboard > Storage > chat-files.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('chat-files','chat-files',false,5368709120,null)
on conflict (id) do update set public=false, file_size_limit=5368709120;

create policy "members can upload to their conversations"
on storage.objects for insert to authenticated
with check (
  bucket_id='chat-files'
  and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
);
create policy "members can read files in their conversations"
on storage.objects for select to authenticated
using (
  bucket_id='chat-files'
  and public.is_conversation_member(((storage.foldername(name))[1])::uuid)
);

-- Enable realtime for messages.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
when undefined_object then null;
end $$;

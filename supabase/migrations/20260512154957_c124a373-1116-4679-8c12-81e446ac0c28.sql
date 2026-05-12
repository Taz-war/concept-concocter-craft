
-- Extensions
create extension if not exists vector;

-- Roles
create type public.app_role as enum ('admin', 'user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null default 'user',
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  )
$$;

create policy "Users view own roles" on public.user_roles
  for select to authenticated using (auth.uid() = user_id);

-- Profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "View own profile" on public.profiles
  for select to authenticated using (auth.uid() = id);
create policy "Update own profile" on public.profiles
  for update to authenticated using (auth.uid() = id);
create policy "Insert own profile" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  insert into public.user_roles (user_id, role) values (new.id, 'user');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Matters
create table public.matters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  case_number text not null,
  client_name text not null,
  case_type text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, case_number)
);

alter table public.matters enable row level security;

create policy "Owner reads matters" on public.matters
  for select to authenticated using (auth.uid() = user_id);
create policy "Owner inserts matters" on public.matters
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Owner updates matters" on public.matters
  for update to authenticated using (auth.uid() = user_id);
create policy "Owner deletes matters" on public.matters
  for delete to authenticated using (auth.uid() = user_id);

-- Documents
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  filename text not null,
  storage_path text not null,
  file_size integer,
  document_type text,
  uploaded_by uuid not null references auth.users(id),
  upload_date timestamptz not null default now(),
  processed boolean not null default false,
  processing_error text,
  page_count integer,
  chunk_count integer
);

alter table public.documents enable row level security;

create policy "Owner reads documents" on public.documents
  for select to authenticated using (
    matter_id in (select id from public.matters where user_id = auth.uid())
  );
create policy "Owner inserts documents" on public.documents
  for insert to authenticated with check (
    uploaded_by = auth.uid()
    and matter_id in (select id from public.matters where user_id = auth.uid())
  );
create policy "Owner updates documents" on public.documents
  for update to authenticated using (
    matter_id in (select id from public.matters where user_id = auth.uid())
  );
create policy "Owner deletes documents" on public.documents
  for delete to authenticated using (
    matter_id in (select id from public.matters where user_id = auth.uid())
  );

-- Chunks
create table public.chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  matter_id uuid not null references public.matters(id) on delete cascade,
  chunk_text text not null,
  chunk_index integer not null,
  page_number integer,
  embedding vector(768),
  created_at timestamptz not null default now()
);

create index chunks_embedding_idx on public.chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index chunks_matter_idx on public.chunks (matter_id);

alter table public.chunks enable row level security;

create policy "Owner reads chunks" on public.chunks
  for select to authenticated using (
    matter_id in (select id from public.matters where user_id = auth.uid())
  );
create policy "Owner inserts chunks" on public.chunks
  for insert to authenticated with check (
    matter_id in (select id from public.matters where user_id = auth.uid())
  );
create policy "Owner deletes chunks" on public.chunks
  for delete to authenticated using (
    matter_id in (select id from public.matters where user_id = auth.uid())
  );

-- Chat history
create table public.chat_history (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  query text not null,
  response text not null,
  source_documents jsonb,
  model_used text,
  tokens_used integer,
  created_at timestamptz not null default now()
);

alter table public.chat_history enable row level security;

create policy "Owner reads chat" on public.chat_history
  for select to authenticated using (auth.uid() = user_id);
create policy "Owner inserts chat" on public.chat_history
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Owner deletes chat" on public.chat_history
  for delete to authenticated using (auth.uid() = user_id);

-- Audit logs
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_logs enable row level security;

create policy "Owner reads audit" on public.audit_logs
  for select to authenticated using (auth.uid() = user_id);
create policy "Owner inserts audit" on public.audit_logs
  for insert to authenticated with check (auth.uid() = user_id);

-- Vector similarity search RPC
create or replace function public.match_chunks(
  query_embedding vector(768),
  match_matter_id uuid,
  match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  chunk_text text,
  chunk_index int,
  page_number int,
  similarity float
)
language sql stable
security invoker
set search_path = public
as $$
  select c.id, c.document_id, c.chunk_text, c.chunk_index, c.page_number,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.chunks c
  where c.matter_id = match_matter_id and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Storage bucket for PDFs
insert into storage.buckets (id, name, public)
values ('case-documents', 'case-documents', false)
on conflict (id) do nothing;

create policy "Owner reads own case files" on storage.objects
  for select to authenticated using (
    bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Owner uploads own case files" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "Owner deletes own case files" on storage.objects
  for delete to authenticated using (
    bucket_id = 'case-documents' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Feature 3 + 4 + 5 schema additions

-- Announcements sent by teachers/admins to class parents
create table if not exists announcements (
  id text primary key,
  "className" text not null,
  message text not null,
  "createdBy" text not null references users(id) on delete cascade,
  "createdAt" timestamptz not null default now()
);

-- Join table: one announcement can target many parents
create table if not exists announcement_recipients (
  id text primary key,
  "announcementId" text not null references announcements(id) on delete cascade,
  "parentId" text not null references users(id) on delete cascade,
  "createdAt" timestamptz not null default now(),
  unique ("announcementId", "parentId")
);

-- Secure internal inbox
create table if not exists messages (
  id text primary key,
  "senderId" text not null references users(id) on delete cascade,
  "recipientId" text not null references users(id) on delete cascade,
  subject text not null,
  body text not null,
  "readAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create index if not exists idx_messages_sender on messages ("senderId");
create index if not exists idx_messages_recipient on messages ("recipientId");
create index if not exists idx_messages_created_at on messages ("createdAt" desc);

-- Enforce restricted messaging rules at DB level (app-level checks still recommended)
create or replace function can_send_message(sender_id text, recipient_id text)
returns boolean
language plpgsql
as $$
declare
  sender_role text;
  recipient_role text;
begin
  select role into sender_role from users where id = sender_id;
  select role into recipient_role from users where id = recipient_id;

  if sender_role is null or recipient_role is null then
    return false;
  end if;

  -- Admin can message anyone
  if sender_role = 'admin' then
    return true;
  end if;

  -- Parent -> only teacher/supervisor assigned to their child's class
  if sender_role = 'parent' then
    if recipient_role not in ('teacher', 'supervisor') then
      return false;
    end if;
    return exists (
      select 1
      from students s
      join users u on u.id = recipient_id
      where s."parentId" = sender_id
        and coalesce(u."assignedClasses", '[]'::jsonb) ? s."className"
    );
  end if;

  -- Teacher -> only parents with children in teacher's assigned classes
  if sender_role = 'teacher' then
    if recipient_role <> 'parent' then
      return false;
    end if;
    return exists (
      select 1
      from users t
      join students s on s."parentId" = recipient_id
      where t.id = sender_id
        and coalesce(t."assignedClasses", '[]'::jsonb) ? s."className"
    );
  end if;

  -- Supervisor -> only parents in supervised classes
  if sender_role = 'supervisor' then
    if recipient_role <> 'parent' then
      return false;
    end if;
    return exists (
      select 1
      from users sp
      join students s on s."parentId" = recipient_id
      where sp.id = sender_id
        and coalesce(sp."assignedClasses", '[]'::jsonb) ? s."className"
    );
  end if;

  return false;
end;
$$;

create or replace function messages_validate_permissions()
returns trigger
language plpgsql
as $$
begin
  if not can_send_message(new."senderId", new."recipientId") then
    raise exception 'Message permission denied for sender % -> recipient %', new."senderId", new."recipientId";
  end if;
  return new;
end;
$$;

drop trigger if exists trg_messages_validate_permissions on messages;
create trigger trg_messages_validate_permissions
before insert on messages
for each row
execute function messages_validate_permissions();

-- Parent portal: attendance and homework streams
create table if not exists attendance (
  id text primary key,
  "studentId" text not null references students(id) on delete cascade,
  "className" text not null,
  date date not null,
  status text not null check (status in ('present', 'absent', 'late')),
  note text,
  "teacherId" text not null references users(id) on delete cascade,
  "createdAt" timestamptz not null default now()
);

create table if not exists homework (
  id text primary key,
  "studentId" text not null references students(id) on delete cascade,
  "className" text not null,
  subject text not null,
  title text not null,
  description text,
  "dueDate" date not null,
  status text not null check (status in ('assigned', 'submitted', 'graded')),
  "teacherId" text not null references users(id) on delete cascade,
  "createdAt" timestamptz not null default now()
);

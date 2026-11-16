-- Barber booking database for Supabase.
-- All application reads and writes go through the booking-api Edge Function.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.business_settings (
  singleton boolean primary key default true check (singleton),
  admin_email text,
  timezone text not null default 'Europe/Bratislava'
);
insert into public.business_settings (singleton) values (true) on conflict (singleton) do nothing;

create table if not exists public.admin_users (
  email text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.open_days (
  day date primary key,
  first_start time not null,
  last_start time not null,
  check (last_start >= first_start)
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  management_token_hash text not null unique,
  customer_name text not null,
  email text,
  phone text,
  service text not null check (service in ('cut','combo','beard')),
  duration_minutes integer not null check (duration_minutes in (30,60,90)),
  booking_day date not null,
  starts_at time not null,
  status text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  check (email is not null or phone is not null)
);
create index if not exists appointments_day_status_start_idx
  on public.appointments (booking_day, status, starts_at);

create table if not exists public.change_requests (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments(id),
  action text not null check (action in ('cancel','reschedule')),
  new_service text check (new_service in ('cut','combo','beard')),
  new_day date,
  new_start time,
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists change_requests_status_created_idx
  on public.change_requests (status, created_at);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id),
  request_id uuid references public.change_requests(id),
  channel text not null check (channel in ('email','sms')),
  recipient text not null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  due_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','processing','sent','failed')),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notification_outbox_ready_idx
  on public.notification_outbox (status, due_at);

alter table public.business_settings enable row level security;
alter table public.admin_users enable row level security;
alter table public.open_days enable row level security;
alter table public.appointments enable row level security;
alter table public.change_requests enable row level security;
alter table public.notification_outbox enable row level security;
revoke all on public.business_settings, public.admin_users, public.open_days,
  public.appointments, public.change_requests, public.notification_outbox
  from anon, authenticated;

create or replace function public.create_booking(
  p_name text,
  p_email text,
  p_phone text,
  p_service text,
  p_day date,
  p_start time,
  p_token_hash text,
  p_manage_url text
) returns table(appointment_id uuid, booking_reference text, duration_minutes integer)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_duration integer;
  v_day public.open_days%rowtype;
  v_settings public.business_settings%rowtype;
  v_id uuid;
  v_reference text;
  v_manage_url text;
  v_local_start timestamptz;
  v_channel text;
  v_recipient text;
begin
  perform pg_advisory_xact_lock(hashtext(p_day::text));
  if length(trim(coalesce(p_name,''))) not between 1 and 80 then raise exception 'Meno je povinné.'; end if;
  if coalesce(trim(p_email),'') = '' and coalesce(trim(p_phone),'') = '' then raise exception 'Zadajte e-mail alebo telefón.'; end if;
  if p_manage_url !~ '^https://' then raise exception 'Chýba bezpečný odkaz na správu rezervácie.'; end if;
  v_duration := case p_service when 'cut' then 60 when 'combo' then 90 when 'beard' then 30 else null end;
  if v_duration is null then raise exception 'Neznáma služba.'; end if;
  select * into v_day from public.open_days where day = p_day;
  if not found then raise exception 'Tento deň nie je otvorený.'; end if;
  if p_start < v_day.first_start or p_start > v_day.last_start then raise exception 'Začiatok je mimo dostupného času.'; end if;
  select * into v_settings from public.business_settings where singleton;
  v_local_start := (p_day + p_start) at time zone v_settings.timezone;
  if v_local_start <= now() then raise exception 'Tento čas už uplynul.'; end if;
  if exists (
    select 1 from public.appointments a
    where a.booking_day = p_day and a.status = 'confirmed'
      and p_start < a.starts_at + make_interval(mins => a.duration_minutes)
      and p_start + make_interval(mins => v_duration) > a.starts_at
  ) then raise exception 'Tento čas už nie je voľný.'; end if;

  v_reference := 'BB-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.appointments(reference, management_token_hash, customer_name, email, phone,
    service, duration_minutes, booking_day, starts_at)
  values (v_reference, p_token_hash, trim(p_name), nullif(trim(p_email),''), nullif(trim(p_phone),''),
    p_service, v_duration, p_day, p_start)
  returning id into v_id;

  v_channel := case when nullif(trim(p_email),'') is not null then 'email' else 'sms' end;
  v_recipient := case when v_channel = 'email' then trim(p_email) else trim(p_phone) end;
  insert into public.notification_outbox(appointment_id, channel, recipient, kind, payload)
  values (v_id, v_channel, v_recipient, 'confirmation', jsonb_build_object('reference',v_reference,
    'name',trim(p_name),'service',p_service,'day',p_day,'start',p_start,'duration',v_duration,'manage_url',p_manage_url));
  if v_local_start > now() + interval '24 hours' then
    insert into public.notification_outbox(appointment_id, channel, recipient, kind, payload, due_at)
    values (v_id, v_channel, v_recipient, 'reminder', jsonb_build_object('reference',v_reference,
      'name',trim(p_name),'service',p_service,'day',p_day,'start',p_start,'duration',v_duration,'manage_url',p_manage_url),
      v_local_start - interval '24 hours');
  end if;
  return query select v_id, v_reference, v_duration;
end;
$$;

create or replace function public.customer_booking(p_token_hash text)
returns table(appointment_id uuid, booking_reference text, customer_name text, service text,
  booking_day date, starts_at time, duration_minutes integer, status text, pending_request boolean)
language sql security definer set search_path = public
as $$
  select id, reference, customer_name, appointments.service, booking_day, appointments.starts_at,
    appointments.duration_minutes, appointments.status,
    exists(select 1 from public.change_requests r where r.appointment_id=appointments.id and r.status='pending')
  from public.appointments where management_token_hash = p_token_hash;
$$;

create or replace function public.manage_booking(
  p_token_hash text,
  p_action text,
  p_new_service text default null,
  p_new_day date default null,
  p_new_start time default null
) returns table(result text, booking_reference text)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_booking public.appointments%rowtype;
  v_day public.open_days%rowtype;
  v_settings public.business_settings%rowtype;
  v_admin_email text;
  v_new_duration integer;
  v_appointment_at timestamptz;
  v_request_id uuid;
  v_channel text;
  v_recipient text;
begin
  select * into v_booking from public.appointments where management_token_hash = p_token_hash for update;
  if not found then raise exception 'Rezervácia sa nenašla.'; end if;
  if v_booking.status <> 'confirmed' then raise exception 'Rezervácia už nie je aktívna.'; end if;
  if p_action not in ('cancel','reschedule') then raise exception 'Neznáma požiadavka.'; end if;
  select * into v_settings from public.business_settings where singleton;
  v_appointment_at := (v_booking.booking_day + v_booking.starts_at) at time zone v_settings.timezone;
  v_channel := case when v_booking.email is not null then 'email' else 'sms' end;
  v_recipient := case when v_channel = 'email' then v_booking.email else v_booking.phone end;

  if v_appointment_at - now() < interval '24 hours' then
    select admin_email into v_admin_email from public.business_settings where singleton;
    if v_admin_email is null then raise exception 'Barber ešte nenastavil e-mail na upozornenia.'; end if;
    if p_action = 'reschedule' then
      v_new_duration := case p_new_service when 'cut' then 60 when 'combo' then 90 when 'beard' then 30 else null end;
      if v_new_duration is null or p_new_day is null or p_new_start is null then raise exception 'Vyberte nový deň, čas a službu.'; end if;
    end if;
    insert into public.change_requests(appointment_id, action, new_service, new_day, new_start)
    values (v_booking.id, p_action, case when p_action='reschedule' then p_new_service end,
      case when p_action='reschedule' then p_new_day end,
      case when p_action='reschedule' then p_new_start end)
    returning id into v_request_id;
    insert into public.notification_outbox(request_id, channel, recipient, kind, payload)
    values (v_request_id, 'email', v_admin_email, 'barber_request', jsonb_build_object(
      'reference',v_booking.reference,'name',v_booking.customer_name,'action',p_action,
      'old_day',v_booking.booking_day,'old_start',v_booking.starts_at,
      'new_day',p_new_day,'new_start',p_new_start,'new_service',p_new_service));
    return query select 'pending', v_booking.reference;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_booking.booking_day::text));
  if p_action = 'cancel' then
    update public.appointments set status='cancelled', cancelled_at=now() where id=v_booking.id;
    update public.notification_outbox set status='failed', last_error='Rezervácia zrušená'
      where appointment_id=v_booking.id and kind='reminder' and status='pending';
    insert into public.notification_outbox(appointment_id, channel, recipient, kind, payload)
      values(v_booking.id,v_channel,v_recipient,'cancelled',jsonb_build_object('reference',v_booking.reference,
        'name',v_booking.customer_name,'day',v_booking.booking_day,'start',v_booking.starts_at));
    return query select 'cancelled', v_booking.reference;
    return;
  end if;

  v_new_duration := case p_new_service when 'cut' then 60 when 'combo' then 90 when 'beard' then 30 else null end;
  if v_new_duration is null or p_new_day is null or p_new_start is null then raise exception 'Vyberte nový deň, čas a službu.'; end if;
  perform pg_advisory_xact_lock(hashtext(p_new_day::text));
  select * into v_day from public.open_days where day=p_new_day;
  if not found or p_new_start < v_day.first_start or p_new_start > v_day.last_start then raise exception 'Nový čas nie je v otvorenom rozvrhu.'; end if;
  if ((p_new_day + p_new_start) at time zone v_settings.timezone) <= now() then raise exception 'Nový čas už uplynul.'; end if;
  if exists(select 1 from public.appointments a where a.booking_day=p_new_day and a.status='confirmed'
      and a.id<>v_booking.id and p_new_start < a.starts_at + make_interval(mins=>a.duration_minutes)
      and p_new_start + make_interval(mins=>v_new_duration)>a.starts_at) then raise exception 'Nový čas už nie je voľný.'; end if;
  update public.appointments set service=p_new_service,duration_minutes=v_new_duration,
    booking_day=p_new_day,starts_at=p_new_start where id=v_booking.id;
  update public.notification_outbox set status='failed',last_error='Termín zmenený'
    where appointment_id=v_booking.id and kind='reminder' and status='pending';
  insert into public.notification_outbox(appointment_id,channel,recipient,kind,payload)
    values(v_booking.id,v_channel,v_recipient,'rescheduled',jsonb_build_object('reference',v_booking.reference,
      'name',v_booking.customer_name,'service',p_new_service,'day',p_new_day,'start',p_new_start,'duration',v_new_duration));
  if ((p_new_day + p_new_start) at time zone v_settings.timezone) > now()+interval '24 hours' then
    insert into public.notification_outbox(appointment_id,channel,recipient,kind,payload,due_at)
      values(v_booking.id,v_channel,v_recipient,'reminder',jsonb_build_object('reference',v_booking.reference,
        'name',v_booking.customer_name,'service',p_new_service,'day',p_new_day,'start',p_new_start,'duration',v_new_duration),
        ((p_new_day+p_new_start) at time zone v_settings.timezone)-interval '24 hours');
  end if;
  return query select 'rescheduled', v_booking.reference;
end;
$$;

create or replace function public.admin_resolve_request(p_request_id uuid,p_approve boolean)
returns text language plpgsql security definer set search_path=public,extensions
as $$
declare
  v_request public.change_requests%rowtype;
  v_booking public.appointments%rowtype;
  v_day public.open_days%rowtype;
  v_settings public.business_settings%rowtype;
  v_duration integer;
  v_channel text;
  v_recipient text;
begin
  select * into v_request from public.change_requests where id=p_request_id and status='pending' for update;
  if not found then raise exception 'Čakajúca žiadosť sa nenašla.'; end if;
  select * into v_booking from public.appointments where id=v_request.appointment_id for update;
  if not found or v_booking.status<>'confirmed' then raise exception 'Pôvodný termín už nie je aktívny.'; end if;
  select * into v_settings from public.business_settings where singleton;
  perform pg_advisory_xact_lock(hashtext(v_booking.booking_day::text));
  v_channel := case when v_booking.email is not null then 'email' else 'sms' end;
  v_recipient := case when v_channel='email' then v_booking.email else v_booking.phone end;
  if p_approve then
    if v_request.action='cancel' then
      update public.appointments set status='cancelled',cancelled_at=now() where id=v_booking.id;
      update public.notification_outbox set status='failed',last_error='Rezervácia zrušená'
        where appointment_id=v_booking.id and kind='reminder' and status='pending';
      insert into public.notification_outbox(appointment_id,channel,recipient,kind,payload)
        values(v_booking.id,v_channel,v_recipient,'cancelled',jsonb_build_object('reference',v_booking.reference,
          'name',v_booking.customer_name,'day',v_booking.booking_day,'start',v_booking.starts_at));
    else
      v_duration := case v_request.new_service when 'cut' then 60 when 'combo' then 90 when 'beard' then 30 else null end;
      if v_duration is null then raise exception 'Neplatná služba v žiadosti.'; end if;
      perform pg_advisory_xact_lock(hashtext(v_request.new_day::text));
      select * into v_day from public.open_days where day=v_request.new_day;
      if not found or v_request.new_start<v_day.first_start or v_request.new_start>v_day.last_start then raise exception 'Požadovaný čas už nie je otvorený.'; end if;
      if ((v_request.new_day+v_request.new_start) at time zone v_settings.timezone)<=now() then raise exception 'Požadovaný čas už uplynul.'; end if;
      if exists(select 1 from public.appointments a where a.booking_day=v_request.new_day and a.status='confirmed'
        and a.id<>v_booking.id and v_request.new_start<a.starts_at+make_interval(mins=>a.duration_minutes)
        and v_request.new_start+make_interval(mins=>v_duration)>a.starts_at) then raise exception 'Požadovaný čas už nie je voľný.'; end if;
      update public.appointments set service=v_request.new_service,duration_minutes=v_duration,
        booking_day=v_request.new_day,starts_at=v_request.new_start where id=v_booking.id;
      update public.notification_outbox set status='failed',last_error='Termín zmenený'
        where appointment_id=v_booking.id and kind='reminder' and status='pending';
      insert into public.notification_outbox(appointment_id,channel,recipient,kind,payload)
        values(v_booking.id,v_channel,v_recipient,'rescheduled',jsonb_build_object('reference',v_booking.reference,
          'name',v_booking.customer_name,'service',v_request.new_service,'day',v_request.new_day,
          'start',v_request.new_start,'duration',v_duration));
      if ((v_request.new_day+v_request.new_start) at time zone v_settings.timezone)>now()+interval '24 hours' then
        insert into public.notification_outbox(appointment_id,channel,recipient,kind,payload,due_at)
          values(v_booking.id,v_channel,v_recipient,'reminder',jsonb_build_object('reference',v_booking.reference,
            'name',v_booking.customer_name,'service',v_request.new_service,'day',v_request.new_day,
            'start',v_request.new_start,'duration',v_duration),
            ((v_request.new_day+v_request.new_start) at time zone v_settings.timezone)-interval '24 hours');
      end if;
    end if;
  end if;
  update public.change_requests set status=case when p_approve then 'approved' else 'declined' end,
    resolved_at=now() where id=p_request_id;
  if not p_approve then
    insert into public.notification_outbox(appointment_id,channel,recipient,kind,payload)
      values(v_booking.id,v_channel,v_recipient,'request_declined',jsonb_build_object('reference',v_booking.reference,
        'name',v_booking.customer_name,'action',v_request.action));
  end if;
  return case when p_approve then 'approved' else 'declined' end;
end;
$$;

create or replace function public.claim_notifications(p_limit integer default 30)
returns setof public.notification_outbox
language sql security definer set search_path=public
as $$
  with ready as (
    select id from public.notification_outbox
    where status='pending' and due_at<=now() and attempts<5
    order by due_at for update skip locked limit greatest(1,least(p_limit,100))
  )
  update public.notification_outbox n set status='processing',attempts=n.attempts+1
  from ready where n.id=ready.id returning n.*;
$$;

create or replace function public.finish_notification(p_id uuid,p_sent boolean,p_error text default null)
returns void language plpgsql security definer set search_path=public
as $$
begin
  update public.notification_outbox set status=case when p_sent then 'sent' when attempts>=5 then 'failed' else 'pending' end,
    sent_at=case when p_sent then now() else sent_at end,
    due_at=case when p_sent then due_at else now()+interval '5 minutes' end,
    last_error=case when p_sent then null else left(coalesce(p_error,'Delivery failed'),500) end,
    payload=case when p_sent then payload-'manage_url' else payload end
  where id=p_id and status='processing';
end;
$$;

revoke all on function public.create_booking(text,text,text,text,date,time,text,text) from public, anon, authenticated;
revoke all on function public.customer_booking(text) from public, anon, authenticated;
revoke all on function public.manage_booking(text,text,text,date,time) from public, anon, authenticated;
revoke all on function public.admin_resolve_request(uuid,boolean) from public, anon, authenticated;
revoke all on function public.claim_notifications(integer) from public, anon, authenticated;
revoke all on function public.finish_notification(uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.create_booking(text,text,text,text,date,time,text,text) to service_role;
grant execute on function public.customer_booking(text) to service_role;
grant execute on function public.manage_booking(text,text,text,date,time) to service_role;
grant execute on function public.admin_resolve_request(uuid,boolean) to service_role;
grant execute on function public.claim_notifications(integer) to service_role;
grant execute on function public.finish_notification(uuid,boolean,text) to service_role;

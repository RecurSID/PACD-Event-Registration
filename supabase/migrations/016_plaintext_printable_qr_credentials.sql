-- Printable QR values are permanent registration data, not session data. Keep them in the
-- service-role-only credential table so changing SESSION_SECRET cannot invalidate downloads.

alter table public.registration_credentials
  add column if not exists print_token text,
  add column if not exists fallback_code text;

alter table public.registration_credentials
  add constraint registration_credentials_print_token_format
    check (print_token is null or print_token ~ '^ER1[.][A-Za-z0-9_-]{32}$'),
  add constraint registration_credentials_fallback_code_format
    check (fallback_code is null or fallback_code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$');

create unique index registration_credentials_print_token_idx
  on public.registration_credentials (print_token) where print_token is not null;
create unique index registration_credentials_fallback_code_idx
  on public.registration_credentials (fallback_code) where fallback_code is not null;

-- Encrypted payloads used SESSION_SECRET and cannot be recovered after that login secret changes.
-- They are deliberately discarded. Each affected active row is replaced lazily the next time its
-- QR is viewed or included in a bulk download; rows already using plaintext are always reused.
alter table public.registration_credentials
  drop column if exists print_payload;

create or replace function public.prepare_event_credentials(
  p_event_id uuid,
  p_items jsonb
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_item jsonb;
  v_registration_id uuid;
  v_credential public.registration_credentials;
  v_result jsonb := '[]'::jsonb;
  v_issued boolean;
begin
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 2000 then
    raise exception 'VALIDATION' using detail = 'credentials';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) item
     where coalesce(item->>'registration_id', '') !~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(item->>'token_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(item->>'fallback_code_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(item->>'print_token', '') !~ '^ER1[.][A-Za-z0-9_-]{32}$'
        or coalesce(item->>'fallback_code', '') !~
             '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$'
        or item->>'token_hash' = item->>'fallback_code_hash'
  ) then
    raise exception 'VALIDATION' using detail = 'credentials';
  end if;

  if (select count(distinct item->>'registration_id') from jsonb_array_elements(p_items) item)
       <> jsonb_array_length(p_items)
     or (select count(distinct hashes.hash_value)
           from jsonb_array_elements(p_items) item
           cross join lateral unnest(array[
             item->>'token_hash', item->>'fallback_code_hash'
           ]) as hashes(hash_value))
       <> jsonb_array_length(p_items) * 2
     or (select count(distinct item->>'print_token') from jsonb_array_elements(p_items) item)
       <> jsonb_array_length(p_items)
     or (select count(distinct item->>'fallback_code') from jsonb_array_elements(p_items) item)
       <> jsonb_array_length(p_items) then
    raise exception 'VALIDATION' using detail = 'credentials';
  end if;

  perform 1
    from public.event_registrations r
   where r.id in (
     select (item->>'registration_id')::uuid from jsonb_array_elements(p_items) item
   )
   order by r.id
   for update;

  if (select count(*)
        from public.event_registrations r
       where r.event_id = p_event_id
         and r.status = 'confirmed'
         and r.id in (
           select (item->>'registration_id')::uuid from jsonb_array_elements(p_items) item
         )) <> jsonb_array_length(p_items) then
    raise exception 'VALIDATION' using detail = 'registrations';
  end if;

  for v_item in select item from jsonb_array_elements(p_items) item
  loop
    v_registration_id := (v_item->>'registration_id')::uuid;
    v_credential := null;
    v_issued := false;

    select c.* into v_credential
      from public.registration_credentials c
     where c.registration_id = v_registration_id
       and c.status = 'active';

    if v_credential.id is null
       or v_credential.print_token is null
       or v_credential.fallback_code is null then
      update public.registration_credentials c
         set status = 'revoked', revoked_at = now()
       where c.registration_id = v_registration_id
         and c.status = 'active';

      insert into public.registration_credentials (
        registration_id, token_hash, fallback_code_hash, print_token, fallback_code
      ) values (
        v_registration_id,
        v_item->>'token_hash',
        v_item->>'fallback_code_hash',
        v_item->>'print_token',
        v_item->>'fallback_code'
      ) returning * into v_credential;
      v_issued := true;
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'registration_id', v_registration_id,
      'token_hash', v_credential.token_hash,
      'fallback_code_hash', v_credential.fallback_code_hash,
      'print_token', v_credential.print_token,
      'fallback_code', v_credential.fallback_code,
      'issued', v_issued
    ));
  end loop;

  return v_result;
end;
$$;

revoke execute on function public.prepare_event_credentials(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.prepare_event_credentials(uuid, jsonb) to service_role;

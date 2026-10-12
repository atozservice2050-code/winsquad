-- Migration: Safe avatar update RPC (profiles has no client UPDATE policy)
create or replace function public.update_avatar(p_avatar text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if p_avatar is null or p_avatar = '' then
    return jsonb_build_object('ok', false, 'error', 'avatar required');
  end if;
  update public.profiles set avatar = p_avatar where id = v_uid;
  return jsonb_build_object('ok', true, 'avatar', p_avatar);
end;
$$;

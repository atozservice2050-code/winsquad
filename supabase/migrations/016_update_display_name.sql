-- Migration 016: update_display_name RPC for profile name editing

create or replace function public.update_display_name(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not authenticated');
  end if;
  if v_name = '' or length(v_name) > 30 then
    return jsonb_build_object('ok', false, 'error', 'name must be 1-30 characters');
  end if;
  update public.profiles set display_name = v_name where id = v_uid;
  return jsonb_build_object('ok', true, 'display_name', v_name);
end;
$$;

grant execute on function public.update_display_name(text) to authenticated;

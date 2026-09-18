-- Supabase's RLS event-trigger helper runs during table creation. It does not
-- need to be callable through the public API by anonymous or signed-in users.
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

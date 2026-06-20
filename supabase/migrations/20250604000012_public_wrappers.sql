CREATE OR REPLACE FUNCTION public.get_visible_modules(p_user_id uuid DEFAULT auth.uid())
RETURNS TABLE (
    id uuid,
    code varchar,
    name varchar,
    description text,
    icon varchar,
    route varchar,
    sort_order integer
)
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
    SELECT * FROM portal.get_visible_modules(p_user_id);
$$;

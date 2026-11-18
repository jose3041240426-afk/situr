-- ============================================================================
-- Migración 55 — Restricción de trámites por ventanilla
-- ============================================================================
-- Una ventanilla (módulo) puede atender solo ciertos trámites. Si no tiene
-- filas en modulo_tramites, atiende todos. Esto permite dedicar ventanillas
-- a trámites específicos.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.modulo_tramites (
    modulo_id   uuid NOT NULL REFERENCES public.modulos(id) ON DELETE CASCADE,
    tramite_id  uuid NOT NULL REFERENCES public.tramites(id) ON DELETE CASCADE,
    PRIMARY KEY (modulo_id, tramite_id)
);

ALTER TABLE public.modulo_tramites ENABLE ROW LEVEL SECURITY;

-- Lectura: cualquier operador/admin.
DROP POLICY IF EXISTS "modulo_tramites_select" ON public.modulo_tramites;
CREATE POLICY "modulo_tramites_select" ON public.modulo_tramites
    FOR SELECT TO authenticated USING (true);

-- Escritura: solo admin.
DROP POLICY IF EXISTS "modulo_tramites_write" ON public.modulo_tramites;
CREATE POLICY "modulo_tramites_write" ON public.modulo_tramites
    FOR ALL TO authenticated
    USING (public.fn_es_administrador())
    WITH CHECK (public.fn_es_administrador());

-- RPC para que el admin configure los trámites permitidos de una ventanilla.
-- p_tramite_ids = NULL o array vacío => sin restricción (todos).
CREATE OR REPLACE FUNCTION public.configurar_tramites_ventanilla(
    p_modulo_id uuid,
    p_tramite_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.fn_es_administrador() THEN
        RAISE EXCEPTION 'Solo el administrador puede configurar ventanillas.'
            USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.modulo_tramites WHERE modulo_id = p_modulo_id;

    IF p_tramite_ids IS NOT NULL AND array_length(p_tramite_ids, 1) IS NOT NULL THEN
        INSERT INTO public.modulo_tramites (modulo_id, tramite_id)
        SELECT p_modulo_id, unnest(p_tramite_ids)
        ON CONFLICT DO NOTHING;
    END IF;

    RETURN jsonb_build_object('ok', true, 'modulo_id', p_modulo_id);
END;
$$;

-- Función auxiliar: trámites permitidos de un módulo (vacío = todos).
CREATE OR REPLACE FUNCTION public.tramites_permitidos_modulo(p_modulo_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ids uuid[];
BEGIN
    SELECT array_agg(tramite_id) INTO v_ids
      FROM public.modulo_tramites
     WHERE modulo_id = p_modulo_id;
    RETURN COALESCE(v_ids, ARRAY[]::uuid[]);
END;
$$;

GRANT EXECUTE ON FUNCTION public.configurar_tramites_ventanilla(uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tramites_permitidos_modulo(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- Migración 48 — Recepción puede emitir por lote; V4 activa
-- ============================================================================
-- 1. generar_turnos_masivos: permitir rol RECEPCION además de operadores.
-- 2. V4 (Módulo 04) pasa a ACTIVO para que pueda recibir transferencias.
-- ============================================================================
BEGIN;

-- 1. generar_turnos_masivos: permitir RECEPCION
CREATE OR REPLACE FUNCTION generar_turnos_masivos(p_lotes JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador     UUID;
    v_maximo_lote  INTEGER := fn_config_entero('MAXIMO_TURNOS_LOTE', 500);
    v_total_pedido INTEGER;
    v_lote         JSONB;
    v_tramite_text TEXT;
    v_tramite_id   UUID;
    v_cantidad     INTEGER;
    v_turno        JSONB;
    v_emitidos     JSONB := '[]'::JSONB;
    v_codigos      TEXT[] := ARRAY[]::TEXT[];
    v_i            INTEGER;
BEGIN
    IF p_lotes IS NULL OR jsonb_typeof(p_lotes) <> 'array' OR jsonb_array_length(p_lotes) = 0 THEN
        RAISE EXCEPTION 'Debe indicar al menos un lote de turnos.'
            USING ERRCODE = '22023';
    END IF;

    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT (fn_puede_operar_turnos() OR fn_es_recepcion()) THEN
        RAISE EXCEPTION 'El usuario no tiene permiso para emitir turnos.'
            USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(SUM((e->>'cantidad')::INTEGER), 0)
      INTO v_total_pedido
      FROM jsonb_array_elements(p_lotes) AS e;

    IF v_total_pedido <= 0 THEN
        RAISE EXCEPTION 'La cantidad total de turnos debe ser mayor que cero.'
            USING ERRCODE = '22023';
    END IF;

    IF v_total_pedido > v_maximo_lote THEN
        RAISE EXCEPTION 'No se pueden emitir % turnos de golpe; el maximo es %.', v_total_pedido, v_maximo_lote
            USING ERRCODE = 'P0001';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lotes) AS e
                WHERE (e->>'cantidad') IS NULL
                   OR (e->>'cantidad')::INTEGER <= 0) THEN
        RAISE EXCEPTION 'Cada lote debe tener una cantidad mayor que cero.'
            USING ERRCODE = '22023';
    END IF;

    -- [2] EMITE ------------------------------------------------------------
    FOR v_lote IN SELECT * FROM jsonb_array_elements(p_lotes) LOOP
        v_tramite_text := v_lote->>'tramite';
        v_cantidad     := (v_lote->>'cantidad')::INTEGER;

        SELECT id INTO v_tramite_id
          FROM tramites
         WHERE (clave = v_tramite_text OR prefijo = v_tramite_text)
           AND activo
         LIMIT 1;

        IF v_tramite_id IS NULL THEN
            RAISE EXCEPTION 'El tramite % no existe o esta inactivo.', v_tramite_text
                USING ERRCODE = 'P0002';
        END IF;

        FOR v_i IN 1..v_cantidad LOOP
            v_turno := generar_turno(v_tramite_id, 'NORMAL');
            v_emitidos := v_emitidos || v_turno;
            v_codigos  := array_append(v_codigos, v_turno->>'codigo_turno');
        END LOOP;
    END LOOP;

    RETURN jsonb_build_object(
        'ok',      true,
        'total',   v_total_pedido,
        'turnos',  v_emitidos,
        'codigos', v_codigos
    );
END;
$$;

-- 2. V4 activa
UPDATE public.modulos SET estado = 'ACTIVO' WHERE codigo = 'V4';

NOTIFY pgrst, 'reload schema';
COMMIT;

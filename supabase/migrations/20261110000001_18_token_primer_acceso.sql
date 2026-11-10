-- ===========================================================================
-- 018 — Registrar la primera vez que el ciudadano abre su enlace
-- ===========================================================================
-- `token_ultimo_acceso` ya existía y guarda la ÚLTIMA vez. Para "primera
-- vez" hace falta una columna aparte que se setee solo cuando es NULL.
--
-- El frontend la usa así:
--   · token_primer_acceso = NULL  → el ciudadano nunca había abierto el
--     enlace antes de esta carga. Se le muestra "Aún no lo habías abierto".
--   · token_primer_acceso != NULL → ya lo había abierto antes. No se
--     muestra nada (no hay dato que el ciudadano no sepa).
--
-- El campo viejo `creado_en` NO se toca: sigue siendo la hora de emisión
-- del boleto. Solo deja de mostrarse en el portal del ciudadano.
-- ===========================================================================

BEGIN;

ALTER TABLE turnos
  ADD COLUMN IF NOT EXISTS token_primer_acceso TIMESTAMPTZ;

COMMENT ON COLUMN turnos.token_primer_acceso IS
  'Momento de la primera apertura del portal del ciudadano con este token. NULL hasta que la abre por primera vez.';

CREATE OR REPLACE FUNCTION get_turno_publico(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_turno   turnos%ROWTYPE;
    v_tramite tramites%ROWTYPE;
    v_modulo  modulos%ROWTYPE;
    v_pos     INTEGER;
    v_mensaje TEXT;
BEGIN
    IF p_token IS NULL OR length(btrim(p_token)) < 32 THEN
        RAISE EXCEPTION 'Token invalido.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_turno FROM turnos WHERE token_publico = btrim(p_token);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Token invalido o inexistente.' USING ERRCODE = 'P0002';
    END IF;

    IF v_turno.token_expira_en IS NOT NULL AND v_turno.token_expira_en < now() THEN
        RAISE EXCEPTION 'Token expirado.' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_tramite FROM tramites WHERE id = v_turno.tramite_id;
    SELECT * INTO v_modulo  FROM modulos  WHERE id = v_turno.modulo_id;

    IF v_turno.estado = 'WAITING' THEN
        SELECT posicion INTO v_pos
        FROM vista_cola_espera
        WHERE turno_id = v_turno.id;
    END IF;

    v_mensaje := CASE v_turno.estado
        WHEN 'WAITING'   THEN 'Su turno esta en espera.'
        WHEN 'CALLED'    THEN '¡Su turno fue llamado! Acudase a ' || COALESCE(v_modulo.codigo, 'su modulo') || '.'
        WHEN 'SERVING'   THEN 'Su turno esta siendo atendido.'
        WHEN 'COMPLETED' THEN 'Su turno fue atendido. Gracias.'
        WHEN 'CANCELLED' THEN 'Su turno fue cancelado.'
        WHEN 'SKIPPED'   THEN 'Su turno no fue atendido. Acuda a ventanilla para reposicion.'
        ELSE 'Consulte en ventanilla.'
    END;

    -- Primera vez que el ciudadano abre el portal con este token.
    -- v_turno.token_primer_acceso conserva el valor VIEJO a propósito:
    -- el JSON se construye desde v_turno, así que si era NULL lo devuelve
    -- NULL (el frontend muestra "es la primera vez"). El UPDATE solo
    -- persiste el valor; el ciudadano lo verá como "consultado" en la
    -- siguiente carga.
    UPDATE turnos
       SET token_primer_acceso = COALESCE(token_primer_acceso, now()),
           token_ultimo_acceso = now()
     WHERE id = v_turno.id;

    RETURN jsonb_build_object(
        'ok',                        true,
        'codigo_turno',              v_turno.codigo,
        'folio',                     v_turno.folio,
        'estado',                    v_turno.estado,
        'prioridad',                 v_turno.prioridad,
        'denominacion_tramite',      v_tramite.denominacion,
        'posicion',                  COALESCE(v_pos, 0),
        'personas_delante',          GREATEST(COALESCE(v_pos, 1) - 1, 0),
        'modulo',                    v_modulo.codigo,
        'mensaje',                   v_mensaje,
        'creado_en',                 v_turno.creado_en,
        'llamado_en',                v_turno.llamado_en,
        'tiempo_estimado_minutos',   v_turno.tiempo_estimado_mostrado_minutos,
        'token_expira_en',           v_turno.token_expira_en,
        'preferencia_aviso_minutos', v_turno.preferencia_aviso_minutos,
        'token_primer_acceso',       v_turno.token_primer_acceso
    );
END;
$$;

COMMIT;

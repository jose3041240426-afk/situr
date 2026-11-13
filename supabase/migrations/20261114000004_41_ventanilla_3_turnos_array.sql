-- ===========================================================================
-- 041 — Ventanilla: hasta 3 turnos asignados y array en estado_ventanillas()
-- ===========================================================================
--
-- 1. `solicitar_turno_ventanilla()`: contar también ASIGNED en el tope.
--    El tope se lee de `MAXIMO_TURNOS_EN_ATENCION` (default 3).
--    Ahora cuenta ASIGNED + CALLED + SERVING.
--
-- 2. `estado_ventanillas()`: devolver un array de turnos por ventanilla
--    (hasta 3) en lugar de un solo turno. Cada ventanilla incluye:
--    - `turnos_asignados`: array de {turno_id, codigo, estado, denominacion_tramite}
--    - `turno_count`: cantidad de turnos asignados
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- [1] solicitar_turno_ventanilla(): contar ASIGNED en el tope
-- ===========================================================================
-- Solo se modifica la sección que cuenta turnos abiertos para incluir ASIGNED.
-- Se reabre la función completa para mantener consistencia.

CREATE OR REPLACE FUNCTION public.solicitar_turno_ventanilla(p_modulo_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador      UUID;
    v_operador_fila usuarios%ROWTYPE;
    v_modulo        modulos%ROWTYPE;
    v_periodo       UUID;
    v_turno         turnos%ROWTYPE;
    v_tope          INTEGER;
    v_abiertos      INTEGER;
    v_solicitud     BIGINT;
    v_en_espera     INTEGER;
BEGIN
    -- [1] QUIÉN PREGUNTA --------------------------------------------------
    v_operador := fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida: no hay un usuario activo autenticado.'
            USING ERRCODE = '28000';
    END IF;

    IF NOT fn_puede_operar_turnos() THEN
        RAISE EXCEPTION 'No tiene permiso para operar turnos.'
            USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_operador_fila FROM usuarios WHERE id = v_operador;
    IF NOT FOUND OR NOT v_operador_fila.activo THEN
        RAISE EXCEPTION 'El usuario no esta activo.'
            USING ERRCODE = '42501';
    END IF;

    -- [2] LA VENTANILLA QUE SE PIDE ---------------------------------------
    SELECT * INTO v_modulo
      FROM modulos
     WHERE id = p_modulo_id
       AND activo;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'La ventanilla no existe o no esta activa.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_modulo.estado <> 'ACTIVO' THEN
        RAISE EXCEPTION 'La ventanilla % no esta operativa (estado %).',
            v_modulo.codigo, v_modulo.estado
            USING ERRCODE = 'P0001';
    END IF;

    -- [3] DERECHO DEL OPERADOR SOBRE ESA VENTANILLA -------------------------
    IF v_operador_fila.modulo_id IS DISTINCT FROM v_modulo.id
       AND NOT EXISTS (
            SELECT 1 FROM roles r
             WHERE r.id = v_operador_fila.rol_id
               AND r.clave = 'ADMINISTRADOR'
       ) THEN
        RETURN fn_denegar(
            'SOLICITAR_TURNO_VENTANILLA', 'modulos', v_modulo.id, v_operador,
            format('El operador %s no esta asignado a la ventanilla %s.',
                   v_operador_fila.numero_empleado, v_modulo.codigo),
            jsonb_build_object('ventanilla', v_modulo.codigo)
        );
    END IF;

    -- [4] TOPE DE TURNOS ASIGNADOS ----------------------------------------
    -- Ahora cuenta ASIGNED + CALLED + SERVING (antes solo CALLED + SERVING).
    SELECT COALESCE(
        (SELECT NULLIF(btrim(valor), '')::INTEGER
           FROM configuracion
          WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION'),
        3
    ) INTO v_tope;

    SELECT COUNT(*) INTO v_abiertos
      FROM turnos
     WHERE modulo_id = v_modulo.id
       AND estado IN ('ASIGNED', 'CALLED', 'SERVING');

    IF v_abiertos >= v_tope THEN
        RETURN fn_denegar(
            'SOLICITAR_TURNO_VENTANILLA', 'turnos', v_modulo.id, v_operador,
            format('La ventanilla %s ya tiene %d turnos asignados (maximo %d). Finalice uno antes de pedir otro.',
                   v_modulo.codigo, v_abiertos, v_tope),
            jsonb_build_object('ventanilla', v_modulo.codigo, 'abiertos', v_abiertos, 'tope', v_tope)
        );
    END IF;

    -- [5] EL PERIODO Y LA PETICIÓN ------------------------------------------
    SELECT id INTO v_periodo
     FROM periodos_operativos
     WHERE estado = 'ABIERTO'
     ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN fn_denegar(
            'SOLICITAR_TURNO_VENTANILLA', 'periodos_operativos', NULL, v_operador,
            'No hay un periodo operativo abierto. Abralo antes de pedir turnos.',
            jsonb_build_object()
        );
    END IF;

    -- [6] CONTAR TURNOS ANTES DEL REPARTO -----------------------------------
    -- Para saber si se asignó uno nuevo, comparamos antes y después.
    SELECT COUNT(*) INTO v_abiertos
      FROM turnos
     WHERE modulo_id = v_modulo.id
       AND estado IN ('ASIGNED', 'CALLED', 'SERVING');

    -- [7] REGISTRO DE LA PETICIÓN -------------------------------------------
    INSERT INTO solicitudes_ventanilla (modulo_id, operador_id, periodo_operativo_id)
    VALUES (v_modulo.id, v_operador, v_periodo)
    RETURNING id INTO v_solicitud;

    -- [8] REPARTIR ---------------------------------------------------------
    PERFORM fn_repartir_turnos_ventanilla(v_periodo);

    -- [9] RESULTADO --------------------------------------------------------
    -- Comparar si hay un turno más asignado a esta ventanilla.
    SELECT COUNT(*) INTO v_tope
      FROM turnos
     WHERE modulo_id = v_modulo.id
       AND estado IN ('ASIGNED', 'CALLED', 'SERVING');

    SELECT COUNT(*) INTO v_en_espera
      FROM turnos
     WHERE periodo_operativo_id = v_periodo
       AND estado = 'WAITING';

    IF v_tope > v_abiertos THEN
        -- Se asignó al menos un turno nuevo; devolver el más reciente.
        SELECT t.* INTO v_turno
          FROM turnos t
         WHERE t.modulo_id = v_modulo.id
           AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
         ORDER BY t.creado_en DESC LIMIT 1;

        RETURN jsonb_build_object(
            'ok', true,
            'servido', true,
            'turno_id', v_turno.id::text,
            'codigo_turno', v_turno.codigo,
            'modulo_codigo', v_modulo.codigo,
            'en_espera', v_en_espera
        );
    ELSE
        RETURN jsonb_build_object(
            'ok', true,
            'servido', false,
            'en_espera', v_en_espera,
            'motivo', 'No hay turnos disponibles en la cola.'
        );
    END IF;
END;
$$;

COMMENT ON FUNCTION public.solicitar_turno_ventanilla(uuid) IS
  'Pide el siguiente turno para una ventanilla. Tope de 3 turnos (ASIGNED+CALLED+SERVING) (mig 41).';

REVOKE ALL ON FUNCTION public.solicitar_turno_ventanilla(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.solicitar_turno_ventanilla(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.solicitar_turno_ventanilla(uuid) TO authenticated;


-- ===========================================================================
-- [2] estado_ventanillas(): array de turnos por ventanilla
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.estado_ventanillas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_operador uuid;
    v_periodo  uuid;
    v_cola     jsonb;
    v_vent     jsonb;
BEGIN
    v_operador := public.fn_usuario_actual();
    IF v_operador IS NULL THEN
        RAISE EXCEPTION 'Sesion invalida.' USING ERRCODE = '28000';
    END IF;

    SELECT id INTO v_periodo FROM public.periodos_operativos
     WHERE estado = 'ABIERTO' ORDER BY clave DESC LIMIT 1;

    IF v_periodo IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'periodo_id', NULL, 'cola', '[]'::jsonb, 'ventanillas', '[]'::jsonb);
    END IF;

    -- Cola global: WAITING
    SELECT COALESCE(jsonb_agg(row_to_json(t))::jsonb, '[]'::jsonb) INTO v_cola
    FROM (
        SELECT t.id AS turno_id, t.codigo AS codigo_turno,
               tr.prefijo AS clave_tramite, tr.denominacion AS denominacion_tramite,
               row_number() OVER (ORDER BY
                   CASE t.prioridad WHEN 'URGENTE' THEN 1 WHEN 'PREFERENTE' THEN 2 ELSE 3 END,
                   t.creado_en, t.id
               ) AS posicion
        FROM public.turnos t
        JOIN public.tramites tr ON tr.id = t.tramite_id
        WHERE t.periodo_operativo_id = v_periodo
          AND t.estado = 'WAITING'
    ) t;

    -- Ventanillas con array de turnos asignados (ASIGNED, CALLED, SERVING).
    SELECT COALESCE(jsonb_agg(row_to_json(v))::jsonb, '[]'::jsonb) INTO v_vent
    FROM (
        SELECT
            m.id AS modulo_id,
            m.codigo,
            m.denominacion,
            m.estado AS estado_ventanilla,
            CASE
                WHEN EXISTS (
                    SELECT 1 FROM public.turnos t2
                    WHERE t2.modulo_id = m.id AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                ) THEN 'ATENDIENDO'
                ELSE 'DISPONIBLE'
            END AS estado_con_turno,
            -- Array de turnos asignados (hasta 3)
            COALESCE((
                SELECT jsonb_agg(row_to_json(tt))
                FROM (
                    SELECT
                        t.id AS turno_id,
                        t.codigo AS turno_codigo,
                        t.estado AS turno_estado,
                        tr.denominacion AS turno_denominacion_tramite,
                        EXTRACT(EPOCH FROM (now() - t.llamado_en)) / 60 AS minutos_en_ventanilla,
                        u.nombres || ' ' || COALESCE(a_pat.apellido, '') || ' ' || COALESCE(a_mat.apellido, '') AS operador_nombres
                    FROM public.turnos t
                    JOIN public.tramites tr ON tr.id = t.tramite_id
                    LEFT JOIN public.usuarios u ON u.id = t.atendido_por
                    LEFT JOIN public.apellidos a_pat ON a_pat.id = u.apellido_paterno_id
                    LEFT JOIN public.apellidos a_mat ON a_mat.id = u.apellido_materno_id
                    WHERE t.modulo_id = m.id
                      AND t.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                    ORDER BY t.creado_en
                    LIMIT 3
                ) tt
            ), '[]'::jsonb) AS turnos_asignados,
            (
                SELECT COUNT(*)
                FROM public.turnos t2
                WHERE t2.modulo_id = m.id
                  AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
            ) AS turno_count,
            (m.id IS NOT DISTINCT FROM (SELECT modulo_id FROM public.usuarios WHERE id = v_operador)) AS es_mia,
            CASE
                WHEN NOT EXISTS (
                    SELECT 1 FROM public.turnos t2
                    WHERE t2.modulo_id = m.id AND t2.estado IN ('ASIGNED', 'CALLED', 'SERVING')
                ) AND m.estado = 'ACTIVO' THEN true
                ELSE false
            END AS disponible
        FROM public.modulos m
        WHERE m.activo
        ORDER BY m.codigo
    ) v;

    RETURN jsonb_build_object(
        'ok', true,
        'periodo_id', v_periodo,
        'cola', v_cola,
        'ventanillas', v_vent
    );
END;
$$;

COMMENT ON FUNCTION public.estado_ventanillas() IS
  'La cola global y el estado de cada ventanilla con array de turnos asignados (mig 41).';

REVOKE ALL ON FUNCTION public.estado_ventanillas() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.estado_ventanillas() FROM anon;
GRANT EXECUTE ON FUNCTION public.estado_ventanillas() TO authenticated;

-- [3] Notificar schema reload ------------------------------------------------
NOTIFY pgrst, 'reload schema';

COMMIT;

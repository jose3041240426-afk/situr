-- ===========================================================================
-- 010 — Límite de turnos activos en el panel «En atención ahora»
-- ===========================================================================
--
-- QUÉ PROBLEMA RESUELVE
-- Al llamar a un turno, este pasa a CALLED y aparece en «En atención ahora»
-- hasta que se finaliza o se cancela. Si el operador llama varias veces sin
-- cerrar los anteriores (olvido, atiende en ventanilla, se distrae), el panel
-- crece y empuja el botón «Llamar» fuera de la pantalla.
--
-- CUÁL ES UN LÍMITE RAZONABLE
-- Físicamente un operador tiene UNA ventanilla:
--   · un turno SERVING  = alguien sentado delante (no puede haber dos)
--   · turnos CALLED     = ciudadanos caminando hacia la ventanilla
-- Con 3 se cubre el margen de avisos que se cruzan sin acumular trabajo
-- invisible. El valor vive en `configuracion` para que la dependencia lo suba
-- o baje sin recompilar la aplicación, igual que MAXIMO_TURNOS_LOTE.
--
-- POR QUÉ EL LÍMITE SE COMPRUEBA EN EL SERVIDOR Y NO SOLO EN LA CONSOLA
-- El botón deshabilitado es comodidad; la regla es del servidor. Dos pestañas
-- abiertas, o una llamada directa a la RPC, saltarían un límite que solo
-- viviera en el navegador.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. La clave de configuración
-- ---------------------------------------------------------------------------
INSERT INTO configuracion (clave, nombre, valor, tipo, descripcion)
VALUES (
    'MAXIMO_TURNOS_EN_ATENCION',
    'Turnos abiertos a la vez por operador',
    '3',
    'ENTERO',
    'Turnos CALLED+SERVING que un operador puede tener abiertos. Al llegar al límite la consola bloquea «Llamar» hasta que finalice o cancele uno.'
)
ON CONFLICT (clave) DO UPDATE
   SET descripcion = EXCLUDED.descripcion;

-- ---------------------------------------------------------------------------
-- 2. RPC que la consola consulta para saber el límite vigente
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION maximo_en_atencion()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_valor INTEGER;
BEGIN
    SELECT NULLIF(btrim(valor), '')::INTEGER INTO v_valor
      FROM configuracion
     WHERE clave = 'MAXIMO_TURNOS_EN_ATENCION';

    -- Si la clave no existe o quedó vacía, se usa 3: la consola nunca debe
    -- quedarse sin cifra, y 0 bloquearía toda llamada (peor que no tener
    -- límite).
    RETURN COALESCE(v_valor, 3);
EXCEPTION
    WHEN invalid_text_representation THEN
        RETURN 3;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Contar los turnos activos de un operador
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION turnos_en_atencion_de(p_usuario_id UUID)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COUNT(*)::INTEGER
      FROM turnos
     WHERE estado IN ('CALLED', 'SERVING')
       AND atendido_por = p_usuario_id;
$$;

COMMENT ON FUNCTION turnos_en_atencion_de(UUID) IS
    'Turnos CALLED+SERVING del operador. Alimenta el límite de «En atención ahora».';

COMMIT;

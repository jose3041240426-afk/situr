-- ===========================================================================
-- 017 — actualizar_preferencia_aviso también ejecutable por authenticated
-- ===========================================================================
BEGIN;
GRANT EXECUTE ON FUNCTION actualizar_preferencia_aviso(TEXT, INTEGER)
    TO authenticated;
COMMIT;

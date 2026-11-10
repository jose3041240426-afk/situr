-- ===========================================================================
-- 021 — El rol AGENTE (operador de ventanilla)
-- ===========================================================================
--
-- POR QUÉ
-- `fn_puede_operar_turnos()` admite dos roles: ADMINISTRADOR y AGENTE. Pero la
-- semilla solo creaba ADMINISTRADOR y SUPERVISOR, así que **no había forma de
-- dar de alta a un operador**: cualquier segunda cuenta acababa siendo otro
-- administrador, con acceso a usuarios, catálogos y cierre de jornada.
--
-- El DRS deja AGENTE como rol de la operación diaria y SUPERVISOR como
-- supervisión (que NO opera turnos). Esto solo completa lo que la función ya
-- esperaba; no cambia permisos ni políticas: los menús y las RPC ya
-- distinguen administrador de agente.
-- ===========================================================================

INSERT INTO roles (clave, nombre, descripcion)
VALUES (
    'AGENTE',
    'Agente de ventanilla',
    'Atiende turnos en su módulo: emitir, llamar, iniciar y finalizar atención. '
    'Sin acceso a usuarios, catálogos ni cierre de jornada.'
)
ON CONFLICT (clave) DO NOTHING;

-- ============================================================================
-- SITUR — Datos semilla (Supabase)
--
-- Se ejecuta en `supabase db reset` (desarrollo local) y es idempotente, así
-- que también se puede volver a aplicar sin miedo.
--
-- El administrador se crea aquí con el correo de arranque; el script
-- `scripts/arrancar.mjs` lo sustituye por el correo institucional real y le
-- enlaza su `auth_uid` de Supabase Auth. Ese enlace es el paso que no se
-- puede automatizar desde SQL: la sesión vive fuera de esta base.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- ROLES (RF-002: en el MVP solo ADMINISTRADOR; SUPERVISOR queda para Fase 2)
-- ---------------------------------------------------------------------------
INSERT INTO roles (clave, nombre, descripcion) VALUES
    ('ADMINISTRADOR',
     'Administrador',
     'Acceso total: usuarios, catálogos, periodos, turnos, historial y auditoría.'),
    ('SUPERVISOR',
     'Supervisor',
     'Supervisión de operación, estadísticas e historial. Sin gestión de usuarios.')
ON CONFLICT (clave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- TRÁMITES  (el prefijo es UNIQUE GLOBAL: 'A-001' no puede repetirse)
-- ---------------------------------------------------------------------------
INSERT INTO tramites (clave, prefijo, denominacion, prioridad, tiempo_estimado_minutos) VALUES
    ('PRED',   'A', 'Predial',                 'NORMAL',    10),
    ('LIC',    'L', 'Licencias y permisos',    'NORMAL',    20),
    ('CONST',  'C', 'Constancias',             'NORMAL',     5),
    ('GRAV',   'G', 'Gravámenes y gravamen',   'NORMAL',    15),
    ('REG',    'R', 'Registro catastral',      'PREFERENTE', 25)
ON CONFLICT (clave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- MÓDULOS  (M04 pausado a propósito: hay que ver un módulo no operativo)
-- ---------------------------------------------------------------------------
INSERT INTO modulos (codigo, denominacion, estado, activo) VALUES
    ('M01', 'Módulo 01 - Atención general', 'ACTIVO', TRUE),
    ('M02', 'Módulo 02 - Documentación',    'ACTIVO', TRUE),
    ('M03', 'Módulo 03 - Información',      'ACTIVO', TRUE),
    ('M04', 'Módulo 04 - Reserva',          'PAUSADO', TRUE)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- APELLIDOS (catálogo)
-- ---------------------------------------------------------------------------
INSERT INTO apellidos (apellido) VALUES
    ('GUERRERO'), ('HERNANDEZ'), ('MATHEY'), ('SIMENTAL'), ('TAVIZON')
ON CONFLICT (apellido) DO NOTHING;

-- ---------------------------------------------------------------------------
-- USUARIO ADMINISTRADOR INICIAL
--
-- `auth_uid` queda NULL: es `scripts/arrancar.mjs` quien lo rellena con el
-- UUID de Supabase Auth. Sin ese enlace el registro existe pero no hay
-- sesión ni RLS que lo deje pasar (RF-003, RF-001).
-- ---------------------------------------------------------------------------
INSERT INTO usuarios (
    nombres, apellido_paterno_id, apellido_materno_id,
    email, numero_empleado, rol_id, modulo_id,
    activo, mfa_habilitado
)
SELECT
    'Administrador',
    (SELECT id FROM apellidos WHERE apellido = 'GUERRERO'),
    (SELECT id FROM apellidos WHERE apellido = 'SIMENTAL'),
    'admin@situr.local',
    'EMP-0001',
    (SELECT id FROM roles WHERE clave = 'ADMINISTRADOR'),
    NULL,
    TRUE,
    FALSE
WHERE NOT EXISTS (
    SELECT 1 FROM usuarios WHERE numero_empleado = 'EMP-0001'
);

-- ---------------------------------------------------------------------------
-- CONFIGURACIÓN  (RF-023: todos los parámetros numéricos se leen de aquí)
-- ---------------------------------------------------------------------------
INSERT INTO configuracion (clave, nombre, valor, tipo, descripcion) VALUES
    ('LONGITUD_NUMERO_FOLIO',
     'Longitud del número de turno',
     '3', 'ENTERO',
     'Dígitos del consecutivo. 3 produce A-001..A-999.'),

    ('MAXIMO_TURNOS_DIARIOS',
     'Máximo de turnos diarios por trámite',
     '999', 'ENTERO',
     'Tope de folios que un trámite puede emitir dentro de un periodo. Antes estaba hardcodeado en el procedimiento.'),

    ('MINUTOS_VIGENCIA_TOKEN_EN_ESPERA',
     'Vigencia del token en estado activo',
     '1440', 'ENTERO',
     'Minutos de validez del QR mientras el turno está WAITING/CALLED/SERVING (DRS §9).'),

    ('HORAS_VIGENCIA_TOKEN_ATENDIDO',
     'Vigencia del token tras ser atendido',
     '24', 'ENTERO',
     'Horas de consulta pública después de COMPLETED (DRS §9).'),

    ('HORAS_VIGENCIA_TOKEN_CERRADO',
     'Vigencia del token cancelado u omitido',
     '1', 'ENTERO',
     'Horas de consulta pública tras CANCELLED o SKIPPED (DRS §9).'),

    ('MINUTOS_TIMEOUT_LLAMADA',
     'Tiempo de espera tras ser llamado',
     '5', 'ENTERO',
     'Minutos antes de que pg_cron marque CALLED -> SKIPPED con motivo TIMEOUT_LLAMADA (RF-013, Figura 11).'),

    ('POSICION_AVISO_PUSH',
     'Posición en la que se avisa por push',
     '3', 'ENTERO',
     'Si la posición del turno en su trámite baja de este valor, se envía el aviso de turno cercano (RF-028).'),

    ('MINUTOS_AVISO_PUSH',
     'Minutos de espera en los que se avisa por push',
     '10', 'ENTERO',
     'Si el tiempo estimado mostrado del turno baja de este valor, se envía el aviso de turno cercano (RF-028).')
ON CONFLICT (clave) DO NOTHING;

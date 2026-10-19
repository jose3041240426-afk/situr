-- ============================================================================
-- SITUR — MIGRACIÓN 006: DATOS INICIALES
-- Modelo de datos FUSIONADO v2.0
--
-- Todo con ON CONFLICT DO NOTHING: la migración se puede re-ejecutar.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ROLES
-- SITUR/RF-002 pide ADMINISTRADOR en MVP y SUPERVISOR en Fase 2. Se siembran
-- exactamente esos dos.
--
-- El tercer rol de TOMA_TURNO (TRABAJADOR) NO se siembra: contradiría RF-002.
-- Lo que sí se hereda de TOMA_TURNO es que la tabla existe, así que agregarlo
-- más adelante es un INSERT y no una migración de estructura:
--     INSERT INTO roles (clave, nombre, descripcion)
--     VALUES ('AGENTE', 'Agente de módulo', 'Opera un módulo y atiende turnos.');
-- Esa es la ventaja concreta de la tabla frente al ENUM que tenía el DRS.
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
-- 2. TRÁMITES
-- Claves y prefijos tal como aparecen en el DRS (`PRED`, `LIC...` / `A`, `L...`).
-- El prefijo es UNIQUE GLOBAL (aportado de TOMA_TURNO): por eso el código
-- visible 'A-001' no puede repetirse entre dos trámites distintos.
-- ---------------------------------------------------------------------------
INSERT INTO tramites (clave, prefijo, denominacion, prioridad, tiempo_estimado_minutos) VALUES
    ('PRED',   'A', 'Predial',                     'NORMAL',    10),
    ('LIC',    'L', 'Licencias y permisos',        'NORMAL',    20),
    ('CONST',  'C', 'Constancias',                 'NORMAL',     5),
    ('GRAV',   'G', 'Gravámenes y gravamen',       'NORMAL',    15),
    ('REG',    'R', 'Registro catastral',          'PREFERENTE', 25)
ON CONFLICT (clave) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. MÓDULOS / VENTANILLAS
-- ---------------------------------------------------------------------------
INSERT INTO modulos (codigo, denominacion, estado, activo) VALUES
    ('M01', 'Módulo 01 - Atención general', 'ACTIVO', TRUE),
    ('M02', 'Módulo 02 - Documentación',    'ACTIVO', TRUE),
    ('M03', 'Módulo 03 - Información',      'ACTIVO', TRUE),
    ('M04', 'Módulo 04 - Reserva',          'PAUSADO', TRUE)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. USUARIO ADMINISTRADOR INICIAL
-- `auth_uid` queda NULL a propósito: debe completarse con el UUID del usuario
-- creado en Supabase Auth, que es lo que RLS y fn_usuario_actual() leen.
-- Sin ese enlace el registro existe pero no puede iniciar sesión.
-- ---------------------------------------------------------------------------
INSERT INTO apellidos (apellido) VALUES
    ('GUERRERO'), ('HERNANDEZ'), ('MATHEY'), ('SIMENTAL'), ('TAVIZON')
ON CONFLICT (apellido) DO NOTHING;

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
-- 5. CONFIGURACIÓN          <<< PORTADA DE TOMA_TURNO >>>
-- Todos estos valores los procedimientos LEEN de aquí; ninguno está escrito a
-- mano dentro de una función (que era el bug original de TOMA_TURNO).
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

    -- --- RF-028, DRS v1.5 §5.2: cuándo se considera que "el turno se acerca"
    -- y hay que mandar el aviso push. El umbral de posición manda sobre
    -- trámites con mucha cola; el de minutos, sobre trámites tranquilos donde
    -- la posición nunca bajaría de 3 pero el turno está a dos minutos.
    ('POSICION_AVISO_PUSH',
     'Posición en la que se avisa por push',
     '3', 'ENTERO',
     'Si la posición del turno en su trámite baja de este valor, se envía el aviso de turno cercano (RF-028).'),

    ('MINUTOS_AVISO_PUSH',
     'Minutos de espera en los que se avisa por push',
     '10', 'ENTERO',
     'Si el tiempo estimado mostrado del turno baja de este valor, se envía el aviso de turno cercano (RF-028).')
ON CONFLICT (clave) DO NOTHING;

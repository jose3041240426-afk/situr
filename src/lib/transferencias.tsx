import { createContext, useContext, useMemo, useState } from 'react'
import type { TransferenciaPendiente } from './tipos'

/**
 * Estado compartido de las solicitudes de transferencia pendientes de la
 * ventanilla del operador. La pantalla `ColaVentanillas` las publica cada vez
 * que recarga; la cabecera global (`Disposicion`) muestra la campana y el
 * panel de notificaciones (desplegable anclado a la campana).
 */
interface EstadoTransferencias {
  pendientes: TransferenciaPendiente[]
  codigoVentanilla: string | null
  publicar: (pendientes: TransferenciaPendiente[], codigoVentanilla: string | null) => void
  panelAbierto: boolean
  abrirPanel: () => void
  cerrarPanel: () => void
  refrescar: () => void
  registrarRefrescar: (fn: () => void) => void
}

const Ctx = createContext<EstadoTransferencias>({
  pendientes: [],
  codigoVentanilla: null,
  publicar: () => {},
  panelAbierto: false,
  abrirPanel: () => {},
  cerrarPanel: () => {},
  refrescar: () => {},
  registrarRefrescar: () => {},
})

export function TransferenciasProvider({ children }: { children: React.ReactNode }) {
  const [pendientes, setPendientes] = useState<TransferenciaPendiente[]>([])
  const [codigoVentanilla, setCodigoVentanilla] = useState<string | null>(null)
  const [panelAbierto, setPanelAbierto] = useState(false)
  const [refrescarFn, setRefrescarFn] = useState<() => void>(() => () => {})

  const valor = useMemo<EstadoTransferencias>(
    () => ({
      pendientes,
      codigoVentanilla,
      publicar: (p, c) => {
        setPendientes(p)
        setCodigoVentanilla(c)
      },
      panelAbierto,
      abrirPanel: () => setPanelAbierto(true),
      cerrarPanel: () => setPanelAbierto(false),
      refrescar: () => refrescarFn(),
      registrarRefrescar: (fn) => setRefrescarFn(() => fn),
    }),
    [pendientes, codigoVentanilla, panelAbierto, refrescarFn]
  )

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>
}

export function useTransferencias() {
  return useContext(Ctx)
}

import { createContext, useContext, useMemo, useState } from 'react'
import type { TransferenciaPendiente } from './tipos'

/**
 * Estado compartido de las solicitudes de transferencia pendientes de la
 * ventanilla del operador. La pantalla `ColaVentanillas` las publica cada vez
 * que recarga; la cabecera global (`Disposicion`) solo las lee para mostrar la
 * campana. El modal de respuesta vive en la pantalla y se abre pidiéndolo aquí.
 */
interface EstadoTransferencias {
  /** Solicitudes pendientes de la ventanilla del operador. */
  pendientes: TransferenciaPendiente[]
  /** Código de la ventanilla del operador. */
  codigoVentanilla: string | null
  /** Publica los pendientes desde la pantalla. */
  publicar: (pendientes: TransferenciaPendiente[], codigoVentanilla: string | null) => void
  /** La campana pide abrir el modal. */
  solicitarApertura: () => void
  /** Contador de aperturas solicitadas (lo observa la pantalla). */
  aperturas: number
}

const Ctx = createContext<EstadoTransferencias>({
  pendientes: [],
  codigoVentanilla: null,
  publicar: () => {},
  solicitarApertura: () => {},
  aperturas: 0,
})

export function TransferenciasProvider({ children }: { children: React.ReactNode }) {
  const [pendientes, setPendientes] = useState<TransferenciaPendiente[]>([])
  const [codigoVentanilla, setCodigoVentanilla] = useState<string | null>(null)
  const [aperturas, setAperturas] = useState(0)

  const valor = useMemo<EstadoTransferencias>(
    () => ({
      pendientes,
      codigoVentanilla,
      publicar: (p, c) => {
        setPendientes(p)
        setCodigoVentanilla(c)
      },
      solicitarApertura: () => setAperturas(n => n + 1),
      aperturas,
    }),
    [pendientes, codigoVentanilla, aperturas]
  )

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>
}

export function useTransferencias() {
  return useContext(Ctx)
}

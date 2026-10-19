import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * Código QR del turno (RF-006).
 *
 * El QR **no contiene datos del ciudadano**: apunta a `/turno/{token}` y
 * quien lo escanea llega a su turno con su token. No hay nombre, ni correo,
 * ni teléfono en ninguna parte (RF-017: el ciudadano no da ningún dato).
 */
export default function CodigoQR({
  valor,
  tamano = 220,
}: {
  valor: string
  tamano?: number
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let vigente = true
    QRCode.toDataURL(valor, {
      width: tamano * 2,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#16233a', light: '#ffffff' },
    })
      .then((u) => {
        if (vigente) setUrl(u)
      })
      .catch(() => {
        if (vigente) setError('No se pudo generar el código QR.')
      })
    return () => {
      vigente = false
    }
  }, [valor, tamano])

  if (error) {
    return (
      <p className="rounded-lg border border-peligro-500/30 bg-peligro-50 px-4 py-3 text-sm text-peligro-700">
        {error}
      </p>
    )
  }

  if (!url) {
    return (
      <div
        className="animate-pulse rounded-lg bg-institucional-100"
        style={{ width: tamano, height: tamano }}
      />
    )
  }

  return (
    <img
      src={url}
      alt={`Código QR del turno ${valor}`}
      width={tamano}
      height={tamano}
      className="rounded-lg border border-institucional-100 bg-white p-1"
    />
  )
}

import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Campo de texto (shadcn/ui, adaptado a SITUR).
 *
 * Hereda la forma del sistema: el mismo borde, el mismo relleno y el mismo
 * color de texto que usa `.campo` en el resto de la aplicación.
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-11 w-full rounded-lg border border-input bg-white px-3 py-2.5 text-sm text-navy-900 placeholder:text-gris-500 ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-navy-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        ref={ref}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export { Input }

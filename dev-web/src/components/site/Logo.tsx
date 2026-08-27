import logoEmblem from '@/assets/mission-sep-emblem.png'
import logoRightColor from '@/assets/mission-sep-right.png'
import logoRightWhite from '@/assets/mission-sep-white.png'

export function Logo({
  light = false,
  className = '',
}: {
  light?: boolean
  className?: string
}) {
  return (
    <div className={`flex items-center transition-all duration-300 ${className}`}>
      {/* Left Circular Emblem (Always shown in full color) */}
      <div className="flex items-center justify-center shrink-0 mr-2 sm:mr-2.5">
        <img
          src={logoEmblem}
          alt="TTAADC Seal"
          width={60}
          height={60}
          className="h-7.5 sm:h-8.5 md:h-9.5 lg:h-10 w-auto object-contain shrink-0"
        />
      </div>

      {/* Right Text & Graphic (Transitions between white on dark bg and color on light bg) */}
      <div className="relative flex items-center shrink-0">
        {/* White Graphic (for dark backgrounds) */}
        <img
          src={logoRightWhite}
          alt="TTAADC Mission SEP"
          width={190}
          height={60}
          className={`h-7.5 sm:h-8.5 md:h-9.5 lg:h-10 w-auto object-contain transition-opacity duration-300 drop-shadow-sm ${
            light ? 'opacity-100' : 'opacity-0 absolute inset-0 pointer-events-none'
          }`}
        />

        {/* Color Graphic (for light backgrounds) */}
        <img
          src={logoRightColor}
          alt="TTAADC Mission SEP"
          width={190}
          height={60}
          className={`h-7.5 sm:h-8.5 md:h-9.5 lg:h-10 w-auto object-contain transition-opacity duration-300 ${
            !light ? 'opacity-100' : 'opacity-0 absolute inset-0 pointer-events-none'
          }`}
        />
      </div>
    </div>
  )
}

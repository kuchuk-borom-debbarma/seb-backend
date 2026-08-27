import { useEffect, useRef, type ElementType, type ReactNode } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

type RevealProps = {
  children: ReactNode
  className?: string
  as?: ElementType
  delay?: number
  y?: number
  x?: number
  duration?: number
}

export function Reveal({
  children,
  className,
  as: Tag = 'div',
  delay = 0,
  y = 28,
  x = 0,
  duration = 0.9,
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    // On mobile (< 1024px), skip ScrollTrigger animations for instant touch responsiveness
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      return
    }

    gsap.registerPlugin(ScrollTrigger)
    const el = ref.current
    if (!el) return

    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        { opacity: 0, y, x },
        {
          opacity: 1,
          y: 0,
          x: 0,
          duration,
          delay,
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
        },
      )
    })

    return () => ctx.revert()
  }, [delay, duration, x, y])

  return (
    <Tag ref={ref} className={className}>
      {children}
    </Tag>
  )
}

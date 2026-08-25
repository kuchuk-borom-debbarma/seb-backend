import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { Reveal } from './Reveal'

const stats = [
  { value: 2480, suffix: '+', label: 'Enterprises assisted' },
  { value: 96, suffix: ' Cr', label: 'Seed funding disbursed' },
  { value: 58, suffix: '', label: 'Blocks covered' },
  { value: 31, suffix: ' days', label: 'Average approval time' },
]

export function Impact() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger)
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>('[data-count]').forEach((el) => {
        const target = Number(el.dataset['count'])
        const obj = { v: 0 }
        gsap.to(obj, {
          v: target,
          duration: 1.6,
          ease: 'power2.out',
          scrollTrigger: { trigger: el, start: 'top 90%', once: true },
          onUpdate: () => {
            el.textContent = Math.round(obj.v).toLocaleString('en-IN')
          },
        })
      })
    }, ref)
    return () => ctx.revert()
  }, [])

  return (
    <section id="stories" ref={ref} className="bg-primary text-primary-foreground">
      <div className="mx-auto max-w-[1500px] px-6 py-24 md:px-10 md:py-28">
        <Reveal>
          <h2 className="max-w-2xl text-[clamp(1.9rem,3.2vw,2.7rem)] font-extrabold leading-[1.15] tracking-tight">
            Measured impact across the council area.
          </h2>
        </Reveal>
        <div className="mt-14 grid gap-12 sm:grid-cols-2 lg:grid-cols-4">
          {stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 0.08}>
              <p className="display text-[clamp(2.8rem,5vw,4.2rem)]">
                <span data-count={s.value}>0</span>
                {s.suffix}
              </p>
              <p className="mt-3 text-[15px] text-primary-foreground/75">{s.label}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}

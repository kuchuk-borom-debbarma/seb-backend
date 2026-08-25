import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { Laptop, ClipboardCheck, Landmark, BadgeCheck, ArrowDown } from 'lucide-react'

interface StepItem {
  step: string
  title: string
  desc: string
  Icon: React.ElementType
  img: string
  imgAlt: string
}

const steps: StepItem[] = [
  {
    step: 'STEP 01',
    title: 'Apply Online',
    desc: 'Submit your basic profile and Detailed Project Report (DPR) through the portal.',
    Icon: Laptop,
    img: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?q=80&w=800&auto=format&fit=crop',
    imgAlt: 'Applicant submitting DPR through online single-window portal',
  },
  {
    step: 'STEP 02',
    title: 'Desk Review',
    desc: 'Department of Industries validates KYC, ST identity, and DPR feasibility.',
    Icon: ClipboardCheck,
    img: 'https://images.unsplash.com/photo-1450133064473-71024230f91b?q=80&w=800&auto=format&fit=crop',
    imgAlt: 'Department reviewing documentation and verifying eligibility',
  },
  {
    step: 'STEP 03',
    title: 'Bank Evaluation',
    desc: 'Partner banks conduct fast-track credit appraisal for institutional loan linkages.',
    Icon: Landmark,
    img: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=800&auto=format&fit=crop',
    imgAlt: 'Scheduled commercial bank partner conducting credit assessment',
  },
  {
    step: 'STEP 04',
    title: 'Sanction & Release',
    desc: 'TTM issues final seed grant sanction and disburses funds against milestones.',
    Icon: BadgeCheck,
    img: 'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?q=80&w=800&auto=format&fit=crop',
    imgAlt: 'Formal grant sanction and funds release ceremony',
  },
]

const IMAGE_REVEAL_RADIUS = '0.75rem'
const IMAGE_REVEAL_HIDDEN = `inset(0% 0% 100% 0% round ${IMAGE_REVEAL_RADIUS})`
const IMAGE_REVEAL_VISIBLE = `inset(0% 0% 0% 0% round ${IMAGE_REVEAL_RADIUS})`

export function Process() {
  const sectionRef = useRef<HTMLElement>(null)
  const desktopStageRef = useRef<HTMLDivElement>(null)
  const desktopContainerRef = useRef<HTMLDivElement>(null)
  const desktopLineRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger)

    const section = sectionRef.current
    if (!section) return

    const mm = gsap.matchMedia()

    // Desktop ONLY (>= 1024px): Pinned split-screen with timeline reveals
    mm.add('(min-width: 1024px)', () => {
      if (
        !desktopStageRef.current ||
        !desktopContainerRef.current ||
        !desktopLineRef.current
      )
        return

      const container = desktopContainerRef.current
      const line = desktopLineRef.current
      const badges = container.querySelectorAll<HTMLElement>('.proc-icon-badge')

      if (badges.length >= 2) {
        const firstBadge = badges[0]!
        const lastBadge = badges[badges.length - 1]!
        const cRect = container.getBoundingClientRect()
        const fRect = firstBadge.getBoundingClientRect()
        const lRect = lastBadge.getBoundingClientRect()

        const top = fRect.top + fRect.height / 2 - cRect.top
        const bottom = cRect.bottom - (lRect.top + lRect.height / 2)
        const left = fRect.left + fRect.width / 2 - cRect.left

        gsap.set(line, {
          top: `${top}px`,
          bottom: `${bottom}px`,
          left: `${left}px`,
          opacity: 0,
          scaleY: 0,
          transformOrigin: 'top center',
        })
      }

      const items = gsap.utils.toArray<HTMLElement>('.proc-desktop-item')

      items.forEach((item) => {
        const iconNode = item.querySelector<HTMLElement>('.proc-icon-badge')
        const textNode = item.querySelector<HTMLElement>('.proc-text-block')
        const reveal = item.querySelector<HTMLElement>('.proc-image-reveal')
        const mediaNode = item.querySelector<HTMLElement>('.proc-image-media')

        if (iconNode) gsap.set(iconNode, { opacity: 0, scale: 0.75 })
        if (textNode) gsap.set(textNode, { opacity: 0, y: 18 })
        if (reveal) gsap.set(reveal, { clipPath: IMAGE_REVEAL_HIDDEN })
        if (mediaNode) gsap.set(mediaNode, { scale: 1.12, yPercent: 5 })
      })

      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: desktopStageRef.current,
          start: 'top top',
          end: () => `+=${window.innerHeight * (steps.length * 0.85)}`,
          pin: true,
          scrub: 1.1,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      })

      tl.to(line, { opacity: 1, scaleY: 1, duration: steps.length * 0.95 }, 0)

      items.forEach((item, index) => {
        const iconNode = item.querySelector<HTMLElement>('.proc-icon-badge')
        const textNode = item.querySelector<HTMLElement>('.proc-text-block')
        const reveal = item.querySelector<HTMLElement>('.proc-image-reveal')
        const mediaNode = item.querySelector<HTMLElement>('.proc-image-media')

        const at = index * 0.95

        if (iconNode) {
          tl.to(iconNode, { opacity: 1, scale: 1, duration: 0.35 }, at)
        }

        if (textNode) {
          tl.to(textNode, { opacity: 1, y: 0, duration: 0.38 }, at + 0.05)
        }

        if (reveal) {
          tl.to(reveal, { clipPath: IMAGE_REVEAL_VISIBLE, duration: 0.75 }, at + 0.15)
        }

        if (mediaNode) {
          tl.to(mediaNode, { scale: 1, yPercent: 0, duration: 0.75 }, at + 0.15)
        }
      })
    })

    return () => mm.revert()
  }, [])

  return (
    <section id="how-it-works" ref={sectionRef} className="relative w-full bg-[#0c141f]">
      {/* ========================================================================= */}
      {/* DESKTOP VIEW (>= 1024px: Pinned Brology Split Stage)                      */}
      {/* ========================================================================= */}
      <div
        ref={desktopStageRef}
        className="hidden lg:flex relative h-[100svh] min-h-[700px] w-full overflow-hidden"
      >
        <div className="relative flex w-1/2 flex-col justify-between p-10 xl:p-14 text-white">
          <div className="absolute inset-0 z-0 bg-[#0c141f]" />
          <div className="relative z-10">
            <p className="text-xs xl:text-sm font-semibold uppercase tracking-[0.24em] text-[#d1ab76]">
              How To Apply
            </p>
            <h2 className="mt-3 font-serif text-3xl xl:text-4xl 2xl:text-5xl font-bold leading-tight text-white">
              A transparent process, end to end.
            </h2>
            <p className="mt-4 text-xs xl:text-sm 2xl:text-base leading-relaxed text-white/80 max-w-lg">
              Simple steps. Clear checks. Faster decisions. Smarter support. From
              application to grant, we&apos;ve made it seamless.
            </p>
          </div>

          <div className="relative z-10 flex items-center gap-3 text-xs text-white/70">
            <div className="flex size-7 items-center justify-center rounded-full bg-white/10">
              <ArrowDown className="size-3.5" />
            </div>
            <span>Scroll to explore application milestones</span>
          </div>
        </div>

        <div className="relative flex w-1/2 flex-col justify-center bg-[#ded8ce] p-10 xl:p-14">
          <div className="relative mx-auto w-full max-w-lg">
            <div
              ref={desktopContainerRef}
              className="relative flex flex-col gap-6 xl:gap-8"
            >
              <div
                ref={desktopLineRef}
                className="absolute w-0 -translate-x-1/2 border-l-2 border-dashed border-[#181715]/25 origin-top pointer-events-none z-0"
              />

              {steps.map((item) => (
                <div key={`dt-${item.step}`} className="proc-desktop-item relative">
                  <div className="grid grid-cols-[auto_1fr_auto] gap-4 xl:gap-5 items-center">
                    <div className="proc-icon-badge relative z-10 flex size-9 xl:size-10 shrink-0 items-center justify-center rounded-full border border-[#181715]/20 bg-[#ded8ce] text-[#181715] shadow-xs">
                      <item.Icon className="size-4 xl:size-4.5 stroke-[1.5]" />
                    </div>

                    <div className="proc-text-block min-w-0 pr-2">
                      <span className="text-[10px] xl:text-[11px] font-bold uppercase tracking-[0.2em] text-[#a47b46]">
                        {item.step}
                      </span>
                      <h3 className="mt-0.5 font-serif text-base xl:text-lg font-bold tracking-tight text-[#181715]">
                        {item.title}
                      </h3>
                      <p className="mt-0.5 text-[12px] xl:text-[13px] leading-snug text-[#181715]/75 line-clamp-2">
                        {item.desc}
                      </p>
                    </div>

                    <div className="shrink-0 w-28 sm:w-32 xl:w-40">
                      <div
                        className="proc-image-reveal overflow-hidden rounded-xl shadow-sm border border-[#181715]/10"
                        style={{ clipPath: IMAGE_REVEAL_HIDDEN }}
                      >
                        <img
                          src={item.img}
                          alt={item.imgAlt}
                          loading="lazy"
                          className="proc-image-media aspect-[4/3] w-full object-cover"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* MOBILE & TABLET VIEW (< 1024px: Static Clean Touch Layout)                 */}
      {/* ========================================================================= */}
      <div className="relative block lg:hidden px-4 sm:px-6 pt-20 pb-14 bg-[#ded8ce] text-[#181715]">
        {/* Mobile Header Banner */}
        <div className="mb-8 rounded-2xl bg-[#0c141f] p-5 sm:p-7 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#d1ab76]">
            How To Apply
          </p>
          <h2 className="mt-2 font-serif text-2xl sm:text-3xl font-bold leading-tight text-white">
            A transparent process, end to end.
          </h2>
          <p className="mt-2.5 text-xs sm:text-sm leading-relaxed text-white/80">
            Simple steps. Clear checks. Faster decisions. Smarter support. From
            application to grant, we&apos;ve made it seamless.
          </p>
        </div>

        {/* Mobile Steps Timeline (Clean static flow, no hidden clipPath) */}
        <div className="relative max-w-xl mx-auto">
          <div className="relative flex flex-col gap-6 pl-4 border-l-2 border-dashed border-[#181715]/20 ml-4">
            {steps.map((item) => (
              <div key={`mob-${item.step}`} className="relative pl-4">
                {/* Step Icon Badge */}
                <div className="absolute -left-[30px] top-0 flex size-9 items-center justify-center rounded-full border border-[#181715]/20 bg-[#e6e1d8] text-[#181715] shadow-xs">
                  <item.Icon className="size-4 stroke-[1.5]" />
                </div>

                {/* Step Content & Image */}
                <div className="rounded-2xl bg-white/70 p-4 border border-[#181715]/10 shadow-sm space-y-3">
                  <div>
                    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#a47b46]">
                      {item.step}
                    </span>
                    <h3 className="mt-0.5 font-serif text-base sm:text-lg font-bold tracking-tight text-[#181715]">
                      {item.title}
                    </h3>
                    <p className="mt-1 text-xs sm:text-[13px] leading-relaxed text-[#181715]/75">
                      {item.desc}
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-xl border border-[#181715]/10 aspect-[16/9] w-full">
                    <img
                      src={item.img}
                      alt={item.imgAlt}
                      loading="lazy"
                      className="size-full object-cover"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

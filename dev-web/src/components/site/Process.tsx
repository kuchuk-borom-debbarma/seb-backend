import { useEffect, useRef } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import {
  Laptop,
  ClipboardCheck,
  Landmark,
  BadgeCheck,
  ArrowDown,
  ArrowRight,
  ShieldCheck,
  Zap,
  CheckCircle2,
} from 'lucide-react'

interface StepItem {
  step: string
  title: string
  desc: string
  Icon: React.ElementType
}

const steps: StepItem[] = [
  {
    step: 'STEP 01',
    title: 'Apply Online',
    desc: 'Submit your basic profile and Detailed Project Report (DPR) through the single-window portal.',
    Icon: Laptop,
  },
  {
    step: 'STEP 02',
    title: 'Desk Review',
    desc: 'Department of Industries validates KYC, ST certificate identity, and DPR feasibility.',
    Icon: ClipboardCheck,
  },
  {
    step: 'STEP 03',
    title: 'Bank Evaluation',
    desc: 'Partner commercial and regional rural banks conduct fast-track credit appraisal.',
    Icon: Landmark,
  },
  {
    step: 'STEP 04',
    title: 'Sanction & Release',
    desc: 'TTM issues formal seed grant sanction and releases milestone funding directly to your account.',
    Icon: BadgeCheck,
  },
]

const keyHighlights = [
  {
    icon: Zap,
    title: '100% Digital Single-Window',
    desc: 'Submit DPR & documents from any block across Tripura without visiting physical offices.',
  },
  {
    icon: ShieldCheck,
    title: 'Transparent Milestone Tracking',
    desc: 'Stage-by-stage status updates and direct feedback at each verification level.',
  },
  {
    icon: CheckCircle2,
    title: 'Milestone DBT Transfers',
    desc: 'Sanctioned grants disbursed directly to your verified business bank account.',
  },
]

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

        if (iconNode) gsap.set(iconNode, { opacity: 0, scale: 0.75 })
        if (textNode) gsap.set(textNode, { opacity: 0, y: 18 })
      })

      const tl = gsap.timeline({
        defaults: { ease: 'none' },
        scrollTrigger: {
          trigger: desktopStageRef.current,
          start: 'top top',
          end: () => `+=${window.innerHeight * (steps.length * 0.75)}`,
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

        const at = index * 0.95

        if (iconNode) {
          tl.to(iconNode, { opacity: 1, scale: 1, duration: 0.35 }, at)
        }

        if (textNode) {
          tl.to(textNode, { opacity: 1, y: 0, duration: 0.38 }, at + 0.05)
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
        {/* Left Column (Dark Slate Background with Highlights & CTAs - Pure Text & Icons) */}
        <div className="relative flex w-[46%] flex-col justify-between p-8 xl:p-12 2xl:p-14 text-white z-10">
          <div className="absolute inset-0 z-0 bg-[#0c141f]" />

          {/* Top: Section Title & Intro */}
          <div className="relative z-10">
            <p className="text-xs xl:text-sm font-semibold uppercase tracking-[0.24em] text-[#d1ab76]">
              How To Apply
            </p>
            <h2 className="mt-3 font-serif text-3xl xl:text-4xl 2xl:text-[2.75rem] font-bold leading-[1.12] text-white">
              A transparent process,
              <br />
              end to end.
            </h2>
            <p className="mt-3 text-xs xl:text-sm leading-relaxed text-white/80 max-w-md">
              Simple steps. Clear checks. Faster decisions. Smarter support. From
              application to grant, we&apos;ve made it seamless.
            </p>
          </div>

          {/* Middle: Feature Highlights - Pure Text and Icons (No Cards) */}
          <div className="relative z-10 my-5 space-y-4 xl:space-y-5 max-w-md">
            {keyHighlights.map((item) => (
              <div key={item.title} className="flex items-start gap-3.5">
                <item.icon className="size-5 xl:size-5.5 text-[#d1ab76] shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-[14px] xl:text-[15px] font-semibold text-white leading-snug">
                    {item.title}
                  </h4>
                  <p className="mt-0.5 text-[12px] xl:text-[13px] leading-relaxed text-white/75">
                    {item.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Bottom: Action link & Scroll hint */}
          <div className="relative z-10 flex flex-col gap-3.5 pt-2 border-t border-white/10">
            <div className="flex items-center gap-3">
              <a
                href="/login"
                className="inline-flex items-center gap-2 rounded-xl bg-[#1d4ed8] px-4.5 py-2.5 text-xs xl:text-sm font-bold text-white shadow-sm transition-all hover:bg-[#2563eb] hover:gap-2.5 cursor-pointer"
              >
                <span className="text-white">Proceed to Apply</span>
                <ArrowRight className="size-3.5 xl:size-4 stroke-[2.2] text-white" />
              </a>

              <a
                href="/policy.pdf"
                download="TTAADC_Mission_SEP_Policy_and_Application_Form.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-white/5 px-3.5 py-2.5 text-xs xl:text-sm font-medium text-white transition-colors hover:bg-white/10 hover:text-white"
              >
                <span className="text-white">DPR Guidelines</span>
              </a>
            </div>

            <div className="flex items-center gap-2 text-[11px] xl:text-xs text-white/60">
              <div className="flex size-5 items-center justify-center rounded-full bg-white/10">
                <ArrowDown className="size-3 text-white/80" />
              </div>
              <span className="text-white/60">
                Scroll to explore application milestones
              </span>
            </div>
          </div>
        </div>

        {/* Right Column (Beige Stage with Steps Timeline - Pure Text & Icons) */}
        <div className="relative flex w-[54%] flex-col justify-center bg-[#ded8ce] p-8 xl:p-12 2xl:p-16">
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
                <div key={`dt-${item.title}`} className="proc-desktop-item relative">
                  <div className="flex items-start gap-4 xl:gap-5">
                    <div className="proc-icon-badge relative z-10 flex size-11 xl:size-12 shrink-0 items-center justify-center rounded-full border border-[#181715]/25 bg-[#ded8ce] text-[#181715] shadow-xs mt-0.5">
                      <item.Icon className="size-5 xl:size-5.5 stroke-[1.5]" />
                    </div>

                    <div className="proc-text-block min-w-0 flex-1">
                      <h3 className="font-serif text-lg xl:text-xl font-bold tracking-tight text-[#181715]">
                        {item.title}
                      </h3>
                      <p className="mt-1 text-[13px] xl:text-[14px] leading-relaxed text-[#181715]/75">
                        {item.desc}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* MOBILE & TABLET VIEW (< 1024px: Static Clean Touch Layout - Pure Text & Icons) */}
      {/* ========================================================================= */}
      <div className="relative block lg:hidden px-4 sm:px-6 pt-20 pb-14 bg-[#ded8ce] text-[#181715]">
        {/* Mobile Header Banner */}
        <div className="mb-8 rounded-2xl bg-[#0c141f] p-5 sm:p-7 text-white space-y-4">
          <div>
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

          {/* Mobile Highlights */}
          <div className="space-y-2 pt-2 border-t border-white/10">
            {keyHighlights.map((item) => (
              <div
                key={item.title}
                className="flex items-center gap-2.5 text-xs text-white/90"
              >
                <item.icon className="size-3.5 text-[#d1ab76] shrink-0" />
                <span className="font-medium">{item.title}</span>
              </div>
            ))}
          </div>

          <div className="pt-2">
            <a
              href="/login"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#1d4ed8] py-2.5 px-4 text-xs font-bold text-white shadow-sm active:bg-[#2563eb]"
            >
              <span className="text-white">Proceed to Application</span>
              <ArrowRight className="size-3.5 stroke-[2.2] text-white" />
            </a>
          </div>
        </div>

        {/* Mobile Steps Timeline (Clean static flow, no cards) */}
        <div className="relative max-w-xl mx-auto">
          <div className="relative flex flex-col gap-6 pl-4 border-l-2 border-dashed border-[#181715]/20 ml-4">
            {steps.map((item) => (
              <div key={`mob-${item.title}`} className="relative pl-4">
                {/* Step Icon Badge */}
                <div className="absolute -left-[30px] top-0 flex size-9 items-center justify-center rounded-full border border-[#181715]/20 bg-[#e6e1d8] text-[#181715] shadow-xs">
                  <item.Icon className="size-4 stroke-[1.5]" />
                </div>

                {/* Step Content */}
                <div className="py-1">
                  <h3 className="font-serif text-base sm:text-lg font-bold tracking-tight text-[#181715]">
                    {item.title}
                  </h3>
                  <p className="mt-1 text-xs sm:text-[13px] leading-relaxed text-[#181715]/75">
                    {item.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

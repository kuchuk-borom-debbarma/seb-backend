import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Download,
  FileText,
  HelpCircle,
  Landmark,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react'
import heroImage from '@/assets/hero-landscape.jpg'
import imgTwo from '@/assets/two.png'

// Custom Sprout In Hand Icon
function SproutHandIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M24 24V11" />
      <path d="M24 16C24 10 19 8 16 9C16 14 19 16 24 16Z" />
      <path d="M24 19C27 14 32 13 34 15C34 19 29 20 24 20" />
      <path d="M13 34C13 34 17 36 23 36C29 36 34 33 37 30L41 26C42 25 41 23 39 23L33 25C30 26 28 26 25 26L21 27" />
      <path d="M13 34L9 31C8 30 8 28 9 27L15 25" />
    </svg>
  )
}

// Custom Hand Holding Seedling Icon for Hero notification panel
function HandSeedlingIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M32 36V18" />
      <path d="M32 23C32 16 26 12 21 13C21 19 25 23 32 23Z" />
      <path d="M32 28C35 22 41 21 44 24C44 29 37 30 32 30" />
      <path d="M26 36C28 35 36 35 38 36" />
      <path d="M16 46C16 46 20 49 28 49C36 49 42 45 46 41L51 36C52 34.5 50.5 32.5 48 32.5L40 35C36 36.5 33 36.5 29 36.5L24 38" />
      <path d="M16 46L11 42C9.5 41 9.5 38.5 11 37.5L19 35" />
    </svg>
  )
}

interface NotificationItem {
  id: string
  tag: string
  date: string
  title: string
  summary: string
  link: string
  isExternal?: boolean
  Icon: React.ElementType
}

const notifications: NotificationItem[] = [
  {
    id: 'notif-1',
    tag: 'Notice',
    date: 'Aug 2026',
    title: 'Mission SEP 2026 Phase-1 Applications Open',
    summary:
      'Online registration is active for tribal entrepreneurs seeking seed funding up to ₹5 Lakhs.',
    link: '/login',
    Icon: HandSeedlingIcon,
  },
  {
    id: 'notif-2',
    tag: 'Guidelines',
    date: 'Official',
    title: 'DPR Preparation Manual & Template Released',
    summary:
      'Standard template and guidelines under Section 6 are available for download.',
    link: '/policy.pdf',
    isExternal: true,
    Icon: FileText,
  },
  {
    id: 'notif-3',
    tag: 'Circular',
    date: 'Advisory',
    title: 'Tripura ST Certificate Verification Checklist',
    summary:
      'Ensure ST Certificate and local Village Committee NOC are verified for priority processing.',
    link: '/#eligibility',
    Icon: ShieldCheck,
  },
  {
    id: 'notif-4',
    tag: 'Banking',
    date: 'Credit',
    title: 'Partner Bank Linkages for Category A & B Units',
    summary:
      'Credit assistance & margin money subsidies formalized with regional lead banks.',
    link: '/#how-it-works',
    Icon: Landmark,
  },
  {
    id: 'notif-5',
    tag: 'Helpdesk',
    date: 'Advisory',
    title: 'Eligibility & Grant Scrutiny FAQs Updated',
    summary:
      'Detailed answers on applicant age limits (18–60 yrs) and milestone seed disbursements.',
    link: '/faq',
    Icon: HelpCircle,
  },
]

const HEADLINES = [
  { line1: 'EMPOWERING', line2: 'BUSINESSES.' },
  { line1: 'BEPARI ROKNO', line2: 'PHANRAKRIMA.' },
]

interface GoalCard {
  number: string
  title: string
  desc: string
  Icon: React.ElementType
}

const goalCards: GoalCard[] = [
  {
    number: '01',
    title: 'Indigenous Capital Access',
    desc: 'Overcome institutional credit barriers for indigenous Scheduled Tribe (ST) entrepreneurs by providing direct seed capital and structured bank linkages.',
    Icon: SproutHandIcon,
  },
  {
    number: '02',
    title: 'Micro-Enterprise Modernization',
    desc: 'Assist early-stage ventures in transitioning from informal operations to registered, compliant business units.',
    Icon: TrendingUp,
  },
  {
    number: '03',
    title: 'Scaled Industrial Growth',
    desc: 'Encourage existing local enterprises to expand product lines, modernise technology, and increase regional employment in TTAADC areas.',
    Icon: Users,
  },
]

export function Hero() {
  const rootRef = useRef<HTMLDivElement>(null)
  const isFirstRender = useRef(true)
  const [headlineIndex, setHeadlineIndex] = useState(0)
  const [notifIndex, setNotifIndex] = useState(0)
  const activeNotif = notifications[notifIndex] ?? notifications[0]!

  // Auto-advance notifications carousel every 5.5 seconds
  useEffect(() => {
    const notifTimer = setInterval(() => {
      setNotifIndex((prev) => (prev + 1) % notifications.length)
    }, 5500)
    return () => clearInterval(notifTimer)
  }, [])

  // Desktop Pinned GSAP Scrub (Scoped strictly to >= 1024px)
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger)
    const root = rootRef.current
    if (!root) return

    const mm = gsap.matchMedia()

    mm.add('(min-width: 1024px)', () => {
      // 1. Initial Hero load animation
      const initTl = gsap.timeline({ defaults: { ease: 'power3.out' } })
      initTl
        .from('.hero-line-desktop', {
          yPercent: 100,
          opacity: 0,
          duration: 0.9,
          stagger: 0.12,
        })
        .from('.hero-sub-desktop', { y: 20, opacity: 0, duration: 0.7 }, '-=0.5')
        .from('.hero-panel-desktop', { y: 40, opacity: 0, duration: 0.8 }, '-=0.4')
        .from(
          '.hero-aside-desktop',
          { opacity: 0, y: 15, duration: 0.7, stagger: 0.1 },
          '-=0.5',
        )

      // 2. ScrollTrigger Pinned Scrub Timeline
      const scrubTl = gsap.timeline({
        scrollTrigger: {
          trigger: root,
          start: 'top top',
          end: () => `+=${window.innerHeight * 1.3}`,
          pin: true,
          scrub: 1.1,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      })

      scrubTl.to(
        '.desktop-hero-view',
        {
          opacity: 0,
          y: -40,
          duration: 0.45,
          ease: 'power2.inOut',
          pointerEvents: 'none',
        },
        0,
      )

      scrubTl.fromTo(
        '.desktop-goals-headline',
        { opacity: 0, y: 30, pointerEvents: 'none' },
        { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', pointerEvents: 'auto' },
        0.2,
      )

      scrubTl.fromTo(
        '.desktop-goals-cards',
        { opacity: 0, y: '65vh', pointerEvents: 'none' },
        { opacity: 1, y: 0, duration: 0.75, ease: 'power2.out', pointerEvents: 'auto' },
        0.2,
      )

      scrubTl.to({}, { duration: 0.45 })
    })

    return () => mm.revert()
  }, [])

  // Cycle headlines smoothly
  useEffect(() => {
    const interval = setInterval(() => {
      gsap.to('.hero-line-anim', {
        yPercent: -100,
        opacity: 0,
        duration: 0.55,
        stagger: 0.08,
        ease: 'power2.in',
        onComplete: () => {
          setHeadlineIndex((prev) => (prev + 1) % HEADLINES.length)
        },
      })
    }, 4200)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }

    gsap.fromTo(
      '.hero-line-anim',
      { yPercent: 100, opacity: 0 },
      { yPercent: 0, opacity: 1, duration: 0.75, stagger: 0.08, ease: 'power3.out' },
    )
  }, [headlineIndex])

  const moveNotif = (e: React.MouseEvent, dir: number) => {
    e.preventDefault()
    e.stopPropagation()
    setNotifIndex((i) => (i + dir + notifications.length) % notifications.length)
  }

  const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (href.startsWith('/#') || href.startsWith('#')) {
      const targetId = href.replace('/#', '').replace('#', '')
      const targetEl = document.getElementById(targetId)
      if (targetEl) {
        e.preventDefault()
        targetEl.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }

  return (
    <>
      {/* ========================================================================= */}
      {/* 1. DESKTOP HERO & GOALS VIEW (Pinned GSAP Scrub for >= 1024px)             */}
      {/* ========================================================================= */}
      <section
        id="top"
        ref={rootRef}
        className="relative hidden lg:block min-h-[720px] h-[100svh] w-full overflow-hidden bg-slate-900"
      >
        <div id="goals" className="absolute top-[45%] pointer-events-none" />

        {/* Static Background Image */}
        <div className="absolute inset-0 z-0 pointer-events-none">
          <img
            src={heroImage}
            alt="TTAADC Main Administrative Building at Tangnok Kotor, Khumulwng"
            width={4032}
            height={2268}
            className="size-full object-cover object-[center_35%] brightness-[0.98] contrast-[1.04]"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-slate-950/75 via-slate-900/35 to-transparent pointer-events-none" />
          <div className="absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-slate-950/60 via-slate-950/20 to-transparent pointer-events-none" />
          <div className="absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-slate-950/50 to-transparent pointer-events-none" />
        </div>

        {/* Desktop Hero View */}
        <div className="desktop-hero-view hero-main-content absolute inset-0 z-20 mx-auto flex h-full max-w-[1500px] flex-col justify-start px-10 pt-32 lg:pt-36 pointer-events-auto">
          <h1 className="font-display tracking-tight text-white uppercase leading-[0.88] select-none min-h-[11rem] lg:min-h-[13.5rem]">
            <span className="block overflow-hidden">
              <span className="hero-line-desktop hero-line-anim block text-[clamp(4rem,9.2vw,9rem)]">
                {HEADLINES[headlineIndex]!.line1}
              </span>
            </span>
            <span className="block overflow-hidden">
              <span className="hero-line-desktop hero-line-anim block text-[clamp(4rem,9.2vw,9rem)]">
                {HEADLINES[headlineIndex]!.line2}
              </span>
            </span>
          </h1>

          <p className="hero-sub-desktop mt-6 max-w-md text-[17px] font-normal leading-relaxed text-white/95 drop-shadow-sm">
            Sustainable Entrepreneurship and
            <br />
            Business Programme (TTAADC 2026)
          </p>

          {/* Desktop Right Aside */}
          <div className="hero-aside-desktop absolute bottom-8 right-10 flex flex-col items-end gap-3.5 z-10">
            <p className="max-w-xs text-right text-[15px] font-normal leading-snug text-white/95 drop-shadow-sm">
              Single-window digital platform for enterprise
              <br />
              assistance and application tracking.
            </p>
            <div className="flex gap-3 pt-1">
              <div className="size-18 overflow-hidden rounded-full border-2 border-white bg-white/95 shadow-xl transition-transform hover:scale-105">
                <img
                  src={imgTwo}
                  alt="Tripuri innovators and master artisans"
                  loading="lazy"
                  className="size-full object-contain object-top pt-1 scale-110"
                />
              </div>
            </div>
          </div>

          {/* Bottom Left Notifications Card */}
          <div className="hero-panel-desktop absolute bottom-0 left-0 z-30 w-full bg-[#ded8ce] px-8 py-5 md:w-[48%] md:min-w-[530px] md:max-w-[600px] shadow-2xl border-t border-r border-[#181715]/20 pointer-events-auto">
            <div className="flex items-center gap-5 md:gap-6">
              <div className="flex size-18 shrink-0 items-center justify-center rounded-full border border-[#181715]/25 text-[#181715] bg-[#e6e1d8]">
                <activeNotif.Icon className="size-9 text-[#181715]" strokeWidth={1.75} />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold tracking-wider uppercase text-[#0c2340] bg-[#181715]/8 px-1.5 py-0.5 rounded-xs">
                    {activeNotif.tag}
                  </span>
                  <span className="text-[11px] font-medium text-[#181715]/60">
                    {activeNotif.date}
                  </span>
                  <span className="text-[10.5px] font-medium text-[#181715]/50 ml-auto">
                    {notifIndex + 1} of {notifications.length}
                  </span>
                </div>

                <a
                  href={activeNotif.link}
                  onClick={(e) => handleLinkClick(e, activeNotif.link)}
                  {...(activeNotif.isExternal
                    ? { target: '_blank', rel: 'noopener noreferrer' }
                    : {})}
                  className="group mt-1 flex items-baseline gap-1 text-[14.5px] font-bold leading-snug text-[#181715] hover:text-[#0c2340] transition-colors cursor-pointer"
                >
                  <span className="underline decoration-[#181715]/30 underline-offset-2 group-hover:decoration-[#0c2340]">
                    {activeNotif.title}
                  </span>
                  <ArrowUpRight className="inline-block size-3.5 shrink-0 opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                </a>

                <p className="mt-0.5 text-[12px] leading-snug text-[#181715]/75 line-clamp-1">
                  {activeNotif.summary}
                </p>
              </div>

              <div className="flex shrink-0 gap-2 self-end pb-0.5">
                <button
                  type="button"
                  onClick={(e) => moveNotif(e, -1)}
                  aria-label="Previous notification"
                  className="grid size-9.5 place-items-center rounded-full border border-[#181715]/40 text-[#181715] transition-colors hover:bg-[#181715] hover:text-[#ded8ce] cursor-pointer"
                >
                  <ArrowLeft className="size-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={(e) => moveNotif(e, 1)}
                  aria-label="Next notification"
                  className="grid size-9.5 place-items-center rounded-full border border-[#181715]/40 text-[#181715] transition-colors hover:bg-[#181715] hover:text-[#ded8ce] cursor-pointer"
                >
                  <ArrowRight className="size-4" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Desktop Goals View Layer */}
        <div className="goals-view-layer absolute inset-0 z-20 pointer-events-none mx-auto flex h-full max-w-[1500px] flex-col justify-between px-10 pt-28 pb-6">
          <div
            className="desktop-goals-headline max-w-xl pointer-events-none"
            style={{ opacity: 0 }}
          >
            <p className="text-sm font-medium tracking-wide text-white/80">
              PREAMBLE &amp; POLICY OBJECTIVES
            </p>
            <h2 className="mt-1.5 text-4xl lg:text-[3.25rem] font-bold tracking-tight text-white leading-[1.08]">
              Core Objectives
            </h2>
            <p className="mt-3 text-base leading-relaxed text-white/90 font-light max-w-md">
              The Industry Department, Tripura Tribal Areas Autonomous District Council
              (TTAADC), introduces Mission SEP (Sustainable Entrepreneurship and Business
              Programme).
            </p>
          </div>

          <div
            className="desktop-goals-cards w-full pointer-events-none mt-auto"
            style={{ opacity: 0, transform: 'translateY(65vh)' }}
          >
            <div className="grid gap-3.5 sm:grid-cols-3">
              {goalCards.map((card) => (
                <div
                  key={card.title}
                  className="goals-item-card group flex flex-col justify-between rounded-2xl border border-black/5 bg-white p-6 shadow-xl transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl"
                >
                  <div>
                    <div className="flex items-center justify-between">
                      <div className="flex size-11 items-center justify-center rounded-xl bg-[#f1f4f8] text-[#0c2340]">
                        <card.Icon className="size-6 stroke-[1.8]" />
                      </div>
                    </div>
                    <div className="mt-4">
                      <h3 className="text-[17px] font-bold tracking-tight text-[#181715] leading-snug">
                        {card.title}
                      </h3>
                      <p className="mt-2 text-[13px] leading-relaxed text-[#181715]/80">
                        {card.desc}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3.5 rounded-2xl border border-[#181715]/10 bg-[#f4efe6] px-5 py-3.5 flex items-center justify-between gap-3 shadow-md">
              <div className="flex items-center gap-3.5 max-w-3xl">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[#181715]/12 bg-white text-[#181715] shadow-2xs">
                  <Landmark className="size-5 stroke-[1.8]" />
                </div>
                <div>
                  <h4 className="text-[14.5px] font-bold text-[#181715] leading-tight">
                    Governance &amp; Sanctioning Authority
                  </h4>
                  <p className="mt-0.5 text-[12px] leading-snug text-[#181715]/75">
                    Decision making and final sanctioning under Mission SEP shall be
                    governed by the TTAADC Transformation Mission (TTM) along with
                    concerned representatives from the Industry Department, TTAADC.
                  </p>
                </div>
              </div>

              <a
                href="/policy.pdf"
                download="TTAADC_Mission_SEP_Policy_and_Application_Form.pdf"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-[#0c2340] px-5 py-2.5 text-[13px] font-semibold text-white shadow-sm transition-all duration-300 hover:bg-[#1d4ed8] hover:gap-2.5 shrink-0 whitespace-nowrap"
              >
                <Download className="size-3.5 text-white" />
                <span className="text-white">Download Policy PDF</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ========================================================================= */}
      {/* 2. MOBILE & TABLET VIEW (< 1024px: Full Screen 100svh Top-to-Bottom Hero)  */}
      {/* ========================================================================= */}
      <div className="block lg:hidden w-full">
        {/* Mobile Full-Screen Hero Block (100svh) */}
        <section
          id="top"
          className="relative h-[100svh] min-h-[580px] w-full overflow-hidden bg-slate-900 flex flex-col justify-between select-none"
        >
          {/* Background Image expanding full height */}
          <div className="absolute inset-0 z-0 pointer-events-none">
            <img
              src={heroImage}
              alt="TTAADC Main Administrative Building at Tangnok Kotor, Khumulwng"
              width={4032}
              height={2268}
              className="size-full object-cover object-[center_35%] brightness-[0.92] contrast-[1.05]"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/95 via-slate-900/40 to-slate-950/70 pointer-events-none" />
            <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-slate-950/80 via-slate-950/30 to-transparent pointer-events-none" />
          </div>

          {/* Top Content: Headline & Subtitle */}
          <div className="relative z-10 px-5 pt-20 sm:pt-24 md:px-8">
            <h1 className="font-display tracking-tight text-white uppercase leading-[0.9] select-none text-[clamp(2.6rem,11.5vw,4.8rem)] min-h-[5.5rem] sm:min-h-[7.5rem]">
              <span className="block overflow-hidden">
                <span className="hero-line-anim block">
                  {HEADLINES[headlineIndex]!.line1}
                </span>
              </span>
              <span className="block overflow-hidden">
                <span className="hero-line-anim block">
                  {HEADLINES[headlineIndex]!.line2}
                </span>
              </span>
            </h1>

            <p className="mt-3 text-[13.5px] sm:text-base font-normal leading-snug text-white/90 drop-shadow-sm max-w-sm">
              Sustainable Entrepreneurship and
              <br />
              Business Programme (TTAADC 2026)
            </p>
          </div>

          {/* Bottom Docked Notifications Panel (Flush with screen bottom, matching desktop dock styling) */}
          <div className="relative z-20 w-full bg-[#ded8ce] px-4.5 py-4 sm:px-6 sm:py-4.5 border-t border-[#181715]/20 shadow-2xl pointer-events-auto">
            <div className="flex items-center gap-3 sm:gap-4">
              {/* Left Circle Icon */}
              <div className="flex size-12 sm:size-13 shrink-0 items-center justify-center rounded-full border border-[#181715]/25 text-[#181715] bg-[#e6e1d8]">
                <activeNotif.Icon
                  className="size-6 sm:size-6.5 text-[#181715]"
                  strokeWidth={1.75}
                />
              </div>

              {/* Middle Notification Info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[9.5px] sm:text-[10px] font-bold tracking-wider uppercase text-[#0c2340] bg-[#181715]/8 px-1.5 py-0.5 rounded-xs">
                    {activeNotif.tag}
                  </span>
                  <span className="text-[10px] font-medium text-[#181715]/60">
                    {activeNotif.date}
                  </span>
                  <span className="text-[10px] font-medium text-[#181715]/50 ml-auto">
                    {notifIndex + 1} of {notifications.length}
                  </span>
                </div>

                <a
                  href={activeNotif.link}
                  onClick={(e) => handleLinkClick(e, activeNotif.link)}
                  {...(activeNotif.isExternal
                    ? { target: '_blank', rel: 'noopener noreferrer' }
                    : {})}
                  className="group mt-0.5 flex items-start gap-1 text-[13px] sm:text-[14px] font-bold leading-snug text-[#181715] hover:text-[#0c2340] transition-colors cursor-pointer"
                >
                  <span className="underline decoration-[#181715]/30 underline-offset-2">
                    {activeNotif.title}
                  </span>
                  <ArrowUpRight className="inline-block size-3.5 shrink-0 opacity-70" />
                </a>

                <p className="mt-0.5 text-[11px] sm:text-[11.5px] leading-snug text-[#181715]/75 line-clamp-1">
                  {activeNotif.summary}
                </p>
              </div>
            </div>

            {/* Bottom Controls Row */}
            <div className="mt-2.5 flex items-center justify-between border-t border-[#181715]/10 pt-2">
              <div className="flex gap-1.5">
                {notifications.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setNotifIndex(i)}
                    aria-label={`Slide ${i + 1}`}
                    className={`h-1.5 rounded-xs transition-all ${
                      notifIndex === i ? 'w-6 bg-[#0c2340]' : 'w-2.5 bg-[#181715]/25'
                    }`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => moveNotif(e, -1)}
                  aria-label="Previous notification"
                  className="flex size-8.5 items-center justify-center rounded-full border border-[#181715]/30 bg-white/80 text-[#181715] active:bg-[#181715] active:text-[#ded8ce] cursor-pointer shadow-2xs"
                >
                  <ArrowLeft className="size-3.5 text-[#181715]" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  onClick={(e) => moveNotif(e, 1)}
                  aria-label="Next notification"
                  className="flex size-8.5 items-center justify-center rounded-full border border-[#181715]/30 bg-white/80 text-[#181715] active:bg-[#181715] active:text-[#ded8ce] cursor-pointer shadow-2xs"
                >
                  <ArrowRight className="size-3.5 text-[#181715]" strokeWidth={1.75} />
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Mobile Goals Section (Smoothly follows as user scrolls down) */}
        <section
          id="goals"
          className="relative bg-[#0c1829] px-4 sm:px-6 py-12 text-white border-t border-white/10"
        >
          <div>
            <p className="text-xs font-semibold tracking-wider text-white/70 uppercase">
              Preamble &amp; Policy Objectives
            </p>
            <h2 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Core Objectives
            </h2>
            <p className="mt-2 text-xs sm:text-sm text-white/80 font-light leading-relaxed">
              Mission SEP introduces direct seed capital &amp; structured bank linkages
              for tribal entrepreneurs.
            </p>
          </div>

          {/* Horizontal Touch-Snap Swiper for Goal Cards */}
          <div className="mt-6 -mx-4 px-4 sm:-mx-6 sm:px-6 flex gap-3.5 overflow-x-auto snap-x snap-mandatory pb-3 scrollbar-none touch-pan-x">
            {goalCards.map((card) => (
              <div
                key={card.title}
                className="w-[84vw] sm:w-[320px] shrink-0 snap-center flex flex-col justify-between rounded-2xl border border-black/5 bg-white p-5 shadow-xl text-[#181715]"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex size-9.5 items-center justify-center rounded-xl bg-[#f1f4f8] text-[#0c2340]">
                      <card.Icon className="size-5.5 stroke-[1.8]" />
                    </div>
                  </div>
                  <div className="mt-3.5">
                    <h3 className="text-[15.5px] font-bold tracking-tight text-[#181715] leading-snug">
                      {card.title}
                    </h3>
                    <p className="mt-2 text-[12px] sm:text-[12.5px] leading-relaxed text-[#181715]/80">
                      {card.desc}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Touch Swipe Hint */}
          <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] text-white/50">
            <span>Swipe for more objectives &rarr;</span>
          </div>

          {/* Mobile Governance Banner */}
          <div className="mt-6 rounded-2xl border border-white/15 bg-white/10 p-4 sm:p-5 text-white backdrop-blur-xs space-y-3">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white">
                <Landmark className="size-4.5 stroke-[1.8]" />
              </div>
              <div>
                <h4 className="text-[13.5px] font-bold text-white leading-tight">
                  Governance &amp; Sanctioning Authority
                </h4>
                <p className="mt-1 text-[11.5px] leading-relaxed text-white/80">
                  Governed by the TTAADC Transformation Mission (TTM) and the Industry
                  Department, TTAADC.
                </p>
              </div>
            </div>

            <a
              href="/policy.pdf"
              download="TTAADC_Mission_SEP_Policy_and_Application_Form.pdf"
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-white py-2.5 px-4 text-xs font-bold text-[#0c2340] shadow-sm active:bg-white/90 transition-colors"
            >
              <Download className="size-3.5 text-[#0c2340]" />
              <span className="text-[#0c2340]">Download Policy PDF</span>
            </a>
          </div>
        </section>
      </div>
    </>
  )
}

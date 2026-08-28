import { useEffect, useRef, useState } from 'react'
import { CalendarPlus, Menu, X, ArrowRight } from 'lucide-react'
import { Logo } from './Logo'

const links = [
  { label: 'Home', href: '/#top' },
  { label: 'Goals', href: '/#goals' },
  { label: 'Eligibility', href: '/#eligibility' },
  { label: 'About SEP', href: '/#about' },
  { label: 'How It Works', href: '/#how-it-works' },
  { label: 'FAQs', href: '/faq' },
]

interface SectionStyle {
  bg: string
  isLight: boolean
  border?: string
}

const SECTION_STYLES: Record<string, SectionStyle> = {
  top: { bg: '#0f172a', isLight: false },
  goals: { bg: '#0c1829', isLight: false, border: 'rgba(255, 255, 255, 0.08)' },
  eligibility: { bg: '#faf9f6', isLight: true, border: 'rgba(0, 0, 0, 0.06)' },
  about: { bg: '#ded8ce', isLight: true, border: 'rgba(24, 23, 21, 0.08)' },
  project: { bg: '#ffffff', isLight: true, border: 'rgba(0, 0, 0, 0.06)' },
  'how-it-works': { bg: '#0c141f', isLight: false, border: 'rgba(255, 255, 255, 0.08)' },
  contact: { bg: '#ffffff', isLight: true, border: 'rgba(0, 0, 0, 0.06)' },
}

export function Header() {
  const [activeSection, setActiveSection] = useState('top')
  const [solid, setSolid] = useState(false)
  const [scrollingDown, setScrollingDown] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const lastScrollY = useRef(0)

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [mobileMenuOpen])

  useEffect(() => {
    const sectionIds = [
      'top',
      'goals',
      'eligibility',
      'about',
      'project',
      'how-it-works',
      'contact',
    ]

    lastScrollY.current = window.scrollY

    const onScroll = () => {
      const currentScrollY = window.scrollY

      // Solid background when scrolled past top threshold
      setSolid(currentScrollY > 80)

      // Scroll-direction detection: shrink on scroll down, expand on scroll up
      if (currentScrollY > 100) {
        if (currentScrollY > lastScrollY.current + 5) {
          setScrollingDown(true)
        } else if (currentScrollY < lastScrollY.current - 5) {
          setScrollingDown(false)
        }
      } else {
        setScrollingDown(false)
      }

      lastScrollY.current = currentScrollY

      // Active section detection
      const headerY = 80
      for (const id of sectionIds) {
        const el = document.getElementById(id)
        if (el) {
          const rect = el.getBoundingClientRect()
          if (rect.top <= headerY && rect.bottom > headerY) {
            setActiveSection(id)
            break
          }
        }
      }
    }

    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [])

  const handleMobileNavClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    setMobileMenuOpen(false)
    if (href.startsWith('/#') || href.startsWith('#')) {
      const targetId = href.replace('/#', '').replace('#', '')
      const el = document.getElementById(targetId)
      if (el) {
        e.preventDefault()
        el.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }

  const currentTheme = SECTION_STYLES[activeSection] ?? SECTION_STYLES.top!
  const isHero = activeSection === 'top'
  const isTransparentTop = isHero && !solid

  const backgroundColor = isTransparentTop ? 'transparent' : currentTheme.bg
  const isLight = currentTheme.isLight

  return (
    <>
      <header
        style={{
          backgroundColor,
          borderBottom:
            currentTheme.border && !isTransparentTop
              ? `1px solid ${currentTheme.border}`
              : 'none',
        }}
        className={`fixed inset-x-0 top-0 z-50 transition-all duration-500 ${
          scrollingDown
            ? 'py-1.5 md:py-2 backdrop-blur-md shadow-xs'
            : solid
              ? 'py-3 md:py-3.5 backdrop-blur-sm'
              : 'py-3.5 sm:py-4 md:py-6'
        }`}
      >
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-4 sm:px-6 md:px-10 transition-all duration-500">
          {/* Brand Logo */}
          <a
            href="/#top"
            aria-label="TTAADC SEP home"
            className={`flex items-center transition-transform duration-500 origin-left ${
              scrollingDown ? 'scale-90' : 'scale-100'
            }`}
          >
            <Logo light={!isLight} />
          </a>

          {/* Desktop Horizontal Navigation Menu (>=1024px) */}
          <nav
            className={`hidden items-center transition-all duration-500 lg:flex ${
              scrollingDown
                ? 'gap-5 xl:gap-7 text-[13.5px] xl:text-[14px]'
                : 'gap-6 xl:gap-8 text-[14px] xl:text-[14.5px]'
            }`}
            aria-label="Primary"
          >
            {links.map((l) => (
              <a
                key={l.label}
                href={l.href}
                style={{
                  color: !isLight ? '#ffffff' : '#181715',
                }}
                className={`font-medium tracking-wide transition-colors duration-300 ${
                  !isLight
                    ? 'site-nav-link-dark text-white hover:text-white/80'
                    : 'site-nav-link-light text-[#181715] hover:text-[#181715]/75'
                }`}
              >
                {l.label}
              </a>
            ))}
          </nav>

          {/* Right Action Group */}
          <div className="flex items-center gap-2.5 sm:gap-3.5">
            {/* Apply Now CTA Button (Desktop & Tablet) */}
            <a
              href="/login"
              style={{
                backgroundColor: !isLight ? '#ffffff' : '#181715',
                color: !isLight ? '#152e4d' : '#ffffff',
                textDecoration: 'none',
              }}
              className={`hidden sm:inline-flex items-center font-semibold rounded-full transition-all duration-500 hover:-translate-y-0.5 shadow-sm ${
                scrollingDown
                  ? 'gap-2 px-4 py-1.5 text-[13px]'
                  : 'gap-3 px-5 py-2.5 text-[13.5px] md:text-[14px]'
              } ${
                !isLight
                  ? 'bg-white hover:bg-white/95'
                  : 'bg-[#181715] hover:bg-[#181715]/90'
              }`}
            >
              <span style={{ color: !isLight ? '#152e4d' : '#ffffff' }}>Apply Now</span>
              <CalendarPlus
                className={`transition-all duration-500 ${scrollingDown ? 'size-3.5' : 'size-4'} ${
                  !isLight ? 'text-[#1e5296]' : 'text-white/80'
                }`}
                strokeWidth={1.8}
              />
            </a>

            {/* Mobile / Tablet Menu Trigger (<1024px) */}
            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open navigation menu'}
              className={`lg:hidden flex size-11 items-center justify-center rounded-lg transition-colors cursor-pointer ${
                !isLight
                  ? 'text-white bg-white/10 hover:bg-white/20'
                  : 'text-[#181715] bg-[#181715]/5 hover:bg-[#181715]/10'
              }`}
            >
              {mobileMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* MOBILE / TABLET SLIDE-OVER NAVIGATION DRAWER (<1024px)                    */}
      {/* ========================================================================= */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          {/* Backdrop */}
          <div
            onClick={() => setMobileMenuOpen(false)}
            className="fixed inset-0 bg-slate-950/70 backdrop-blur-sm animate-in fade-in duration-300"
          />

          {/* Drawer Container */}
          <div className="relative ml-auto flex h-full w-full max-w-xs sm:max-w-sm flex-col justify-between bg-[#0f172a] p-6 text-white shadow-2xl animate-in slide-in-from-right duration-300 border-l border-white/10 z-10">
            {/* Drawer Header */}
            <div>
              <div className="flex items-center justify-between border-b border-white/15 pb-4">
                <Logo light={true} />
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="Close navigation"
                  className="flex size-10 items-center justify-center rounded-md bg-white/10 text-white hover:bg-white/20 transition-colors cursor-pointer"
                >
                  <X className="size-5" />
                </button>
              </div>

              {/* Navigation Links with 48px+ touch targets */}
              <nav
                className="mt-6 flex flex-col space-y-1.5"
                aria-label="Mobile Navigation"
              >
                {links.map((l) => (
                  <a
                    key={l.label}
                    href={l.href}
                    onClick={(e) => handleMobileNavClick(e, l.href)}
                    className="flex min-h-[48px] items-center justify-between rounded-lg px-3.5 text-base font-semibold text-white/90 hover:bg-white/10 hover:text-white transition-colors cursor-pointer"
                  >
                    <span>{l.label}</span>
                    <ArrowRight className="size-4 text-white/40" />
                  </a>
                ))}
              </nav>
            </div>

            {/* Drawer Bottom CTA */}
            <div className="pt-6 border-t border-white/15 space-y-3">
              <a
                href="/login"
                onClick={() => setMobileMenuOpen(false)}
                className="flex min-h-[50px] w-full items-center justify-center gap-2.5 rounded-lg bg-white py-3 px-4 text-sm font-bold text-[#0c2340] shadow-md hover:bg-white/95 transition-all"
              >
                <span className="text-[#0c2340]">Apply for Seed Grant</span>
                <CalendarPlus className="size-4 text-[#1e5296]" />
              </a>

              <p className="text-center text-[11px] text-white/60">
                TTAADC Mission SEP 2026 Portal
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

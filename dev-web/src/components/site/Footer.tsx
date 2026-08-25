import { Logo } from './Logo'

const columns = [
  {
    title: 'Mission SEP',
    links: [
      { label: 'Preamble & Mission', href: '/#about' },
      { label: 'Supported Sectors', href: '/#project' },
      { label: 'Ecosystem Pillars', href: '/#about' },
      { label: 'Bank Linkages', href: '/#project' },
    ],
  },
  {
    title: 'Application & DPR',
    links: [
      { label: 'Eligibility Matrix', href: '/#eligibility' },
      { label: 'Selection Process', href: '/#how-it-works' },
      { label: 'DPR Guidelines', href: '/#dpr' },
      { label: 'Apply Online', href: '/login' },
    ],
  },
  {
    title: 'Council & Helpdesk',
    links: [
      { label: 'Industry Department', href: '/#contact' },
      { label: 'TTM Apex Authority', href: '/#contact' },
      { label: 'Frequently Asked', href: '/faq' },
      { label: 'District Map', href: '/#top' },
    ],
  },
]

export function Footer() {
  return (
    <footer className="border-t border-[#e2e8f0] bg-white text-[#15233d]">
      <div className="mx-auto grid max-w-[1500px] gap-12 px-6 py-16 md:grid-cols-12 md:px-10">
        <div className="md:col-span-4">
          <Logo />
          <p className="mt-6 max-w-xs text-[14.5px] leading-relaxed text-[#64748b]">
            Mission Sustainable Entrepreneurship & Business Programme (SEP) — Industry
            Department, Tripura Tribal Areas Autonomous District Council (TTAADC),
            Khumulwng.
          </p>
        </div>
        {columns.map((c) => (
          <div key={c.title} className="md:col-span-2">
            <p className="font-mono text-xs font-bold uppercase tracking-[0.18em] text-[#0c1a30]">
              {c.title}
            </p>
            <ul className="mt-5 space-y-3">
              {c.links.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    className="text-[14px] font-medium text-[#64748b] transition-colors hover:text-[#1d4ed8]"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-[#f1f5f9]">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-2 px-6 py-6 text-[13px] text-[#94a3b8] md:flex-row md:items-center md:justify-between md:px-10">
          <p>
            © 2026 TTAADC · Mission Sustainable Entrepreneurship &amp; Business Programme
            (SEP)
          </p>
          <p>Industry Department, Khumulwng, Tripura</p>
        </div>
      </div>
    </footer>
  )
}

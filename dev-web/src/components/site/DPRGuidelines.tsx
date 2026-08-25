import { FileText, Download, CheckCircle2, ChevronRight } from 'lucide-react'
import { Reveal } from './Reveal'

const dprSections = [
  {
    num: '01',
    title: 'Enterprise Profile & Executive Summary',
    items: [
      'Proposed or existing registered business name & entity structure',
      'Core mission statement and indigenous value proposition',
      'Executive overview of primary product or service offerings',
    ],
  },
  {
    num: '02',
    title: 'Operational & Technical Plan',
    items: [
      'Operational site details and manufacturing/service layout inside TTAADC areas',
      'Machinery, tooling, and specialized equipment inventory with quotations',
      'Local raw material sourcing strategy and supply chain logistics',
    ],
  },
  {
    num: '03',
    title: 'Market Analysis & Commercial Strategy',
    items: [
      'Target demographic, local vs export market scope, and customer persona',
      'Competitive benchmarking against regional and commercial substitutes',
      'Distribution channels, promotional plan, and 3-year sales projections',
    ],
  },
  {
    num: '04',
    title: 'Financial Projections & Costing',
    items: [
      'Comprehensive Project Cost breakdown (Capital Expenditure + Working Capital)',
      '3-Year Projected Income Statement, Cash Flow Statement & Balance Sheet',
      'Break-Even Point (BEP) Analysis and Internal Rate of Return (IRR)',
      'Funding Model: TTAADC Seed Fund + Proposed Bank Credit + Promoter Contribution',
    ],
  },
  {
    num: '05',
    title: 'Social Impact & Employment Generation',
    items: [
      'Estimated direct and indirect local jobs created within TTAADC blocks',
      'Gender-inclusive hiring roadmap prioritizing indigenous ST women and youth',
      'Environmental sustainability and community wealth retention impact',
    ],
  },
]

export function DPRGuidelines() {
  const handleDownloadTemplate = () => {
    // Generate a structured printable / downloadable DPR text template
    const templateContent = `================================================================================
TTAADC MISSION SEP (2026) - DETAILED PROJECT REPORT (DPR) TEMPLATE
Industry Department, Tripura Tribal Areas Autonomous District Council (TTAADC)
================================================================================

1. ENTERPRISE PROFILE & EXECUTIVE SUMMARY
- Enterprise Name:
- Business Category / Sector:
- Promoter Name(s) & ST Certificate No.:
- Ownership Structure (Proprietorship / Partnership / Pvt Ltd):
- Executive Summary of Proposed Venture:

2. OPERATIONAL & TECHNICAL PLAN
- Physical Location & Operating Site (Village/Block/District inside TTAADC):
- Plant & Machinery / Tooling Requirements (Itemized with Estimated Cost):
- Raw Material Sourcing & Indigenous Supply Chain Strategy:
- Utilities, Power, Water & Infrastructure Plan:

3. MARKET ANALYSIS & COMMERCIAL STRATEGY
- Target Market Demographics (Local / Regional / National):
- Pricing Strategy & Unit Economics:
- Key Competitors & Competitive Advantages:
- Marketing, Branding & Distribution Channels:

4. FINANCIAL PROJECTIONS (3-YEAR ESTIMATES)
- Total Estimated Project Cost (INR):
  a) Capital Expenditure (CAPEX): ₹
  b) Working Capital (OPEX): ₹
- Funding Plan:
  a) Requested TTAADC Seed Fund (Max ₹5,00,000): ₹
  b) Proposed Partner Bank Loan: ₹
  c) Promoter's Own Contribution: ₹
- 3-Year Projected Revenue & Net Profit:
  Year 1: Revenue ₹____________ | Net Profit ₹____________
  Year 2: Revenue ₹____________ | Net Profit ₹____________
  Year 3: Revenue ₹____________ | Net Profit ₹____________
- Break-Even Point (BEP) in Months:

5. SOCIAL IMPACT & EMPLOYMENT GENERATION
- Direct Full-Time Employment Created (ST Youth / Women):
- Indirect Livelihood Opportunities Created:
- Environmental Impact & Ecological Sustainability:

================================================================================
Attach this completed DPR along with the Official Application Form.
================================================================================`

    const blob = new Blob([templateContent], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'TTAADC_Mission_SEP_DPR_Template.txt'
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  return (
    <section id="dpr" className="surface-sky relative border-t border-line">
      <div className="mx-auto max-w-[1500px] px-6 py-24 md:px-10 md:py-32">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
          <Reveal className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
              Submission Guidelines
            </p>
            <h2 className="mt-5 text-[clamp(2rem,3.6vw,3rem)] font-extrabold leading-[1.12] tracking-tight text-primary">
              Detailed Project Report
              <br />
              (DPR) Framework.
            </h2>
            <div className="rule-line mt-7" />
            <p className="mt-7 text-[16px] md:text-[17px] leading-relaxed text-foreground/80">
              Every applicant under Mission SEP is required to prepare and submit a
              comprehensive DPR formatted according to the five mandatory structural
              pillars below.
            </p>
          </Reveal>

          <Reveal delay={0.1}>
            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex items-center gap-3 rounded-full bg-primary px-7 py-3.5 text-[14.5px] font-semibold text-white shadow-md transition-all duration-300 hover:bg-primary/90 hover:-translate-y-0.5"
            >
              <Download className="size-4.5" />
              <span>Download DPR Format (.txt)</span>
            </button>
          </Reveal>
        </div>

        {/* 5 DPR Sections */}
        <div className="mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {dprSections.map((sec, i) => (
            <Reveal
              key={sec.num}
              delay={i * 0.08}
              className="flex flex-col justify-between rounded-xl border border-line bg-background p-7 transition-all duration-300 hover:border-primary/40 hover:shadow-xs"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold uppercase tracking-widest text-primary/60">
                    Part {sec.num}
                  </span>
                  <FileText className="size-5 text-primary/40" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-primary leading-snug">
                  {sec.title}
                </h3>
                <ul className="mt-4 space-y-2.5">
                  {sec.items.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2.5 text-[14px] leading-relaxed text-foreground/75"
                    >
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary/70" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}

          {/* Quick Submission Card */}
          <Reveal
            delay={0.4}
            className="flex flex-col justify-between rounded-xl border border-primary bg-primary p-7 text-white"
          >
            <div>
              <span className="text-xs font-extrabold uppercase tracking-widest text-cyan-200">
                Ready to Apply?
              </span>
              <h3 className="mt-4 text-xl font-bold leading-snug">
                Submit Your DPR & Form Online
              </h3>
              <p className="mt-3 text-[14px] leading-relaxed text-cyan-50/90">
                Complete the 7-Section official digital application and upload your DPR
                draft directly to the single-window portal.
              </p>
            </div>
            <a
              href="#apply"
              className="mt-6 inline-flex items-center justify-center gap-2 rounded-full bg-white px-6 py-3 text-[14px] font-bold text-[#152e4d] transition-all hover:bg-white/95"
            >
              <span>Launch Application</span>
              <ChevronRight className="size-4" />
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

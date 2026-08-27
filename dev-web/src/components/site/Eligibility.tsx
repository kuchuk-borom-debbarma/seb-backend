import { useState } from 'react'
import { Plus, Minus, ArrowRight } from 'lucide-react'

interface Criterion {
  id: string
  number: string
  parameter: string
  oneLiner: string
  fullDescription: React.ReactNode
}

const criteria: Criterion[] = [
  {
    id: '01',
    number: '01',
    parameter: 'Ethnic & Social Identity',
    oneLiner:
      'Valid Scheduled Tribe (ST) certificate of Tripura & majority ownership in the enterprise.',
    fullDescription: (
      <p>
        Applicants must belong to a recognised Scheduled Tribe (ST) of Tripura and possess
        a valid ST Certificate issued by a competent authority. The applicant must be a
        majority stakeholder in the business.
      </p>
    ),
  },
  {
    id: '02',
    number: '02',
    parameter: 'Jurisdiction',
    oneLiner:
      'Enterprise operations or headquarters located within Tripura, preferably in TTAADC areas.',
    fullDescription: (
      <p>
        The enterprise site or corporate headquarters must strictly operate within
        Tripura, preferably within the administrative areas of the TTAADC.
      </p>
    ),
  },
  {
    id: '03',
    number: '03',
    parameter: 'Applicant Enterprise Stage',
    oneLiner:
      'Established enterprises trading 24+ months (Category A) or new ventures under 24 months (Category B).',
    fullDescription: (
      <div className="space-y-2">
        <p>
          <span className="font-semibold text-[#0c1a30]">
            Category A (Established Enterprise):
          </span>{' '}
          <span>Entities operating continuously for 24 months or more.</span>
        </p>
        <p>
          <span className="font-semibold text-[#0c1a30]">
            Category B (New Business Venture):
          </span>{' '}
          <span>
            Registered or proposed business entities under 24 months old seeking
            to establish or scale.
          </span>
        </p>
      </div>
    ),
  },
  {
    id: '04',
    number: '04',
    parameter: 'Age Limit',
    oneLiner:
      'Individual applicants and founders aged between 18 and 60 years at application time.',
    fullDescription: (
      <p>
        Individual applicants/founders must be between 18 and 60 years of age at the time
        of application.
      </p>
    ),
  },
  {
    id: '05',
    number: '05',
    parameter: 'Repeat Funding Eligibility',
    oneLiner:
      'Phase-II funding available 12 months after initial grant disbursement, based on performance audit.',
    fullDescription: (
      <p>
        Beneficiaries who successfully utilise the initial seed grant may apply for
        Phase-II Expansion Funding after 12 months from the date of disbursement of the
        first installment, subject to performance and financial audit.
      </p>
    ),
  },
]

export function Eligibility() {
  const [openId, setOpenId] = useState<string | null>('01')

  return (
    <section
      id="eligibility"
      className="relative bg-[#faf9f6] text-[#15233d] border-t border-[#e2e8f0] pt-20 md:pt-24 pb-16 md:pb-24"
    >
      <div className="mx-auto max-w-[1100px] px-6 md:px-10">
        {/* Section Header */}
        <div className="max-w-2xl">
          <p className="text-xs font-semibold tracking-widest text-[#1d4ed8] uppercase">
            2. ELIGIBILITY MATRIX
          </p>
          <h2 className="mt-2 text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-[#0c1a30] leading-[1.08]">
            Eligibility Criteria
          </h2>
          <p className="mt-3 text-sm sm:text-base leading-relaxed text-[#64748b]">
            Mandatory parameters and standard requirements for Scheduled Tribe (ST)
            entrepreneurs applying under Mission SEP 2026.
          </p>
        </div>

        {/* Minimalist Cardless Divider List */}
        <div className="mt-12 sm:mt-14 border-t border-b border-[#e2e8f0] divide-y divide-[#e2e8f0]">
          {criteria.map((item) => {
            const isOpen = openId === item.id

            return (
              <div key={item.id} className="transition-colors group">
                {/* Header Row */}
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : item.id)}
                  aria-expanded={isOpen}
                  className="w-full text-left py-5 sm:py-6 md:py-7 flex items-start sm:items-center justify-between gap-4 cursor-pointer"
                >
                  <div className="flex items-start sm:items-baseline gap-4 sm:gap-6 min-w-0 flex-1">
                    {/* Minimal Monospace Index */}
                    <span className="font-mono text-sm sm:text-base font-semibold text-[#94a3b8] group-hover:text-[#0c1a30] transition-colors shrink-0 pt-0.5 sm:pt-0">
                      {item.number}
                    </span>

                    {/* Title and One-Liner */}
                    <div className="min-w-0 flex-1 flex flex-col md:flex-row md:items-baseline md:gap-4">
                      <h3 className="text-base sm:text-lg md:text-[19px] font-bold text-[#0c1a30] tracking-tight group-hover:text-[#1d4ed8] transition-colors shrink-0">
                        {item.parameter}
                      </h3>
                      <p className="text-xs sm:text-sm text-[#64748b] leading-normal mt-0.5 md:mt-0 font-normal">
                        {item.oneLiner}
                      </p>
                    </div>
                  </div>

                  {/* Minimal Icon Indicator */}
                  <div className="shrink-0 pt-1 sm:pt-0 text-[#64748b] group-hover:text-[#0c1a30] transition-colors">
                    {isOpen ? (
                      <Minus className="size-4 sm:size-5 stroke-[2]" />
                    ) : (
                      <Plus className="size-4 sm:size-5 stroke-[2]" />
                    )}
                  </div>
                </button>

                {/* Inline Expanded Content (Pure Typography, No Box) */}
                {isOpen && (
                  <div className="pb-6 sm:pb-8 pt-1 pl-7 sm:pl-10 md:pl-10 pr-4 animate-in fade-in slide-in-from-top-1 duration-200">
                    <div className="max-w-3xl">
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-[#1d4ed8]">
                        Policy Mandate &amp; Standard Requirement
                      </p>
                      <div className="mt-1.5 text-sm sm:text-[15px] leading-relaxed text-[#334155]">
                        {item.fullDescription}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Minimal Footer Action Line */}
        <div className="mt-10 sm:mt-12 flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
          <p className="text-xs sm:text-sm text-[#64748b]">
            Single-window digital applications are open for all 58 blocks across Tripura.
          </p>
          <a
            href="/login"
            className="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold text-[#0c1a30] hover:text-[#1d4ed8] transition-colors group self-start sm:self-auto"
          >
            <span>Proceed to Application</span>
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
          </a>
        </div>
      </div>
    </section>
  )
}

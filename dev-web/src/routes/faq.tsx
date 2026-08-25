import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { Header } from '@/components/site/Header'
import { Footer } from '@/components/site/Footer'
import { SmoothScroll } from '@/components/site/SmoothScroll'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  Search,
  HelpCircle,
  ShieldCheck,
  Coins,
  Compass,
  FileText,
  ArrowRight,
} from 'lucide-react'

export const Route = createFileRoute('/faq')({
  head: () => ({
    meta: [
      { title: 'Frequently Asked Questions | TTAADC Mission SEP 2026' },
      {
        name: 'description',
        content:
          'Comprehensive FAQs for TTAADC Mission SEP 2026: Eligibility, ST certification, seed grants up to ₹5 Lakhs, DPR preparation, and bank linkages.',
      },
    ],
  }),
  component: FaqPage,
})

interface FaqItem {
  q: string
  a: string
  category: 'all' | 'eligibility' | 'funding' | 'tracks' | 'dpr'
}

const faqData: FaqItem[] = [
  {
    category: 'eligibility',
    q: 'Who is eligible to apply for Mission SEP 2026?',
    a: 'Any permanent indigenous Scheduled Tribe (ST) resident of Tripura aged between 18 and 60 years who holds a valid ST Certificate issued by the Competent Authority of Tripura. The enterprise must operate within Tripura, with priority given to units established in TTAADC Sixth Schedule areas.',
  },
  {
    category: 'eligibility',
    q: 'Can partnership firms or private limited companies apply?',
    a: 'Yes. Partnership firms, LLPs, Private Limited companies, and Producer Collectives/Cooperatives can apply provided that at least 51% of equity/ownership is held by eligible ST founders of Tripura, and day-to-day management control rests with the ST founder(s).',
  },
  {
    category: 'eligibility',
    q: 'Is there any educational qualification requirement?',
    a: 'No formal educational degrees are required. Both grassroots traditional artisans (weavers, cane/bamboo craftsmen) and modern tech/service entrepreneurs are equally encouraged to apply.',
  },
  {
    category: 'funding',
    q: 'How much grant assistance can a founder receive?',
    a: 'Under Component A (Direct Seed Grant), eligible enterprises receive up to ₹5,00,000 (₹5 Lakhs) based on their evaluated Detailed Project Report (DPR) to procure machinery, equipment, tooling, and initial working capital.',
  },
  {
    category: 'funding',
    q: 'Do I have to repay the ₹5 Lakhs seed grant?',
    a: 'No. The seed grant under Component A is direct grant-in-aid financial assistance provided to kickstart or expand your enterprise. It does not require repayment, provided milestones in your DPR are adhered to and verified by TTM.',
  },
  {
    category: 'funding',
    q: 'How does the Bank Credit Linkage (Component B) work?',
    a: 'Mission SEP has dedicated institutional tie-ups with leading commercial and regional rural banks (including Tripura Gramin Bank). Qualifying enterprises receive facilitated credit linkages, working capital limits, and credit guarantee facilitation with interest subsidy support.',
  },
  {
    category: 'funding',
    q: 'What is Phase-II scaling support?',
    a: 'Enterprises that successfully complete 12 months of operations with audited books, positive cash flows, and employment generation become eligible for Phase-II acceleration funding and growth-stage venture linkages.',
  },
  {
    category: 'tracks',
    q: 'What is the difference between Category A and Category B?',
    a: 'Category A is tailored for New Startups and early ventures operating for 0 to 24 months, focusing on capital asset creation. Category B is designed for Existing Operating Enterprises active for more than 24 months that require technological modernization and capacity expansion.',
  },
  {
    category: 'tracks',
    q: 'Which business sectors are supported under the scheme?',
    a: 'Key priority sectors include Handloom & Traditional Textiles (Risa/Rikutu), Bamboo & Cane Handicrafts, Agriculture & Agro-Processing, Horticulture & Plantation, Eco-Tourism & Cultural Homestays, Renewable Energy, and Food Processing.',
  },
  {
    category: 'dpr',
    q: 'What documents are required during online application?',
    a: 'You will need: (1) Valid Tripura ST Certificate, (2) Aadhaar / Voter ID, (3) Bank Passbook with active IFSC, (4) Passport Photo, (5) Detailed Project Report (DPR), and (6) Business registration certificate or trade license (if existing).',
  },
  {
    category: 'dpr',
    q: 'How can I prepare my Detailed Project Report (DPR)?',
    a: 'A standard, user-friendly DPR template is provided directly on the application portal. In addition, the TTAADC Industry Department Helpdesk at Khumulwng offers free advisory assistance to help applicants draft their DPRs.',
  },
  {
    category: 'dpr',
    q: 'Is there any application fee or processing charge?',
    a: 'No. Mission SEP application submission, scrutiny, DPR evaluation, and tracking are 100% free of charge. TTAADC does not authorize any middlemen or private agents to collect fees.',
  },
]

const categories = [
  { id: 'all', label: 'All Questions', Icon: HelpCircle },
  { id: 'eligibility', label: 'Eligibility & ST', Icon: ShieldCheck },
  { id: 'funding', label: 'Grants & Capital', Icon: Coins },
  { id: 'tracks', label: 'Programme Tracks', Icon: Compass },
  { id: 'dpr', label: 'DPR & Application', Icon: FileText },
]

function FaqPage() {
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState<string>('')

  const filteredFaqs = faqData.filter((item) => {
    const matchesCategory =
      selectedCategory === 'all' || item.category === selectedCategory
    const matchesQuery =
      searchQuery.trim() === '' ||
      item.q.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.a.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesCategory && matchesQuery
  })

  return (
    <SmoothScroll>
      <Header />

      <main className="min-h-screen bg-[#faf9f6] text-[#15233d] pt-28 pb-20 md:pt-36 md:pb-28">
        {/* Page Hero Banner */}
        <section className="mx-auto max-w-[1400px] px-6 md:px-10">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold uppercase tracking-[0.22em] text-[#1d4ed8]">
              <HelpCircle className="size-4" />
              <span>Knowledge Base &amp; Help</span>
            </span>

            <h1 className="mt-3 font-serif text-3xl font-bold tracking-tight text-[#0c1a30] sm:text-4xl md:text-5xl">
              Frequently Asked Questions
            </h1>

            <p className="mt-4 text-base leading-relaxed text-[#475569] sm:text-lg">
              Clear answers on eligibility, ST validation, seed grants up to ₹5 Lakhs, DPR
              guidelines, and bank linkage procedures for Mission SEP 2026.
            </p>

            {/* Search Input Bar */}
            <div className="relative mx-auto mt-8 max-w-xl">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-[#94a3b8]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by keyword (e.g. ST certificate, grant amount, DPR, bank)..."
                className="w-full rounded-full border border-[#cbd5e1] bg-white py-3.5 pl-12 pr-4 text-sm text-[#0f2444] placeholder:text-[#94a3b8] shadow-xs outline-none transition-all focus:border-[#1d4ed8] focus:ring-2 focus:ring-[#1d4ed8]/20"
              />
            </div>

            {/* Category Filter Buttons */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              {categories.map((cat) => {
                const isActive = selectedCategory === cat.id
                return (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition-all ${
                      isActive
                        ? 'bg-[#0f2444] text-white shadow-xs'
                        : 'border border-[#cbd5e1] bg-white text-[#475569] hover:bg-[#f1f5f9]'
                    }`}
                  >
                    <cat.Icon className="size-3.5" />
                    <span>{cat.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Accordion Questions List */}
          <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-[#cbd5e1] bg-white p-6 shadow-sm sm:p-8">
            {filteredFaqs.length === 0 ? (
              <div className="py-12 text-center text-[#64748b]">
                <HelpCircle className="mx-auto size-8 text-[#94a3b8]" />
                <p className="mt-3 font-semibold">
                  No questions found matching your search.
                </p>
                <p className="mt-1 text-xs">
                  Try searching for other terms like &ldquo;grant&rdquo; or
                  &ldquo;eligibility&rdquo;.
                </p>
              </div>
            ) : (
              <Accordion
                type="single"
                collapsible
                className="w-full divide-y divide-[#f1f5f9]"
              >
                {filteredFaqs.map((faq, index) => (
                  <AccordionItem
                    key={faq.q}
                    value={`faq-${index}`}
                    className="border-none py-2"
                  >
                    <AccordionTrigger className="text-left font-serif text-base font-bold text-[#0c1a30] hover:text-[#1d4ed8] hover:no-underline sm:text-lg">
                      {faq.q}
                    </AccordionTrigger>
                    <AccordionContent className="pt-1 text-sm leading-relaxed text-[#475569] sm:text-[15px]">
                      {faq.a}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            )}
          </div>

          {/* Still Have Questions Contact Box */}
          <div className="mx-auto mt-12 max-w-3xl rounded-2xl border border-[#e2e8f0] bg-[#f8fafc] p-6 text-center sm:p-8">
            <h3 className="font-serif text-xl font-bold text-[#0c1a30]">
              Still have questions or need DPR advisory?
            </h3>
            <p className="mt-2 text-sm text-[#526a8d]">
              Our enterprise support officers at the TTAADC Industry Department are
              available to guide you through every step of your application.
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
              <a
                href="/#contact"
                className="inline-flex items-center gap-2 rounded-full bg-[#0f2444] px-6 py-2.5 text-xs font-bold text-white shadow-xs transition-all hover:bg-[#1d4ed8]"
              >
                <span>Go to Application Helpdesk</span>
                <ArrowRight className="size-3.5" />
              </a>
              <Link
                to="/"
                className="inline-flex items-center gap-1.5 rounded-full border border-[#cbd5e1] bg-white px-5 py-2.5 text-xs font-semibold text-[#0f2444] transition-all hover:bg-[#f1f5f9]"
              >
                <span>Back to Home</span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </SmoothScroll>
  )
}

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Reveal } from './Reveal'

const faqs = [
  {
    q: 'What assistance amount can an applicant receive?',
    a: 'Direct seed funding of up to ₹5,00,000 (₹5 Lakhs) based on your Detailed Project Report (DPR), along with fast-track bank credit linkages.',
  },
  {
    q: 'Who is eligible to apply?',
    a: 'Indigenous Scheduled Tribe (ST) residents of Tripura aged 18 to 60 with majority ownership in an enterprise operating within Tripura or TTAADC areas.',
  },
  {
    q: 'What is the difference between Category A and Category B?',
    a: 'Category A is for new startups and ventures up to 24 months old. Category B is for existing enterprises operating for over 24 months seeking scaling or expansion.',
  },
  {
    q: 'Which documents are required?',
    a: 'Valid ST Certificate, identity/address proof, Detailed Project Report (DPR), bank passbook copy, and business registration (if registered).',
  },
  {
    q: 'Is there an application fee?',
    a: 'No. Application submission and tracking under Mission SEP are 100% free of charge at every stage.',
  },
]

export function Faq() {
  return (
    <section id="faq" className="surface-sky">
      <div className="mx-auto grid max-w-[1500px] gap-12 px-6 py-24 md:grid-cols-12 md:px-10 md:py-32">
        <Reveal className="md:col-span-4">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
            Questions
          </p>
          <h2 className="mt-5 text-[clamp(2rem,3.4vw,2.8rem)] font-extrabold leading-[1.12] tracking-tight text-primary">
            Frequently asked.
          </h2>
          <div className="rule-line mt-7" />
        </Reveal>

        <Reveal delay={0.1} className="md:col-span-7 md:col-start-6">
          <Accordion type="single" collapsible className="w-full">
            {faqs.map((f, i) => (
              <AccordionItem key={f.q} value={`item-${i}`} className="border-line">
                <AccordionTrigger className="py-6 text-left text-[17px] font-semibold text-primary hover:no-underline">
                  {f.q}
                </AccordionTrigger>
                <AccordionContent className="pb-6 text-[16px] leading-relaxed text-foreground/75">
                  {f.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </Reveal>
      </div>
    </section>
  )
}

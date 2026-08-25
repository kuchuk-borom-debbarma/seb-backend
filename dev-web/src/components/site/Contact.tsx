import { ArrowRight, Mail, MapPin, Phone } from 'lucide-react'
import { Reveal } from './Reveal'

export function Contact() {
  return (
    <section id="contact" className="bg-[#faf9f6] border-t border-[#e2e8f0]">
      <div className="mx-auto max-w-[1500px] px-6 py-20 md:px-10 md:py-28">
        <Reveal>
          <div className="grid gap-12 md:grid-cols-12 items-start">
            <div className="md:col-span-7">
              <h2 className="font-serif text-[clamp(2.2rem,4vw,3.5rem)] font-bold leading-[1.08] tracking-tight text-[#0c1a30]">
                Ready to start
                <br />
                your application?
              </h2>
              <p className="mt-5 max-w-lg text-[16px] md:text-[17px] leading-relaxed text-[#475569]">
                Prepare your Detailed Project Report (DPR) and submit your proposal to the
                Industry Department, TTAADC. For inquiries, reach out to the Programme
                Nodal Cell.
              </p>
              <div className="mt-8 flex flex-wrap gap-4">
                <a
                  href="mailto:sep@ttaadc.gov.in"
                  className="inline-flex items-center gap-3 rounded-full bg-[#0f2444] px-8 py-3.5 text-[15px] font-semibold text-white shadow-xs transition-all duration-300 hover:bg-[#1d4ed8] hover:-translate-y-0.5"
                >
                  <span>Contact Nodal Cell</span>
                  <ArrowRight className="size-4.5" strokeWidth={1.8} />
                </a>
              </div>
            </div>

            <div className="md:col-span-5 md:col-start-8 md:pl-6 md:border-l md:border-[#e2e8f0]">
              <h3 className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-[#1d4ed8]">
                Programme Nodal Office
              </h3>
              <div className="mt-6 space-y-5 text-[15.5px] text-[#334155]">
                <p className="flex items-start gap-4">
                  <MapPin
                    className="mt-0.5 size-5 shrink-0 text-[#1d4ed8]"
                    strokeWidth={1.8}
                  />
                  <span>
                    Industry Department, TTAADC
                    <br />
                    Khumulwng, West Tripura - 799045
                  </span>
                </p>
                <p className="flex items-start gap-4">
                  <Phone
                    className="mt-0.5 size-5 shrink-0 text-[#1d4ed8]"
                    strokeWidth={1.8}
                  />
                  <span>+91 381 234 5678 (Helpdesk)</span>
                </p>
                <p className="flex items-start gap-4">
                  <Mail
                    className="mt-0.5 size-5 shrink-0 text-[#1d4ed8]"
                    strokeWidth={1.8}
                  />
                  <span>sep@ttaadc.gov.in</span>
                </p>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

import { ArrowRight, Mail, MapPin, Phone } from 'lucide-react'
import { Reveal } from './Reveal'

export function Contact() {
  return (
    <section
      id="contact"
      className="relative bg-[#0c141f] text-white border-t border-white/10"
    >
      <div className="mx-auto max-w-[1400px] px-6 py-16 sm:py-20 md:px-10 md:py-24">
        <Reveal>
          <div className="grid gap-10 lg:grid-cols-12 lg:gap-16 items-center">
            {/* Left Column: Ultra-minimalist Heading & Action */}
            <div className="lg:col-span-5 flex flex-col justify-center">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[#d1ab76]">
                Nodal Desk
              </p>
              <h2 className="mt-2 font-serif text-3xl sm:text-4xl lg:text-[2.6rem] font-bold leading-[1.12] tracking-tight text-white">
                Ready to apply?
              </h2>
              <p className="mt-2 text-sm sm:text-[15px] leading-relaxed text-white/75 max-w-sm">
                Submit your DPR proposal online or get in touch for scheme guidance.
              </p>

              <div className="mt-6">
                <a
                  href="/login"
                  className="inline-flex items-center gap-2 rounded-xl bg-[#1d4ed8] px-5 py-2.5 sm:px-6 sm:py-3 text-xs sm:text-sm font-semibold text-white shadow-xs transition-all duration-300 hover:bg-[#2563eb] hover:gap-2.5 cursor-pointer"
                >
                  <span className="text-white">Proceed to Apply</span>
                  <ArrowRight className="size-4 text-white" strokeWidth={2} />
                </a>
              </div>
            </div>

            {/* Right Column: Minimalist Contact Channel Grid */}
            <div className="lg:col-span-7">
              <div className="divide-y divide-white/10 border-y border-white/10">
                {/* Location */}
                <div className="flex items-start gap-4 py-4 sm:py-5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white mt-0.5">
                    <MapPin className="size-4.5 text-[#d1ab76]" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
                      Head Office
                    </p>
                    <p className="mt-0.5 text-sm sm:text-[15px] font-semibold text-white">
                      Industry Department, TTAADC
                    </p>
                    <p className="mt-0.5 text-xs sm:text-[13px] text-white/70">
                      Khumulwng, West Tripura — 799045
                    </p>
                  </div>
                </div>

                {/* Phone */}
                <div className="flex items-start gap-4 py-4 sm:py-5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white mt-0.5">
                    <Phone className="size-4.5 text-[#d1ab76]" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
                      Helpline
                    </p>
                    <p className="mt-0.5 text-sm sm:text-[15px] font-semibold text-white">
                      +91 381 234 5678
                    </p>
                    <p className="mt-0.5 text-xs sm:text-[13px] text-white/70">
                      Monday – Friday, 10:00 AM – 5:00 PM IST
                    </p>
                  </div>
                </div>

                {/* Email */}
                <div className="flex items-start gap-4 py-4 sm:py-5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white mt-0.5">
                    <Mail className="size-4.5 text-[#d1ab76]" strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
                      Official Email
                    </p>
                    <a
                      href="mailto:sep@ttaadc.gov.in"
                      className="mt-0.5 inline-block text-sm sm:text-[15px] font-semibold text-[#d1ab76] hover:underline"
                    >
                      sep@ttaadc.gov.in
                    </a>
                    <p className="mt-0.5 text-xs sm:text-[13px] text-white/70">
                      Single-Window Applicant Support Desk
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}

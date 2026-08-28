import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { Wheat, Shirt, Apple, Compass, Cog } from 'lucide-react'
import craftThumb from '@/assets/craft-thumb.jpg'
import handloomImg from '@/assets/handloom.png'
import tourismImg from '@/assets/tourism.png'
import heroLandscape from '@/assets/hero-landscape.jpg'

interface SectorCard {
  id: string
  Icon: React.ElementType
  title: string
  category: string
  desc: string
  image: string
  alt: string
  finalRotation: number
  finalTranslateY: string
  marginClass: string
  zIndex: string
  entryType: 'left-outer' | 'left-inner' | 'bottom' | 'right-inner' | 'right-outer'
}

const sectorCards: SectorCard[] = [
  {
    id: 'tourism',
    Icon: Compass,
    title: 'Tourism & Hospitality',
    category: 'Eco-Lodges & Homestays',
    desc: 'Eco-tourism lodges, indigenous homestays, cultural travel hubs, and local culinary ventures nestled in the hills.',
    image: tourismImg,
    alt: 'Tripura palace architecture and cultural heritage tourism',
    finalRotation: -16,
    finalTranslateY: 'translate-y-6 md:translate-y-8',
    marginClass: '-mr-6 sm:-mr-8 md:-mr-10 lg:-mr-12',
    zIndex: 'z-10',
    entryType: 'left-outer',
  },
  {
    id: 'agriculture',
    Icon: Wheat,
    title: 'Agriculture & Allied',
    category: 'Agro-Forestry & Plantations',
    desc: 'Agro-farming, horticulture, rubber, spices, floriculture, and organic plantation units across TTAADC.',
    image: heroLandscape,
    alt: 'Misty mountain hills and plantation valleys',
    finalRotation: -8,
    finalTranslateY: 'translate-y-2 md:translate-y-3',
    marginClass: '-mr-6 sm:-mr-8 md:-mr-10 lg:-mr-12',
    zIndex: 'z-20',
    entryType: 'left-inner',
  },
  {
    id: 'handloom',
    Icon: Shirt,
    title: 'Handloom & Textiles',
    category: 'Risa & Tribal Apparel',
    desc: 'Traditional handloom, Risa, Rignai weaving, garment clusters, modern apparel, and natural dye units.',
    image: handloomImg,
    alt: 'Tripuri handloom weaver creating traditional textiles',
    finalRotation: 0,
    finalTranslateY: 'translate-y-0',
    marginClass: '-mr-6 sm:-mr-8 md:-mr-10 lg:-mr-12',
    zIndex: 'z-30',
    entryType: 'bottom',
  },
  {
    id: 'food-processing',
    Icon: Apple,
    title: 'Food Processing',
    category: 'Value-Added Agro Units',
    desc: 'Pineapple, jackfruit, ginger, turmeric processing, packaged foods, and modern cold storage infrastructure.',
    image:
      'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?q=80&w=800&auto=format&fit=crop',
    alt: 'Fresh tropical harvest and organic food processing in Tripura',
    finalRotation: 8,
    finalTranslateY: 'translate-y-2 md:translate-y-3',
    marginClass: '-mr-6 sm:-mr-8 md:-mr-10 lg:-mr-12',
    zIndex: 'z-20',
    entryType: 'right-inner',
  },
  {
    id: 'crafts',
    Icon: Cog,
    title: 'Bamboo, Cane & Crafts',
    category: 'Handicraft Enterprises',
    desc: 'Artisanal bamboo furniture, cane decor, wood carving, metal crafts, and indigenous utility items.',
    image: craftThumb,
    alt: 'Master artisan carving detailed bamboo handicrafts',
    finalRotation: 16,
    finalTranslateY: 'translate-y-6 md:translate-y-8',
    marginClass: '',
    zIndex: 'z-10',
    entryType: 'right-outer',
  },
]

export function Project() {
  const sectionRef = useRef<HTMLElement>(null)
  const [activeSector, setActiveSector] = useState<SectorCard>(sectorCards[2]!)

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger)
    const section = sectionRef.current
    if (!section) return

    const mm = gsap.matchMedia()

    // Desktop Pinned Arc Animation (>= 1024px)
    mm.add('(min-width: 1024px)', () => {
      const cardCenter = section.querySelector('[data-entry="bottom"]')
      const cardLeftInner = section.querySelector('[data-entry="left-inner"]')
      const cardLeftOuter = section.querySelector('[data-entry="left-outer"]')
      const cardRightInner = section.querySelector('[data-entry="right-inner"]')
      const cardRightOuter = section.querySelector('[data-entry="right-outer"]')

      if (cardCenter) {
        gsap.set(cardCenter, {
          y: 420,
          rotation: 0,
          scale: 0.76,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      }

      if (cardLeftOuter) {
        gsap.set(cardLeftOuter, {
          x: -560,
          y: 440,
          rotation: -42,
          scale: 0.72,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      }
      if (cardLeftInner) {
        gsap.set(cardLeftInner, {
          x: -340,
          y: 480,
          rotation: -26,
          scale: 0.78,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      }

      if (cardRightInner) {
        gsap.set(cardRightInner, {
          x: 340,
          y: 480,
          rotation: 26,
          scale: 0.78,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      }
      if (cardRightOuter) {
        gsap.set(cardRightOuter, {
          x: 560,
          y: 440,
          rotation: 42,
          scale: 0.72,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      }

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: 'top top',
          end: '+=2200',
          pin: true,
          scrub: 1.1,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      })

      if (cardCenter) {
        tl.to(
          cardCenter,
          {
            x: 0,
            y: 0,
            rotation: 0,
            scale: 1,
            opacity: 1,
            duration: 0.9,
            ease: 'back.out(1.5)',
          },
          0.05,
        )
      }

      if (cardLeftInner) {
        tl.to(
          cardLeftInner,
          {
            x: 0,
            y: 0,
            rotation: -8,
            scale: 1,
            opacity: 1,
            duration: 0.95,
            ease: 'back.out(1.4)',
          },
          0.28,
        )
      }
      if (cardRightInner) {
        tl.to(
          cardRightInner,
          {
            x: 0,
            y: 0,
            rotation: 8,
            scale: 1,
            opacity: 1,
            duration: 0.95,
            ease: 'back.out(1.4)',
          },
          0.28,
        )
      }

      if (cardLeftOuter) {
        tl.to(
          cardLeftOuter,
          {
            x: 0,
            y: 0,
            rotation: -16,
            scale: 1,
            opacity: 1,
            duration: 0.95,
            ease: 'back.out(1.3)',
          },
          0.48,
        )
      }
      if (cardRightOuter) {
        tl.to(
          cardRightOuter,
          {
            x: 0,
            y: 0,
            rotation: 16,
            scale: 1,
            opacity: 1,
            duration: 0.95,
            ease: 'back.out(1.3)',
          },
          0.48,
        )
      }

      tl.to({}, { duration: 1.1 })
    })

    return () => mm.revert()
  }, [])

  return (
    <section
      id="project"
      ref={sectionRef}
      className="relative min-h-screen lg:h-[100svh] flex flex-col justify-between overflow-hidden bg-white pt-20 pb-8 sm:pt-24 sm:pb-10 lg:pt-28 lg:pb-8 text-[#181715]"
    >
      <div className="mx-auto flex h-full w-full max-w-[1500px] flex-col justify-between px-4 sm:px-6 md:px-10">
        {/* Section Header */}
        <div className="mx-auto max-w-3xl text-center pb-2 md:pb-3">
          <p className="text-xs md:text-sm font-semibold uppercase tracking-[0.22em] text-[#181715]/60">
            Target Sectors
          </p>
          <h2 className="mt-1.5 font-serif text-[clamp(1.6rem,3.2vw,2.75rem)] font-normal leading-[1.15] tracking-tight text-[#181715]">
            Supported Business
            <br />
            Categories &amp; Sectors
          </h2>
        </div>

        {/* ========================================================================= */}
        {/* DESKTOP HYPERBOLIC CARD ARC (>= 1024px)                                   */}
        {/* ========================================================================= */}
        <div className="hidden lg:flex relative my-auto items-center justify-center py-2 select-none">
          <div className="flex items-center justify-center">
            {sectorCards.map((card) => {
              const isSelected = activeSector.id === card.id
              return (
                <div
                  key={card.id}
                  data-entry={card.entryType}
                  onClick={() => setActiveSector(card)}
                  className={`group/sector relative shrink-0 cursor-pointer ${card.marginClass} ${card.zIndex} ${card.finalTranslateY} transition-all duration-500 hover:!rotate-0 hover:scale-110 hover:!-translate-y-6 hover:!z-50 ${
                    isSelected ? '!scale-106 !-translate-y-2 !z-40' : ''
                  }`}
                >
                  <div className="w-48 xl:w-56 aspect-[3/4] rounded-xl bg-white p-1.5 shadow-lg transition-all duration-500 group-hover/sector:shadow-2xl border border-stone-300/60">
                    <div className="relative size-full overflow-hidden rounded-lg bg-stone-100">
                      <img
                        src={card.image}
                        alt={card.alt}
                        loading="lazy"
                        className="size-full object-cover transition-transform duration-700 group-hover/sector:scale-108"
                      />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-2 pt-5 text-white">
                        <div className="flex items-center gap-1">
                          <card.Icon
                            className="size-3 text-white/90 shrink-0"
                            strokeWidth={2}
                          />
                          <p className="text-[11.5px] font-bold leading-tight line-clamp-1">
                            {card.title}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* ========================================================================= */}
        {/* MOBILE & TABLET HORIZONTAL TOUCH-SNAP SECTOR SWIPER (< 1024px)            */}
        {/* ========================================================================= */}
        <div className="block lg:hidden my-6 w-full">
          <div className="-mx-4 px-4 sm:-mx-6 sm:px-6 flex gap-3.5 overflow-x-auto snap-x snap-mandatory pb-3 scrollbar-none touch-pan-x">
            {sectorCards.map((card) => (
              <div
                key={card.id}
                className="w-[70vw] sm:w-[240px] shrink-0 snap-center rounded-2xl bg-stone-50 border border-stone-200 overflow-hidden shadow-md"
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden">
                  <img
                    src={card.image}
                    alt={card.alt}
                    className="size-full object-cover"
                  />
                  <div className="absolute top-2.5 left-2.5 rounded-md bg-white/90 px-2 py-1 backdrop-blur-xs flex items-center gap-1.5 shadow-2xs">
                    <card.Icon className="size-3 text-[#0c2340]" strokeWidth={2} />
                    <span className="text-[10px] font-bold text-[#0c2340]">
                      {card.category}
                    </span>
                  </div>
                </div>

                <div className="p-3.5">
                  <h3 className="text-sm font-bold text-[#181715] leading-snug">
                    {card.title}
                  </h3>
                  <p className="mt-1 text-[11.5px] text-[#181715]/75 leading-relaxed">
                    {card.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] text-[#181715]/50">
            <span>Swipe to explore sectors &rarr;</span>
          </div>
        </div>
      </div>
    </section>
  )
}

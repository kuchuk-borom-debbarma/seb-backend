import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import craftThumb from '@/assets/craft-thumb.jpg'
import oneImg from '@/assets/one.png'
import heroLandscape from '@/assets/hero-landscape.jpg'
import ecoParkImg from '@/assets/eco-park.jpg'

interface SlideData {
  statement: React.ReactNode
  title: string
  subtitle: string
  centerImg: string
  centerAlt: string
  leftCutImg: string
  leftTopImg: string
  leftBottomImg: string
  rightTopImg: string
  rightBottomImg: string
  rightCutImg: string
}

const slides: SlideData[] = [
  {
    statement: (
      <>
        Through careful <em className="italic font-normal">consideration</em> of
        indigenous craft, capital and narrative,{' '}
        <em className="italic font-semibold">Mission SEP</em> creates lasting{' '}
        <em className="italic font-normal">opportunity</em> across Tripura.
      </>
    ),
    title: 'The spirit of sustainable enterprise',
    subtitle: 'TTAADC Transformation Mission',
    centerImg: ecoParkImg,
    centerAlt:
      'Aerial view of scenic eco-tourism resort and landscaped cottages in Tripura',
    leftCutImg:
      'https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=600&auto=format&fit=crop',
    leftTopImg:
      'https://images.unsplash.com/photo-1506744038136-46273834b3fb?q=80&w=600&auto=format&fit=crop',
    leftBottomImg: oneImg,
    rightTopImg: heroLandscape,
    rightBottomImg:
      'https://images.unsplash.com/photo-1513836279014-a89f7a76ae86?q=80&w=600&auto=format&fit=crop',
    rightCutImg: craftThumb,
  },
  {
    statement: (
      <>
        Empowering <em className="italic font-normal">first-generation</em> tribal
        founders to bridge native heritage and commercial markets through{' '}
        <em className="italic font-semibold">direct seed capital</em>.
      </>
    ),
    title: 'Indigenous enterprise modernization',
    subtitle: 'Industry Department, Khumulwng',
    centerImg: craftThumb,
    centerAlt: 'Artisan handcrafting traditional bamboo and cane products',
    leftCutImg: heroLandscape,
    leftTopImg:
      'https://images.unsplash.com/photo-1450133064473-71024230f91b?q=80&w=600&auto=format&fit=crop',
    leftBottomImg:
      'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?q=80&w=600&auto=format&fit=crop',
    rightTopImg:
      'https://images.unsplash.com/photo-1506744038136-46273834b3fb?q=80&w=600&auto=format&fit=crop',
    rightBottomImg: oneImg,
    rightCutImg: heroLandscape,
  },
]

export function About() {
  const sectionRef = useRef<HTMLElement>(null)
  const [slideIndex, setSlideIndex] = useState(0)
  const current = slides[slideIndex] ?? slides[0]!

  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger)
    const section = sectionRef.current
    if (!section) return

    const mm = gsap.matchMedia()

    // Desktop only pinned gallery scrub & entrance reveal
    mm.add('(min-width: 1024px)', () => {
      const cardCenter = section.querySelector('[data-card-center]')
      const cardsInnerPair = section.querySelectorAll('[data-card-inner-pair]')
      const cardsOuterPair = section.querySelectorAll('[data-card-outer-pair]')
      const statement = section.querySelector('.about-statement')
      const controls = section.querySelector('.about-controls')

      // Initial state: subtle offset and opacity 0 so items are ready to enter promptly
      if (cardCenter) {
        gsap.set(cardCenter, {
          y: 60,
          rotation: 0,
          scale: 0.92,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      }

      cardsInnerPair.forEach((card, i) => {
        const rot = i % 2 === 0 ? -6 : 6
        gsap.set(card, {
          y: 75,
          rotation: rot,
          scale: 0.9,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      })

      cardsOuterPair.forEach((card, i) => {
        const rot = i === 0 ? -8 : 8
        gsap.set(card, {
          y: 90,
          rotation: rot,
          scale: 0.88,
          opacity: 0,
          transformOrigin: '50% 100%',
        })
      })

      if (statement) {
        gsap.set(statement, { opacity: 0, y: 25, filter: 'blur(4px)' })
      }
      if (controls) {
        gsap.set(controls, { opacity: 0, y: 16 })
      }

      // 1. Entrance timeline: starts as section approaches viewport (top 85% to top 15%)
      // This ensures photos appear immediately without any blank screen at the top
      const entryTl = gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: 'top 85%',
          end: 'top 15%',
          scrub: 0.5,
          invalidateOnRefresh: true,
        },
      })

      if (cardCenter) {
        entryTl.to(
          cardCenter,
          {
            y: 0,
            rotation: 0,
            scale: 1,
            opacity: 1,
            duration: 0.6,
            ease: 'power2.out',
          },
          0,
        )
      }

      cardsInnerPair.forEach((card) => {
        entryTl.to(
          card,
          {
            y: 0,
            rotation: 0,
            scale: 1,
            opacity: 1,
            duration: 0.6,
            ease: 'power2.out',
          },
          0.08,
        )
      })

      cardsOuterPair.forEach((card) => {
        entryTl.to(
          card,
          {
            y: 0,
            rotation: 0,
            scale: 1,
            opacity: 1,
            duration: 0.6,
            ease: 'power2.out',
          },
          0.16,
        )
      })

      if (statement) {
        entryTl.to(
          statement,
          {
            opacity: 1,
            y: 0,
            filter: 'blur(0px)',
            duration: 0.5,
            ease: 'power2.out',
          },
          0.2,
        )
      }

      if (controls) {
        entryTl.to(
          controls,
          {
            opacity: 1,
            y: 0,
            duration: 0.45,
            ease: 'power2.out',
          },
          0.28,
        )
      }

      // 2. Pinned showcase timeline: fast, responsive snap pin at top top
      const pinTl = gsap.timeline({
        scrollTrigger: {
          trigger: section,
          start: 'top top',
          end: () => `+=${Math.round(window.innerHeight * 0.75)}`,
          pin: true,
          scrub: 0.4,
          snap: {
            snapTo: [0, 1],
            duration: { min: 0.2, max: 0.4 },
            ease: 'power2.out',
            delay: 0.02,
          },
          anticipatePin: 1,
          invalidateOnRefresh: true,
        },
      })

      // Subtle parallax depth shift during pin
      if (cardsOuterPair.length >= 2) {
        pinTl.to(cardsOuterPair[0]!, { x: -10, duration: 0.6, ease: 'sine.inOut' }, 0)
        pinTl.to(cardsOuterPair[1]!, { x: 10, duration: 0.6, ease: 'sine.inOut' }, 0)
      }
      if (cardsInnerPair.length >= 2) {
        pinTl.to(cardsInnerPair[0]!, { x: -5, duration: 0.6, ease: 'sine.inOut' }, 0)
        pinTl.to(cardsInnerPair[1]!, { x: 5, duration: 0.6, ease: 'sine.inOut' }, 0)
      }
      if (cardCenter) {
        pinTl.to(cardCenter, { scale: 1.02, duration: 0.6, ease: 'sine.inOut' }, 0)
      }
    })

    return () => mm.revert()
  }, [])

  const changeSlide = (nextIndex: number) => {
    setSlideIndex(nextIndex)
  }

  const handlePrev = () => {
    changeSlide((slideIndex - 1 + slides.length) % slides.length)
  }

  const handleNext = () => {
    changeSlide((slideIndex + 1) % slides.length)
  }

  return (
    <section
      id="about"
      ref={sectionRef}
      className="relative min-h-screen lg:h-[100svh] flex flex-col justify-between overflow-hidden bg-[#ded8ce] py-10 sm:py-12 lg:py-8 text-[#181715]"
    >
      <div className="mx-auto flex h-full w-full max-w-[1700px] flex-col justify-between px-4 sm:px-6 md:px-8">
        {/* ========================================================================= */}
        {/* DESKTOP GALLERY VIEW (>= 1024px)                                          */}
        {/* ========================================================================= */}
        <div className="hidden lg:flex relative items-center justify-center gap-8 xl:gap-10 py-2 select-none">
          {/* 1. Far Left Cut-Off Frame */}
          <div
            data-card-outer-pair
            className="shrink-0 w-32 xl:w-36 h-56 xl:h-64 -ml-12 group/card cursor-pointer transition-all duration-500 hover:scale-110 hover:z-30"
          >
            <div className="size-full border-[2.5px] border-[#181715] overflow-hidden shadow-sm">
              <img
                src={current.leftCutImg}
                alt="Artisan texture"
                loading="lazy"
                className="size-full object-cover grayscale contrast-110"
              />
            </div>
          </div>

          {/* 2. Left Staggered Pair */}
          <div className="relative shrink-0 flex items-center">
            <div
              data-card-inner-pair
              className="w-44 xl:w-52 aspect-square translate-y-[-18px] group/card cursor-pointer transition-all duration-500 hover:scale-110 hover:z-30"
            >
              <div className="size-full border-[3px] border-[#181715] overflow-hidden shadow-sm">
                <img
                  src={current.leftTopImg}
                  alt="Landscape scene"
                  loading="lazy"
                  className="size-full object-cover grayscale contrast-125"
                />
              </div>
            </div>
            <div
              data-card-inner-pair
              className="absolute left-1/2 top-6 w-40 xl:w-48 aspect-[3/4] z-10 group/card cursor-pointer transition-all duration-500 hover:scale-110 hover:z-40"
            >
              <div className="size-full border-[3px] border-[#181715] bg-[#ded8ce] overflow-hidden shadow-md">
                <img
                  src={current.leftBottomImg}
                  alt="Indigenous portrait"
                  loading="lazy"
                  className="size-full object-cover"
                />
              </div>
            </div>
          </div>

          <div className="w-20 xl:w-24 shrink-0" />

          {/* 3. Center Hero Feature Frame */}
          <div
            data-card-center
            className="shrink-0 w-72 lg:w-84 xl:w-96 aspect-[4/5] z-20 group/card cursor-pointer transition-all duration-500 hover:scale-108 hover:z-40"
          >
            <div className="size-full border-[3.5px] border-[#181715] overflow-hidden shadow-md">
              <img
                src={current.centerImg}
                alt={current.centerAlt}
                loading="lazy"
                className="size-full object-cover"
              />
            </div>
          </div>

          <div className="w-20 xl:w-24 shrink-0" />

          {/* 4. Right Staggered Pair */}
          <div className="relative shrink-0 flex items-center">
            <div
              data-card-inner-pair
              className="w-44 xl:w-52 aspect-square translate-y-[-18px] group/card cursor-pointer transition-all duration-500 hover:scale-110 hover:z-30"
            >
              <div className="size-full border-[3px] border-[#181715] overflow-hidden shadow-sm">
                <img
                  src={current.rightTopImg}
                  alt="Rural facility scene"
                  loading="lazy"
                  className="size-full object-cover grayscale contrast-115"
                />
              </div>
            </div>
            <div
              data-card-inner-pair
              className="absolute left-1/2 top-6 w-40 xl:w-48 aspect-[3/4] z-10 group/card cursor-pointer transition-all duration-500 hover:scale-110 hover:z-40"
            >
              <div className="size-full border-[3px] border-[#181715] bg-[#ded8ce] overflow-hidden shadow-md">
                <img
                  src={current.rightBottomImg}
                  alt="Bamboo cane texture"
                  loading="lazy"
                  className="size-full object-cover saturate-125"
                />
              </div>
            </div>
          </div>

          {/* 5. Far Right Cut-Off Frame */}
          <div
            data-card-outer-pair
            className="shrink-0 w-32 xl:w-36 h-56 xl:h-64 -mr-12 group/card cursor-pointer transition-all duration-500 hover:scale-110 hover:z-30"
          >
            <div className="size-full border-[2.5px] border-[#181715] overflow-hidden shadow-sm">
              <img
                src={current.rightCutImg}
                alt="Craft detail"
                loading="lazy"
                className="size-full object-cover grayscale contrast-110"
              />
            </div>
          </div>
        </div>

        {/* ========================================================================= */}
        {/* MOBILE & TABLET TOUCH PHOTO SWIPER (< 1024px)                             */}
        {/* ========================================================================= */}
        <div className="block lg:hidden w-full my-4">
          <div className="-mx-4 px-4 sm:-mx-6 sm:px-6 flex gap-3.5 overflow-x-auto snap-x snap-mandatory pb-3 scrollbar-none touch-pan-x">
            <div className="w-[72vw] sm:w-[280px] shrink-0 snap-center aspect-[4/5] border-[2.5px] border-[#181715] overflow-hidden shadow-md">
              <img
                src={current.centerImg}
                alt={current.centerAlt}
                className="size-full object-cover"
              />
            </div>
            <div className="w-[60vw] sm:w-[240px] shrink-0 snap-center aspect-[3/4] border-[2.5px] border-[#181715] overflow-hidden shadow-md">
              <img
                src={current.leftBottomImg}
                alt="Indigenous artisan portrait"
                className="size-full object-cover"
              />
            </div>
            <div className="w-[60vw] sm:w-[240px] shrink-0 snap-center aspect-square border-[2.5px] border-[#181715] overflow-hidden shadow-md">
              <img
                src={current.leftTopImg}
                alt="Landscape detail"
                className="size-full object-cover grayscale"
              />
            </div>
            <div className="w-[60vw] sm:w-[240px] shrink-0 snap-center aspect-[3/4] border-[2.5px] border-[#181715] overflow-hidden shadow-md">
              <img
                src={current.rightBottomImg}
                alt="Craft texture"
                className="size-full object-cover"
              />
            </div>
          </div>
        </div>

        {/* Editorial Statement */}
        <div className="about-statement w-full flex justify-center text-center mt-4 sm:mt-6">
          <h2
            style={{
              textAlign: 'center',
              marginLeft: 'auto',
              marginRight: 'auto',
              fontFamily: "'Playfair Display', Georgia, serif",
            }}
            className="font-serif text-[clamp(1.35rem,2.8vw,2.8rem)] font-normal text-[#181715] tracking-tight leading-[1.28] max-w-4xl w-full mx-auto text-center px-2 sm:px-4 !text-center !mx-auto"
          >
            {current.statement}
          </h2>
        </div>

        {/* Bottom Controls with 48px Touch Target */}
        <div className="about-controls mt-6 pb-2 flex items-center justify-between px-2 sm:px-6 md:px-12">
          <button
            type="button"
            onClick={handlePrev}
            aria-label="Previous story slide"
            className="flex size-12 items-center justify-center text-[#181715] active:scale-95 transition-transform cursor-pointer"
          >
            <ArrowLeft className="size-6 stroke-[1.6]" />
          </button>

          <div
            className="text-center mx-auto flex flex-col items-center justify-center"
            style={{ textAlign: 'center' }}
          >
            <p
              style={{
                textAlign: 'center',
                fontFamily: "'Playfair Display', Georgia, serif",
              }}
              className="font-serif text-sm sm:text-base font-normal tracking-wide text-[#181715] text-center"
            >
              {current.title}
            </p>
            <p
              style={{
                textAlign: 'center',
                fontFamily: "'Playfair Display', Georgia, serif",
              }}
              className="font-serif text-xs sm:text-sm italic text-[#181715]/75 mt-0.5 text-center"
            >
              {current.subtitle}
            </p>
          </div>

          <button
            type="button"
            onClick={handleNext}
            aria-label="Next story slide"
            className="flex size-12 items-center justify-center text-[#181715] active:scale-95 transition-transform cursor-pointer"
          >
            <ArrowRight className="size-6 stroke-[1.6]" />
          </button>
        </div>
      </div>
    </section>
  )
}

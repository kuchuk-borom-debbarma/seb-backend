import { createFileRoute } from '@tanstack/react-router'
import { SmoothScroll } from '@/components/site/SmoothScroll'
import { Header } from '@/components/site/Header'
import { Hero } from '@/components/site/Hero'
import { About } from '@/components/site/About'
import { Project } from '@/components/site/Project'
import { Process } from '@/components/site/Process'
import { Eligibility } from '@/components/site/Eligibility'
import { Contact } from '@/components/site/Contact'
import { Footer } from '@/components/site/Footer'

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'TTAADC Mission SEP 2026 | Seed Funding for Tribal Entrepreneurs' },
      {
        name: 'description',
        content:
          'TTAADC Mission SEP 2026: Direct seed grants up to ₹5 Lakhs and institutional bank credit linkages for Scheduled Tribe entrepreneurs in Tripura.',
      },
      {
        property: 'og:title',
        content: 'TTAADC Mission SEP 2026 | Empowering Businesses',
      },
      {
        property: 'og:description',
        content:
          'Direct seed funding up to ₹5 Lakhs and bank credit linkages for Scheduled Tribe entrepreneurs in Tripura.',
      },
    ],
  }),
  component: Index,
})

function Index() {
  return (
    <SmoothScroll>
      <Header />
      <main>
        <Hero />
        <Eligibility />
        <About />
        <Project />
        <Process />
        {/* <Impact /> - Hidden until verified data is ready */}
        <Contact />
      </main>
      <Footer />
    </SmoothScroll>
  )
}

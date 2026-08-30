import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { publicAnnouncementsQuery } from '#/features/announcements/queries'
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
  // The banner arrives in the server-rendered HTML rather than as a client
  // fetch — the site's own server calls the API in-process.
  loader: ({ context }) => context.queryClient.ensureQueryData(publicAnnouncementsQuery),
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
  const { data: announcements } = useSuspenseQuery(publicAnnouncementsQuery)
  return (
    <SmoothScroll>
      <Header />
      <main>
        <Hero announcements={announcements} />
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

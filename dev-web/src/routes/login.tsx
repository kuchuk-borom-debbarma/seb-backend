import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  User,
  ShieldCheck,
  Info,
  LockKeyhole,
  HelpCircle,
} from 'lucide-react'
import { Logo } from '@/components/site/Logo'
import {
  SignInDocument,
  StartApplicantSignupDocument,
  VerifyApplicantSignupDocument,
} from '@/graphql/generated/operations'
import { formatRelative } from '@/lib/format'
import { gql } from '@/lib/graphql'
import { messageFor, unwrap } from '@/lib/result'
import { ensureSession, forgetSession, hasRole, isApplicant } from '@/lib/session'

import oneImg from '@/assets/one.png'
import twoImg from '@/assets/two.png'
import threeImg from '@/assets/three.png'
import fourImg from '@/assets/four.png'

type UserRole = 'applicant' | 'admin'

export const Route = createFileRoute('/login')({
  // The signed-in shell records the in-app address a visitor originally asked
  // for, so a successful login can return them there rather than to a generic
  // dashboard. Invalid values are discarded before any navigation happens.
  validateSearch: (search: Record<string, unknown>): { next?: string } =>
    typeof search.next === 'string' ? { next: search.next } : {},
  head: () => ({
    meta: [
      { title: 'Authentication Portal | TTAADC Mission SEP 2026' },
      {
        name: 'description',
        content:
          'Authentication portal for TTAADC Mission SEP 2026. Sign in as an applicant for seed grant DPR submissions or as an administrator.',
      },
    ],
  }),
  beforeLoad: async ({ context }) => {
    /*
     * Login is the recovery route when a session has expired, so the optional
     * identity check cannot be allowed to hide the form. A Worker restart or
     * a brief local-network failure used to turn an otherwise public page into
     * the root error screen before anyone could submit credentials.
     */
    const session = await ensureSession(context.queryClient).catch(() => null)
    if (session) {
      throw redirect({ to: isApplicant(session.user) ? '/dashboard' : '/admin' })
    }
  },
  component: LoginPage,
})

interface StorySlide {
  image: string
  alt: string
  title: string
  desc: string
}

type Challenge = { challengeToken: string; expiresAt: string }

const applicantSlides: StorySlide[] = [
  {
    image: twoImg,
    alt: 'Founders Aged 18 to 60',
    title: 'Ages 18 to 60 Years',
    desc: 'Empowering dynamic young innovators and experienced community enterprise leaders.',
  },
  {
    image: threeImg,
    alt: 'Category A and B Tracks',
    title: 'Category A & Category B',
    desc: 'Dedicated incubation tracks for fresh startups (0–24 mo) and modernization of existing units.',
  },
]

const adminSlides: StorySlide[] = [
  {
    image: oneImg,
    alt: 'DPR Scrutiny & Sanction Tracking',
    title: 'DPR Scrutiny & Evaluation',
    desc: 'Multi-tier scrutiny workflow and structured scorecards for entrepreneur seed fund applications.',
  },
  {
    image: fourImg,
    alt: 'Institutional Governance & Verification',
    title: 'Institutional Verification',
    desc: 'Direct verification of Tripura ST credentials and milestone-linked grant disbursement tracking.',
  },
]

function LoginPage() {
  const router = useRouter()
  const { next } = Route.useSearch()
  const queryClient = useQueryClient()
  const [role, setRole] = useState<UserRole>('applicant')
  const [activeSlide, setActiveSlide] = useState(0)
  const [isSignUp, setIsSignUp] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const [applicantEmail, setApplicantEmail] = useState('')
  const [applicantPassword, setApplicantPassword] = useState('')
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [otp, setOtp] = useState('')
  const [signupComplete, setSignupComplete] = useState(false)

  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')

  const activeSlides = role === 'admin' ? adminSlides : applicantSlides

  // Auto-advance left panel carousel (Desktop only)
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % activeSlides.length)
    }, 4500)
    return () => clearInterval(timer)
  }, [activeSlides.length])

  const signIn = useMutation({
    mutationFn: async () => {
      const email = role === 'admin' ? adminEmail : applicantEmail
      const password = role === 'admin' ? adminPassword : applicantPassword
      const data = await gql(SignInDocument, { email, password })
      return { signedIn: unwrap(data.auth.signIn), intendedRole: role }
    },
    onSuccess: async ({ signedIn, intendedRole }) => {
      await forgetSession(queryClient)

      const canUseOffice = hasRole(
        signedIn.user,
        'REVIEWER',
        'APPROVER',
        'ADMIN',
        'SUPER_ADMIN',
      )
      const home =
        intendedRole === 'admin' && canUseOffice
          ? '/admin'
          : isApplicant(signedIn.user)
            ? '/dashboard'
            : '/admin'
      // This is an in-app destination, never an external URL. In particular,
      // rejecting `//host` prevents a protocol-relative address from becoming
      // an open redirect if a visitor edits the query string.
      const destination = next?.startsWith('/') && !next.startsWith('//') ? next : home
      await router.navigate({ to: destination })
    },
  })

  const startSignup = useMutation({
    mutationFn: async () => {
      const data = await gql(StartApplicantSignupDocument, { email: applicantEmail })
      return unwrap(data.auth.startApplicantSignup)
    },
    onSuccess: (nextChallenge) => {
      setChallenge(nextChallenge)
      setOtp('')
      setApplicantPassword('')
    },
  })

  const verifySignup = useMutation({
    mutationFn: async () => {
      if (!challenge) throw new Error('Request a verification code first.')

      const data = await gql(VerifyApplicantSignupDocument, {
        challengeToken: challenge.challengeToken,
        otp,
        password: applicantPassword,
      })
      return unwrap(data.auth.verifyApplicantSignup)
    },
    onSuccess: async () => {
      // Account verification deliberately creates no session. Clearing the
      // cached signed-out answer ensures the next real sign-in is read fresh.
      await forgetSession(queryClient)
      setChallenge(null)
      setOtp('')
      setApplicantPassword('')
      setIsSignUp(false)
      setSignupComplete(true)
    },
  })

  const isAuthenticationPending =
    signIn.isPending || startSignup.isPending || verifySignup.isPending

  const resetFeedback = () => {
    signIn.reset()
    startSignup.reset()
    verifySignup.reset()
    setSignupComplete(false)
  }

  const handleRoleChange = (newRole: UserRole) => {
    setRole(newRole)
    setActiveSlide(0)
    setChallenge(null)
    setOtp('')
    setShowPassword(false)
    resetFeedback()
    if (newRole === 'admin') {
      setIsSignUp(false)
    }
  }

  const showApplicantSignUp = () => {
    setIsSignUp(true)
    setChallenge(null)
    setOtp('')
    setApplicantPassword('')
    setShowPassword(false)
    resetFeedback()
  }

  return (
    <div className="min-h-screen w-full flex flex-col justify-between bg-[#f6f4ef] text-[#181715] font-sans">
      {/* ========================================================================= */}
      {/* 1. TOP INSTITUTIONAL HEADER BAR                                           */}
      {/* ========================================================================= */}
      <header className="sticky top-0 z-40 w-full bg-[#0f172a] border-b border-white/10 px-4 sm:px-8 py-3.5 sm:py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          {/* Brand Logo */}
          <Link to="/" aria-label="TTAADC SEP home" className="flex items-center">
            <Logo light={true} />
          </Link>

          {/* Right Navigation Controls */}
          <div className="flex items-center gap-4 sm:gap-6">
            <Link
              to="/faq"
              style={{ color: '#ffffff', textDecoration: 'none' }}
              className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium !text-white/90 hover:!text-white transition-colors"
            >
              <HelpCircle className="size-3.5 !text-white/80" />
              <span style={{ color: 'rgba(255, 255, 255, 0.9)' }}>Helpdesk &amp; FAQs</span>
            </Link>

            <Link
              to="/"
              style={{ color: '#ffffff', textDecoration: 'none' }}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-white/10 px-3.5 py-1.5 text-xs font-semibold !text-white hover:bg-white/20 active:bg-white/25 transition-colors cursor-pointer border border-white/15"
            >
              <ArrowLeft className="size-3.5 !text-white" />
              <span style={{ color: '#ffffff' }}>Return to Main Site</span>
            </Link>
          </div>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* 2. MAIN PAGE BODY                                                         */}
      {/* ========================================================================= */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 md:p-10 lg:p-12">
        <div className="w-full max-w-md md:max-w-5xl lg:max-w-6xl overflow-hidden rounded-2xl bg-white shadow-xl border border-[#181715]/10 flex flex-col md:flex-row md:min-h-[600px]">
          {/* ======================================================================= */}
          {/* DESKTOP LEFT PANEL: Mission SEP Information & Storyboard (Hidden Mobile) */}
          {/* ======================================================================= */}
          <div
            className={`hidden md:flex relative flex-1 md:max-w-[42%] lg:max-w-[40%] p-8 sm:p-10 flex-col justify-between items-center text-center overflow-hidden transition-colors duration-500 ${
              role === 'admin' ? 'bg-[#516b75]' : 'bg-[#7d9b8e]'
            }`}
          >
            {/* Top header badge */}
            <div className="relative z-10 border-b border-white/25 pb-1.5 px-3">
              <span className="text-[11px] font-semibold tracking-wider text-white/95 uppercase">
                {role === 'admin' ? 'TTAADC Administration' : 'TTAADC Mission SEP 2026'}
              </span>
            </div>

            {/* Center Story illustration */}
            <div className="relative z-10 my-auto flex flex-col items-center justify-center w-full max-w-xs">
              <div className="relative size-48 sm:size-56 md:size-60 flex items-center justify-center transition-all duration-500">
                <img
                  key={`${role}-${activeSlide}`}
                  src={activeSlides[activeSlide]?.image}
                  alt={activeSlides[activeSlide]?.alt}
                  className="max-h-full max-w-full object-contain drop-shadow-md animate-in fade-in zoom-in-95 duration-500"
                />
              </div>

              {/* Slide Title & Description */}
              <div className="mt-4 space-y-1.5 min-h-[75px]">
                <h2
                  key={`title-${role}-${activeSlide}`}
                  className="font-serif text-lg sm:text-xl font-bold tracking-tight text-white drop-shadow-xs animate-in fade-in slide-in-from-bottom-2 duration-300"
                >
                  {activeSlides[activeSlide]?.title}
                </h2>
                <p
                  key={`desc-${role}-${activeSlide}`}
                  className="text-xs text-white/90 leading-relaxed max-w-xs mx-auto animate-in fade-in duration-500"
                >
                  {activeSlides[activeSlide]?.desc}
                </p>
              </div>
            </div>

            {/* Bottom Indicators */}
            <div className="relative z-10 flex items-center justify-center gap-2 pt-2">
              {activeSlides.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setActiveSlide(i)}
                  aria-label={`Go to slide ${i + 1}`}
                  className={`transition-all duration-300 h-1 rounded-xs cursor-pointer ${
                    activeSlide === i
                      ? 'w-6 bg-white shadow-xs'
                      : 'w-2.5 bg-white/45 hover:bg-white/70'
                  }`}
                />
              ))}
            </div>

            {/* Ambient background blur */}
            <div className="absolute -bottom-16 -left-16 size-64 rounded-full bg-white/10 blur-2xl pointer-events-none" />
            <div className="absolute -top-16 -right-16 size-64 rounded-full bg-white/10 blur-2xl pointer-events-none" />
          </div>

          {/* ======================================================================= */}
          {/* FORM PANEL: Pure Form Layout for Mobile & Desktop                       */}
          {/* ======================================================================= */}
          <div className="relative flex-1 bg-white p-5 sm:p-8 md:p-10 lg:p-12 flex flex-col justify-between overflow-y-auto">
            {/* Form Header Area */}
            <div className="w-full max-w-md mx-auto my-auto py-2">
              <div className="text-center">
                {/* Role Switcher (Clean segmented bar, no pills) */}
                <div className="w-full">
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#f1f5f9] p-1 border border-[#e2e8f0]">
                    <button
                      type="button"
                      disabled={isAuthenticationPending}
                      onClick={() => handleRoleChange('applicant')}
                      className={`flex min-h-[44px] items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md transition-all cursor-pointer disabled:cursor-wait disabled:opacity-60 ${
                        role === 'applicant'
                          ? 'bg-white text-[#0f2444] shadow-xs'
                          : 'text-[#64748b] hover:text-[#0f2444]'
                      }`}
                    >
                      <User className="size-3.5" />
                      <span>Applicant</span>
                    </button>

                    <button
                      type="button"
                      disabled={isAuthenticationPending}
                      onClick={() => handleRoleChange('admin')}
                      className={`flex min-h-[44px] items-center justify-center gap-2 py-2 px-3 text-xs font-semibold rounded-md transition-all cursor-pointer disabled:cursor-wait disabled:opacity-60 ${
                        role === 'admin'
                          ? 'bg-[#0f2444] text-white shadow-xs'
                          : 'text-[#64748b] hover:text-[#0f2444]'
                      }`}
                    >
                      <ShieldCheck className="size-3.5" />
                      <span>Administrator</span>
                    </button>
                  </div>
                </div>

                <h1 className="mt-4 font-serif text-xl sm:text-2xl font-bold tracking-tight text-[#1e293b]">
                  {role === 'admin'
                    ? 'Administrator Sign In'
                    : isSignUp
                      ? challenge
                        ? 'Verify Applicant Email'
                        : 'Create Applicant Account'
                      : 'Applicant Sign In'}
                </h1>
                <p className="mt-1 text-xs text-[#64748b]">
                  {role === 'admin'
                    ? 'Enter your official administrator email and password'
                    : isSignUp
                      ? challenge
                        ? 'Enter the code and choose the password for your account'
                        : 'Verify your email address to begin your application'
                      : 'Sign in to manage and submit your seed grant application'}
                </p>
              </div>

              {signupComplete ? (
                <div
                  className="mt-5 rounded-xl bg-[#ecfdf5] border border-[#a7f3d0] p-4 text-left"
                  role="status"
                >
                  <div className="flex items-start gap-2.5">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#059669]" />
                    <div>
                      <p className="text-xs font-bold text-[#065f46]">Account created</p>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-[#047857]">
                        Your email is verified. Sign in below with the password you just
                        chose.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              {role === 'admin' ? (
                /* ================================================================= */
                /* ADMIN AUTHENTICATION FORM (Email & Password Only)                 */
                /* ================================================================= */
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    signIn.mutate()
                  }}
                  className="mt-4 space-y-3.5"
                >
                  {/* Official Email */}
                  <div className="space-y-1">
                    <label
                      htmlFor="admin-email"
                      className="block text-[11px] font-semibold text-[#64748b]"
                    >
                      Email Address
                    </label>
                    <input
                      id="admin-email"
                      type="email"
                      required
                      disabled={signIn.isPending}
                      inputMode="email"
                      autoComplete="username"
                      value={adminEmail}
                      onChange={(e) => setAdminEmail(e.target.value)}
                      placeholder="admin@sep.com"
                      className="w-full h-11 px-3.5 rounded-lg bg-[#f8fafc] border border-[#cbd5e1] text-xs sm:text-sm text-[#1e293b] placeholder:text-[#94a3b8] outline-none transition-colors focus:border-[#0f2444] focus:bg-white"
                    />
                  </div>

                  {/* Password Input */}
                  <div className="space-y-1 relative">
                    <label
                      htmlFor="admin-password"
                      className="block text-[11px] font-semibold text-[#64748b]"
                    >
                      Password
                    </label>
                    <div className="relative">
                      <input
                        id="admin-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        disabled={signIn.isPending}
                        autoComplete="current-password"
                        value={adminPassword}
                        onChange={(e) => setAdminPassword(e.target.value)}
                        placeholder="••••••••••••"
                        className="w-full h-11 px-3.5 pr-10 rounded-lg bg-[#f8fafc] border border-[#cbd5e1] text-xs sm:text-sm text-[#1e293b] placeholder:text-[#94a3b8] outline-none transition-colors focus:border-[#0f2444] focus:bg-white"
                      />
                      <button
                        type="button"
                        disabled={signIn.isPending}
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-1 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center text-[#94a3b8] hover:text-[#475569] cursor-pointer"
                      >
                        {showPassword ? (
                          <EyeOff className="size-4" />
                        ) : (
                          <Eye className="size-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <p className="text-right text-[11px] leading-relaxed text-[#64748b]">
                    Password recovery is not available in the portal. Contact your
                    programme administrator for access help.
                  </p>

                  {signIn.isError ? (
                    <p
                      className="rounded-lg border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]"
                      role="alert"
                    >
                      {messageFor(signIn.error)}
                    </p>
                  ) : null}

                  {/* Submit Admin Button */}
                  <div className="pt-1">
                    <button
                      type="submit"
                      disabled={signIn.isPending}
                      className="w-full min-h-[48px] rounded-lg bg-[#0f2444] hover:bg-[#1e3a66] active:bg-[#0c1d37] text-white py-3 px-4 text-xs sm:text-sm font-semibold shadow-xs transition-colors disabled:opacity-75 cursor-pointer flex items-center justify-center gap-2"
                    >
                      {signIn.isPending ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="size-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          <span>Authenticating Administrator...</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <LockKeyhole className="size-4" />
                          <span>Sign In as Administrator</span>
                        </span>
                      )}
                    </button>
                  </div>

                  {/* Security Notice */}
                  <div className="mt-2.5 rounded-lg bg-[#f8fafc] border border-[#e2e8f0] p-3 text-left">
                    <div className="flex items-start gap-2">
                      <Info className="size-3.5 text-[#0f2444] shrink-0 mt-0.5" />
                      <p className="text-[10.5px] leading-relaxed text-[#475569]">
                        <strong className="text-[#0f2444]">Administrative Access:</strong>{' '}
                        Accounts with administrative roles (Admin, Approver, Reviewer,
                        Super Admin) are provisioned centrally.
                      </p>
                    </div>
                  </div>
                </form>
              ) : isSignUp ? (
                /* ================================================================= */
                /* APPLICANT REGISTRATION                                             */
                /* ================================================================= */
                challenge ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      verifySignup.mutate()
                    }}
                    className="mt-4 space-y-3.5"
                  >
                    <div className="rounded-lg border border-[#bfdbfe] bg-[#eff6ff] p-3 text-left">
                      <div className="flex items-start gap-2">
                        <Info className="mt-0.5 size-3.5 shrink-0 text-[#1d4ed8]" />
                        <p className="text-[10.5px] leading-relaxed text-[#1e40af]">
                          <strong>Read the code from the server console.</strong> This
                          local build prints the six-digit code to Wrangler instead of
                          emailing it. It expires {formatRelative(challenge.expiresAt)}.
                        </p>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor="signup-otp"
                        className="block text-[11px] font-semibold text-[#64748b]"
                      >
                        Six-digit code sent to {applicantEmail}
                      </label>
                      <input
                        id="signup-otp"
                        type="text"
                        required
                        disabled={verifySignup.isPending}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="\d{6}"
                        maxLength={6}
                        value={otp}
                        onChange={(event) => setOtp(event.target.value)}
                        className="w-full h-11 px-3.5 rounded-lg bg-[#f8fafc] border border-[#cbd5e1] text-xs sm:text-sm text-[#1e293b] outline-none transition-colors focus:border-[#0f2444] focus:bg-white"
                      />
                    </div>

                    <div className="space-y-1">
                      <label
                        htmlFor="signup-password"
                        className="block text-[11px] font-semibold text-[#64748b]"
                      >
                        Choose a password
                      </label>
                      <div className="relative">
                        <input
                          id="signup-password"
                          type={showPassword ? 'text' : 'password'}
                          required
                          disabled={verifySignup.isPending}
                          autoComplete="new-password"
                          value={applicantPassword}
                          onChange={(event) => setApplicantPassword(event.target.value)}
                          placeholder="••••••••••••"
                          className="w-full h-11 px-3.5 pr-10 rounded-lg bg-[#f8fafc] border border-[#cbd5e1] text-xs sm:text-sm text-[#1e293b] placeholder:text-[#94a3b8] outline-none transition-colors focus:border-[#0f2444] focus:bg-white"
                        />
                        <button
                          type="button"
                          disabled={verifySignup.isPending}
                          onClick={() => setShowPassword(!showPassword)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          className="absolute right-1 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center text-[#94a3b8] hover:text-[#475569] cursor-pointer"
                        >
                          {showPassword ? (
                            <EyeOff className="size-4" />
                          ) : (
                            <Eye className="size-4" />
                          )}
                        </button>
                      </div>
                    </div>

                    {verifySignup.isError ? (
                      <p
                        className="rounded-lg border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]"
                        role="alert"
                      >
                        {messageFor(verifySignup.error)}
                      </p>
                    ) : null}

                    <button
                      type="submit"
                      disabled={verifySignup.isPending}
                      className="w-full min-h-[48px] rounded-lg bg-[#0f2444] hover:bg-[#1e3a66] active:bg-[#0c1d37] text-white py-3 px-4 text-xs sm:text-sm font-semibold shadow-xs transition-colors disabled:opacity-75 cursor-pointer"
                    >
                      {verifySignup.isPending
                        ? 'Creating account...'
                        : 'Create Applicant Account'}
                    </button>
                    <button
                      type="button"
                      disabled={verifySignup.isPending}
                      onClick={() => {
                        setChallenge(null)
                        setOtp('')
                        setApplicantPassword('')
                        verifySignup.reset()
                      }}
                      className="w-full min-h-[44px] rounded-lg border border-[#cbd5e1] bg-white px-4 py-2.5 text-xs font-semibold text-[#334155] hover:bg-[#f8fafc] cursor-pointer"
                    >
                      Use a different email address
                    </button>
                  </form>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      startSignup.mutate()
                    }}
                    className="mt-4 space-y-3.5"
                  >
                    <div className="space-y-1">
                      <label
                        htmlFor="signup-email"
                        className="block text-[11px] font-semibold text-[#64748b]"
                      >
                        Email Address
                      </label>
                      <input
                        id="signup-email"
                        type="email"
                        required
                        disabled={startSignup.isPending}
                        inputMode="email"
                        autoComplete="username"
                        value={applicantEmail}
                        onChange={(event) => setApplicantEmail(event.target.value)}
                        placeholder="applicant@example.com"
                        className="w-full h-11 px-3.5 rounded-lg bg-[#f8fafc] border border-[#cbd5e1] text-xs sm:text-sm text-[#1e293b] placeholder:text-[#94a3b8] outline-none transition-colors focus:border-[#0f2444] focus:bg-white"
                      />
                    </div>

                    {startSignup.isError ? (
                      <p
                        className="rounded-lg border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]"
                        role="alert"
                      >
                        {messageFor(startSignup.error)}
                      </p>
                    ) : null}

                    <button
                      type="submit"
                      disabled={startSignup.isPending}
                      className="w-full min-h-[48px] rounded-lg bg-[#0f2444] hover:bg-[#1e3a66] active:bg-[#0c1d37] text-white py-3 px-4 text-xs sm:text-sm font-semibold shadow-xs transition-colors disabled:opacity-75 cursor-pointer"
                    >
                      {startSignup.isPending
                        ? 'Sending verification code...'
                        : 'Send verification code'}
                    </button>
                  </form>
                )
              ) : (
                /* ================================================================= */
                /* APPLICANT SIGN IN                                                 */
                /* ================================================================= */
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    signIn.mutate()
                  }}
                  className="mt-4 space-y-3.5"
                >
                  <div className="space-y-1">
                    <label
                      htmlFor="applicant-email"
                      className="block text-[11px] font-semibold text-[#64748b]"
                    >
                      Email Address
                    </label>
                    <input
                      id="applicant-email"
                      type="email"
                      required
                      disabled={signIn.isPending}
                      inputMode="email"
                      autoComplete="username"
                      value={applicantEmail}
                      onChange={(event) => setApplicantEmail(event.target.value)}
                      placeholder="applicant@sep.com"
                      className="w-full h-11 px-3.5 rounded-lg bg-[#f8fafc] border border-[#cbd5e1] text-xs sm:text-sm text-[#1e293b] placeholder:text-[#94a3b8] outline-none transition-colors focus:border-[#0f2444] focus:bg-white"
                    />
                  </div>

                  <div className="space-y-1">
                    <label
                      htmlFor="applicant-password"
                      className="block text-[11px] font-semibold text-[#64748b]"
                    >
                      Password
                    </label>
                    <div className="relative">
                      <input
                        id="applicant-password"
                        type={showPassword ? 'text' : 'password'}
                        required
                        disabled={signIn.isPending}
                        autoComplete="current-password"
                        value={applicantPassword}
                        onChange={(event) => setApplicantPassword(event.target.value)}
                        placeholder="••••••••••••"
                        className="w-full h-11 px-3.5 pr-10 rounded-lg bg-[#f8fafc] border border-[#cbd5e1] text-xs sm:text-sm text-[#1e293b] placeholder:text-[#94a3b8] outline-none transition-colors focus:border-[#0f2444] focus:bg-white"
                      />
                      <button
                        type="button"
                        disabled={signIn.isPending}
                        onClick={() => setShowPassword(!showPassword)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        className="absolute right-1 top-1/2 -translate-y-1/2 size-9 flex items-center justify-center text-[#94a3b8] hover:text-[#475569] cursor-pointer"
                      >
                        {showPassword ? (
                          <EyeOff className="size-4" />
                        ) : (
                          <Eye className="size-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  <p className="text-right text-[11px] leading-relaxed text-[#64748b]">
                    Password recovery is not available yet.
                  </p>

                  {signIn.isError ? (
                    <p
                      className="rounded-lg border border-[#fecaca] bg-[#fef2f2] p-3 text-xs text-[#991b1b]"
                      role="alert"
                    >
                      {messageFor(signIn.error)}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    disabled={signIn.isPending}
                    className="w-full min-h-[48px] rounded-lg bg-[#0f2444] hover:bg-[#1e3a66] active:bg-[#0c1d37] text-white py-3 px-4 text-xs sm:text-sm font-semibold shadow-xs transition-colors disabled:opacity-75 cursor-pointer"
                  >
                    {signIn.isPending ? 'Signing in...' : 'Sign In as Applicant'}
                  </button>
                </form>
              )}
            </div>

            {/* Bottom Switcher */}
            <div className="text-center text-xs text-[#64748b] pt-3">
              {role === 'admin' ? (
                <p>
                  Not an administrator?{' '}
                  <button
                    type="button"
                    disabled={isAuthenticationPending}
                    onClick={() => handleRoleChange('applicant')}
                    className="font-bold text-[#0f2444] hover:underline cursor-pointer py-1"
                  >
                    Switch to Applicant Sign In
                  </button>
                </p>
              ) : isSignUp ? (
                <p>
                  Already have an account?{' '}
                  <button
                    type="button"
                    disabled={isAuthenticationPending}
                    onClick={() => {
                      setIsSignUp(false)
                      setChallenge(null)
                      setOtp('')
                      setApplicantPassword('')
                      setShowPassword(false)
                      resetFeedback()
                    }}
                    className="font-bold text-[#0f2444] hover:underline cursor-pointer py-1"
                  >
                    Sign In
                  </button>
                </p>
              ) : (
                <p>
                  New applicant?{' '}
                  <button
                    type="button"
                    disabled={isAuthenticationPending}
                    onClick={showApplicantSignUp}
                    className="font-bold text-[#0f2444] hover:underline cursor-pointer py-1"
                  >
                    Create Account
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* ========================================================================= */}
      {/* 3. PAGE FOOTER                                                            */}
      {/* ========================================================================= */}
      <footer className="w-full border-t border-[#181715]/10 bg-white/70 py-4 px-4 sm:px-8 text-center text-xs text-[#64748b]">
        <div className="mx-auto flex max-w-7xl flex-col sm:flex-row items-center justify-between gap-2.5">
          <p>
            &copy; 2026 Industry Department, Tripura Tribal Areas Autonomous District
            Council (TTAADC).
          </p>
          <div className="flex items-center gap-4 text-[11px] font-medium">
            <a
              href="/policy.pdf"
              target="_blank"
              rel="noreferrer"
              className="hover:text-[#0f2444] transition-colors"
            >
              Policy PDF
            </a>
            <span>/</span>
            <Link to="/faq" className="hover:text-[#0f2444] transition-colors">
              FAQs
            </Link>
            <span>/</span>
            <a
              href="mailto:sep@ttaadc.gov.in"
              className="hover:text-[#0f2444] transition-colors"
            >
              sep@ttaadc.gov.in
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}

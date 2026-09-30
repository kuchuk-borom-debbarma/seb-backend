import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { useHydrated } from '#/lib/hydration'
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
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
import {
  belongsInTheOffice,
  ensureSession,
  forgetSession,
  isApplicant,
} from '@/lib/session'

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

type Challenge = { challengeToken: string; expiresAt: string; delivery: string }

function LoginPage() {
  const router = useRouter()
  const { next } = Route.useSearch()
  const queryClient = useQueryClient()
  // Disabled until hydrated: typing before then was wiped by hydration and a
  // quick submit sent an empty form. See `useHydrated`.
  const hydrated = useHydrated()
  const [role, setRole] = useState<UserRole>('applicant')
  const [isSignUp, setIsSignUp] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const [applicantEmail, setApplicantEmail] = useState('')
  const [applicantPassword, setApplicantPassword] = useState('')
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [otp, setOtp] = useState('')
  const [signupComplete, setSignupComplete] = useState(false)

  const [adminEmail, setAdminEmail] = useState('')
  const [adminPassword, setAdminPassword] = useState('')

  const signIn = useMutation({
    mutationFn: async () => {
      const email = role === 'admin' ? adminEmail : applicantEmail
      const password = role === 'admin' ? adminPassword : applicantPassword
      const data = await gql(SignInDocument, { email, password })
      return { signedIn: unwrap(data.auth.signIn), intendedRole: role }
    },
    onSuccess: async ({ signedIn, intendedRole }) => {
      await forgetSession(queryClient)

      /*
       * Asked the same way the office door asks it. This was a written list of
       * the six fixed roles, and the office composes its own now — so the list
       * matched only `SUPER_ADMIN`, and everybody else picking the office tab
       * was quietly sent to the applicant portal instead.
       */
      const home =
        intendedRole === 'admin' && belongsInTheOffice(signedIn.user)
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
              <span style={{ color: 'rgba(255, 255, 255, 0.9)' }}>
                Helpdesk &amp; FAQs
              </span>
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
        <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl border border-[#181715]/10">
          <div className="bg-white p-5 sm:p-8 md:p-10 flex flex-col justify-between">
            {/* Form Header Area */}
            <div className="w-full max-w-md mx-auto my-auto py-2">
              <div className="text-center">
                <h1 className="mt-4 font-serif text-xl sm:text-2xl font-bold tracking-tight text-[#1e293b]">
                  {isSignUp
                    ? challenge
                      ? 'Verify Your Email'
                      : 'Create Account'
                    : 'Sign In'}
                </h1>
                <p className="mt-1 text-xs text-[#64748b]">
                  {isSignUp
                    ? challenge
                      ? 'Enter the code and choose the password for your account'
                      : 'Verify your email address to begin your application'
                    : 'Sign in with your email and password'}
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
                >
                  <fieldset
                    disabled={!hydrated}
                    className="m-0 min-w-0 border-0 p-0 mt-4 space-y-3.5"
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
                      <Link
                        to="/forgot-password"
                        className="font-semibold text-[#0f2444] hover:underline"
                      >
                        Forgot your password?
                      </Link>
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
                          <strong className="text-[#0f2444]">
                            Administrative Access:
                          </strong>{' '}
                          Accounts with administrative roles (Admin, Approver, Reviewer,
                          Super Admin) are provisioned centrally.
                        </p>
                      </div>
                    </div>
                  </fieldset>
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
                  >
                    <fieldset
                      disabled={!hydrated}
                      className="m-0 min-w-0 border-0 p-0 mt-4 space-y-3.5"
                    >
                      <div className="rounded-lg border border-[#bfdbfe] bg-[#eff6ff] p-3 text-left">
                        <div className="flex items-start gap-2">
                          <Info className="mt-0.5 size-3.5 shrink-0 text-[#1d4ed8]" />
                          <p className="text-[10.5px] leading-relaxed text-[#1e40af]">
                            {challenge.delivery === 'CONSOLE' ? (
                              <>
                                <strong>Read the code from the server console.</strong>{' '}
                                This development server prints the six-digit code to its
                                log instead of emailing it.
                              </>
                            ) : (
                              <>
                                <strong>Check your inbox.</strong> We emailed a six-digit
                                code to the address you entered.
                              </>
                            )}{' '}
                            It expires {formatRelative(challenge.expiresAt)}.
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
                    </fieldset>
                  </form>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault()
                      startSignup.mutate()
                    }}
                  >
                    <fieldset
                      disabled={!hydrated}
                      className="m-0 min-w-0 border-0 p-0 mt-4 space-y-3.5"
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
                    </fieldset>
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
                >
                  <fieldset
                    disabled={!hydrated}
                    className="m-0 min-w-0 border-0 p-0 mt-4 space-y-3.5"
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
                      <Link
                        to="/forgot-password"
                        className="font-semibold text-[#0f2444] hover:underline"
                      >
                        Forgot your password?
                      </Link>
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
                      {signIn.isPending ? 'Signing in...' : 'Sign In'}
                    </button>
                  </fieldset>
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

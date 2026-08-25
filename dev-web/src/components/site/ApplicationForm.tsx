import { useState } from 'react'
import {
  FileCheck2,
  Building,
  User,
  IndianRupee,
  Landmark,
  Layers,
  Paperclip,
  CheckCircle,
  Download,
  Send,
  Sparkles,
} from 'lucide-react'
import { Reveal } from './Reveal'

const sectorsList = [
  'Agriculture & Allied',
  'Handloom, Textile & Handicrafts',
  'Food Processing',
  'Tourism & Hospitality',
  'Information Tech',
  'Manufacturing & Services',
  'Others',
]

const attachmentsList = [
  { id: 'id_proof', label: 'Proof of Identity & Age (Aadhaar Card / Voter ID)' },
  {
    id: 'st_cert',
    label: 'ST Certificate issued by competent Tripura State authorities',
  },
  {
    id: 'addr_proof',
    label: 'Address Proof / Village Committee Certificate inside TTAADC',
  },
  { id: 'biz_reg', label: 'Business Registration (CIN / Partnership Deed / Udyam)' },
  { id: 'gstin', label: 'GST Registration Certificate (if applicable)' },
  {
    id: 'dpr',
    label: 'Detailed Project Report (DPR) formatted under Section 6 Guidelines',
  },
  { id: 'bank_proof', label: 'Bank Details (Copy of Bank Passbook / Cancelled Cheque)' },
  {
    id: 'noc',
    label: 'No Objection Certificate (NOC) from local Village Committee / Council',
  },
]

export function ApplicationForm() {
  const [currentSection, setCurrentSection] = useState(1)
  const [submitted, setSubmitted] = useState(false)

  // Form State
  const [formData, setFormData] = useState({
    // Section 1
    businessName: '',
    incDate: '',
    cinUdyam: '',
    gstin: '',
    sector: 'Agriculture & Allied',
    otherSector: '',
    category: 'Category A', // Category A (New Venture) | Category B (Expansion)
    // Section 2
    applicantName: '',
    designation: 'Proprietor',
    dob: '',
    gender: 'Male',
    stCertificateNo: '',
    address: '',
    district: 'West Tripura',
    pinCode: '',
    phone: '',
    email: '',
    // Section 3
    totalProjectCost: '',
    seedFundRequested: '500000',
    bankLoanProposed: '',
    promoterContribution: '',
    // Section 4
    priorSubsidy: 'NO',
    subsidyDetails: '',
    priorLoan: 'NO',
    loanDetails: '',
    loanStatus: 'Standard',
    // Section 5
    isExpansion: 'NO',
    sanctionOrderNo: '',
    sanctionDate: '',
    firstDisbursedAmount: '',
    operationMonths: '',
    // Section 6 Checklist
    attachments: {
      id_proof: true,
      st_cert: true,
      addr_proof: true,
      biz_reg: false,
      gstin: false,
      dpr: true,
      bank_proof: true,
      noc: false,
    } as Record<string, boolean>,
    // Section 7
    declarationName: '',
    parentName: '',
    declarationAgreed: false,
  })

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => {
    const { name, value } = e.target
    setFormData((prev) => ({ ...prev, [name]: value }))
  }

  const handleCheckboxToggle = (id: string) => {
    setFormData((prev) => ({
      ...prev,
      attachments: {
        ...prev.attachments,
        [id]: !prev.attachments[id],
      },
    }))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.declarationAgreed) {
      alert('Please check and accept the solemn declaration to proceed.')
      return
    }
    setSubmitted(true)
  }

  const handleDownloadApplicationDraft = () => {
    const draftText = `================================================================================
OFFICIAL APPLICATION SUBMISSION DRAFT: TTAADC MISSION SEP (2026)
Industry Department, Tripura Tribal Areas Autonomous District Council (TTAADC)
================================================================================

SECTION 1: ENTERPRISE & REGISTRATION DETAILS
- Proposed/Existing Business Name: ${formData.businessName || 'N/A'}
- Date of Incorporation/Establishment: ${formData.incDate || 'N/A'}
- CIN / Udyam Registration No.: ${formData.cinUdyam || 'N/A'}
- GSTIN: ${formData.gstin || 'N/A'}
- Business Category / Sector: ${formData.sector === 'Others' ? formData.otherSector : formData.sector}
- Nature of Application: ${formData.category}

SECTION 2: POINT OF CONTACT & PROMOTER PROFILE
- Primary Applicant Lead: ${formData.applicantName || 'N/A'}
- Designation: ${formData.designation}
- Date of Birth: ${formData.dob || 'N/A'}
- Gender: ${formData.gender}
- ST Certificate No.: ${formData.stCertificateNo || 'N/A'}
- Address within TTAADC: ${formData.address || 'N/A'}, District: ${formData.district}, Pin: ${formData.pinCode || 'N/A'}
- Phone: ${formData.phone || 'N/A'}
- Email: ${formData.email || 'N/A'}

SECTION 3: FINANCIAL REQUIREMENTS & PROJECT COSTS
- Total Estimated Project Cost: ₹${formData.totalProjectCost || '0'}
- TTAADC Seed Fund Requested: ₹${formData.seedFundRequested || '0'} (Max ₹5,00,000)
- Proposed Partner Bank Loan: ₹${formData.bankLoanProposed || '0'}
- Promoter's Own Contribution: ₹${formData.promoterContribution || '0'}

SECTION 4: PRIOR FUNDING & BANKING DISCLOSURE
- Prior Govt Subsidy Received: ${formData.priorSubsidy} (${formData.subsidyDetails || 'None'})
- Existing Bank Loans: ${formData.priorLoan} (${formData.loanDetails || 'None'} - Status: ${formData.loanStatus})

SECTION 5: SECOND-TRANCHE / EXPANSION DETAILS
- 12-Month Expansion Application: ${formData.isExpansion}
- Previous Sanction Order No.: ${formData.sanctionOrderNo || 'N/A'} (Date: ${formData.sanctionDate || 'N/A'})
- First Installment Disbursed: ₹${formData.firstDisbursedAmount || '0'}
- Continuous Operating Period: ${formData.operationMonths || '0'} Months

SECTION 6: ATTACHMENTS VERIFIED
${attachmentsList.map((a) => `- [${formData.attachments[a.id] ? 'X' : ' '}] ${a.label}`).join('\n')}

SECTION 7: APPLICANT UNDERTAKING
- Declarant: ${formData.declarationName || formData.applicantName}
- Relation (Son/Daughter/Spouse of): ${formData.parentName}
- Status: Solemn Declaration Verified & Signed Digitally
================================================================================`

    const blob = new Blob([draftText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `TTAADC_Mission_SEP_Application_${formData.applicantName.replace(/\s+/g, '_') || 'Form'}.txt`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const sectionsNav = [
    { num: 1, label: 'Enterprise Details', icon: Building },
    { num: 2, label: 'Promoter Profile', icon: User },
    { num: 3, label: 'Financials & Cost', icon: IndianRupee },
    { num: 4, label: 'Prior Disclosure', icon: Landmark },
    { num: 5, label: 'Expansion Track', icon: Layers },
    { num: 6, label: 'Attachments', icon: Paperclip },
    { num: 7, label: 'Declaration', icon: FileCheck2 },
  ]

  return (
    <section id="apply" className="bg-background relative border-t border-line">
      <div className="mx-auto max-w-[1500px] px-6 py-24 md:px-10 md:py-32">
        <Reveal>
          <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-primary">
                Single-Window Digital Portal
              </p>
              <h2 className="mt-5 text-[clamp(2rem,3.6vw,3rem)] font-extrabold leading-[1.12] tracking-tight text-primary">
                Official Application Form
                <br />
                TTAADC Mission SEP (2026).
              </h2>
              <div className="rule-line mt-7" />
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full bg-emerald-100 px-3.5 py-1.5 text-xs font-bold text-emerald-800 flex items-center gap-1.5">
                <Sparkles className="size-3.5" /> Direct Seed Support: Up to ₹5,00,000
              </span>
            </div>
          </div>
        </Reveal>

        {submitted ? (
          <div className="mt-14 rounded-2xl border border-emerald-300 bg-emerald-50/70 p-8 md:p-12 text-center">
            <div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-600 text-white">
              <CheckCircle className="size-9" />
            </div>
            <h3 className="mt-6 text-2xl md:text-3xl font-extrabold text-emerald-950">
              Application Successfully Submitted!
            </h3>
            <p className="mx-auto mt-3 max-w-xl text-[16px] text-emerald-900/80">
              Your application for{' '}
              <strong>{formData.businessName || 'your enterprise'}</strong> has been
              registered on the TTAADC single-window portal under Reference ID:{' '}
              <strong>SEP-2026-{(Math.random() * 90000 + 10000).toFixed(0)}</strong>.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-4">
              <button
                type="button"
                onClick={handleDownloadApplicationDraft}
                className="inline-flex items-center gap-2 rounded-full bg-emerald-800 px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-emerald-900"
              >
                <Download className="size-4" />
                <span>Download Submission Receipt (.txt)</span>
              </button>
              <button
                type="button"
                onClick={() => setSubmitted(false)}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-700 px-6 py-3 text-sm font-semibold text-emerald-900 transition-all hover:bg-emerald-100"
              >
                <span>Edit / Submit Another Form</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-12 grid gap-8 lg:grid-cols-12">
            {/* Step Navigation Rail */}
            <div className="lg:col-span-4">
              <div className="sticky top-28 rounded-2xl border border-line bg-secondary/30 p-5">
                <p className="text-xs font-extrabold uppercase tracking-wider text-primary/70 mb-4 px-2">
                  Application Sections
                </p>
                <div className="space-y-1.5">
                  {sectionsNav.map((sec) => (
                    <button
                      key={sec.num}
                      type="button"
                      onClick={() => setCurrentSection(sec.num)}
                      className={`w-full flex items-center gap-3.5 rounded-xl px-4 py-3 text-left transition-all ${
                        currentSection === sec.num
                          ? 'bg-primary text-white font-bold shadow-xs'
                          : 'text-foreground/80 hover:bg-secondary font-medium'
                      }`}
                    >
                      <sec.icon className="size-4.5 shrink-0" />
                      <span className="text-[14px]">
                        Section {sec.num}: {sec.label}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-6 rounded-xl border border-line bg-background p-4 text-[13px] leading-relaxed text-foreground/75">
                  <p className="font-bold text-primary">Need Help?</p>
                  <p className="mt-1">
                    Applications are appraised monthly by the{' '}
                    <strong>Department of Industries, TTAADC, Khumulwng</strong>.
                  </p>
                </div>
              </div>
            </div>

            {/* Form Fields Body */}
            <div className="lg:col-span-8">
              <form
                onSubmit={handleSubmit}
                className="rounded-2xl border border-line bg-background p-6 md:p-10 shadow-xs"
              >
                {/* SECTION 1 */}
                {currentSection === 1 && (
                  <div className="space-y-6">
                    <div className="border-b border-line pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        Section 1
                      </span>
                      <h3 className="text-xl font-bold text-primary">
                        Enterprise & Registration Details
                      </h3>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="sm:col-span-2">
                        <label className="block text-sm font-semibold text-foreground/90">
                          1.1 Proposed / Existing Business Name *
                        </label>
                        <input
                          type="text"
                          name="businessName"
                          value={formData.businessName}
                          onChange={handleChange}
                          placeholder="e.g. Khumpui Agro Processing Unit"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          1.2 Date of Incorporation / Setup
                        </label>
                        <input
                          type="date"
                          name="incDate"
                          value={formData.incDate}
                          onChange={handleChange}
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          1.3 CIN / Udyam Registration No.
                        </label>
                        <input
                          type="text"
                          name="cinUdyam"
                          value={formData.cinUdyam}
                          onChange={handleChange}
                          placeholder="UDYAM-TR-00-0000000 (if available)"
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          1.4 GSTIN (If registered)
                        </label>
                        <input
                          type="text"
                          name="gstin"
                          value={formData.gstin}
                          onChange={handleChange}
                          placeholder="16AAAAA0000A1Z5"
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          1.5 Business Category / Sector *
                        </label>
                        <select
                          name="sector"
                          value={formData.sector}
                          onChange={handleChange}
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        >
                          {sectorsList.map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="sm:col-span-2">
                        <label className="block text-sm font-semibold text-foreground/90">
                          1.6 Nature of Application *
                        </label>
                        <div className="mt-2 grid gap-3 sm:grid-cols-2">
                          <label
                            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-all ${
                              formData.category === 'Category A'
                                ? 'border-primary bg-primary/5 text-primary font-bold'
                                : 'border-line text-foreground/75'
                            }`}
                          >
                            <input
                              type="radio"
                              name="category"
                              value="Category A"
                              checked={formData.category === 'Category A'}
                              onChange={handleChange}
                              className="mt-1"
                            />
                            <div>
                              <p className="text-sm">Category A: New Venture</p>
                              <p className="text-xs font-normal opacity-80 mt-0.5">
                                Proposed or registered entity up to 24 months old.
                              </p>
                            </div>
                          </label>

                          <label
                            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-all ${
                              formData.category === 'Category B'
                                ? 'border-primary bg-primary/5 text-primary font-bold'
                                : 'border-line text-foreground/75'
                            }`}
                          >
                            <input
                              type="radio"
                              name="category"
                              value="Category B"
                              checked={formData.category === 'Category B'}
                              onChange={handleChange}
                              className="mt-1"
                            />
                            <div>
                              <p className="text-sm">Category B: Business Expansion</p>
                              <p className="text-xs font-normal opacity-80 mt-0.5">
                                Operating continuously for over 24 months.
                              </p>
                            </div>
                          </label>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* SECTION 2 */}
                {currentSection === 2 && (
                  <div className="space-y-6">
                    <div className="border-b border-line pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        Section 2
                      </span>
                      <h3 className="text-xl font-bold text-primary">
                        Point of Contact (PoC) & Promoter Profile
                      </h3>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          2.1 Primary Applicant / Enterprise Lead *
                        </label>
                        <input
                          type="text"
                          name="applicantName"
                          value={formData.applicantName}
                          onChange={handleChange}
                          placeholder="Full Name as per Aadhaar"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          2.2 Designation *
                        </label>
                        <select
                          name="designation"
                          value={formData.designation}
                          onChange={handleChange}
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        >
                          <option value="Proprietor">Proprietor</option>
                          <option value="Managing Partner">Managing Partner</option>
                          <option value="Director">Director</option>
                          <option value="Authorized Signatory">
                            Authorized Signatory
                          </option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          2.3 Date of Birth (Age 18 - 60) *
                        </label>
                        <input
                          type="date"
                          name="dob"
                          value={formData.dob}
                          onChange={handleChange}
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          2.4 Gender *
                        </label>
                        <select
                          name="gender"
                          value={formData.gender}
                          onChange={handleChange}
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        >
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>

                      <div className="sm:col-span-2">
                        <label className="block text-sm font-semibold text-foreground/90">
                          2.5 Community / ST Certificate No. *
                        </label>
                        <input
                          type="text"
                          name="stCertificateNo"
                          value={formData.stCertificateNo}
                          onChange={handleChange}
                          placeholder="e.g. ST/SDM/SDR/2023/1234 (Tripura State Issued)"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                        <p className="mt-1 text-xs text-foreground/60">
                          Applicant must belong to a recognised Scheduled Tribe of Tripura
                          and hold majority stake.
                        </p>
                      </div>

                      <div className="sm:col-span-2">
                        <label className="block text-sm font-semibold text-foreground/90">
                          2.6 Business Address within TTAADC *
                        </label>
                        <textarea
                          name="address"
                          value={formData.address}
                          onChange={handleChange}
                          rows={2}
                          placeholder="Village, Block, Gram Panchayat inside TTAADC area"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          District inside Tripura *
                        </label>
                        <select
                          name="district"
                          value={formData.district}
                          onChange={handleChange}
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        >
                          <option value="West Tripura">
                            West Tripura (Khumulwng HQ)
                          </option>
                          <option value="North Tripura">
                            North Tripura (Kanchanpur)
                          </option>
                          <option value="Dhalai">Dhalai (Ambassa)</option>
                          <option value="Sipahijala">Sipahijala (Bishramganj)</option>
                          <option value="Gomati">Gomati (Killa/Amarpur)</option>
                          <option value="Khowai">Khowai (Padmabil)</option>
                          <option value="South Tripura">
                            South Tripura (Birchandra Manu)
                          </option>
                          <option value="Unokoti">Unokoti (Kumarghat)</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          Primary Contact Number *
                        </label>
                        <input
                          type="tel"
                          name="phone"
                          value={formData.phone}
                          onChange={handleChange}
                          placeholder="+91 98765 43210"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* SECTION 3 */}
                {currentSection === 3 && (
                  <div className="space-y-6">
                    <div className="border-b border-line pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        Section 3
                      </span>
                      <h3 className="text-xl font-bold text-primary">
                        Financial Requirements & Project Costs
                      </h3>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          3.1 Total Estimated Project Cost (₹) *
                        </label>
                        <input
                          type="number"
                          name="totalProjectCost"
                          value={formData.totalProjectCost}
                          onChange={handleChange}
                          placeholder="e.g. 1000000"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          3.2 TTAADC Seed Fund Requested (Max ₹5,00,000) *
                        </label>
                        <input
                          type="number"
                          name="seedFundRequested"
                          max="500000"
                          value={formData.seedFundRequested}
                          onChange={handleChange}
                          placeholder="Up to 500000"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          3.3 Proposed Partner Bank Loan Component (₹)
                        </label>
                        <input
                          type="number"
                          name="bankLoanProposed"
                          value={formData.bankLoanProposed}
                          onChange={handleChange}
                          placeholder="e.g. 400000 (Forwarded for bank review)"
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          3.4 Promoter's Own Contribution (₹) *
                        </label>
                        <input
                          type="number"
                          name="promoterContribution"
                          value={formData.promoterContribution}
                          onChange={handleChange}
                          placeholder="e.g. 100000"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>
                    </div>

                    <div className="rounded-lg border border-sky-200 bg-sky-50/60 p-4 text-[13.5px] leading-relaxed text-sky-900">
                      <strong>Section 3.1 Policy Rule:</strong> The final grant
                      determination is made by the{' '}
                      <em>TTAADC Transformation Mission (TTM)</em> based on verified CAPEX
                      + OPEX allocations in your DPR.
                    </div>
                  </div>
                )}

                {/* SECTION 4 */}
                {currentSection === 4 && (
                  <div className="space-y-6">
                    <div className="border-b border-line pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        Section 4
                      </span>
                      <h3 className="text-xl font-bold text-primary">
                        Prior Funding & Banking Disclosure
                      </h3>
                    </div>

                    <div className="space-y-5">
                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          4.1 Have you or your enterprise previously received any
                          Government Subsidy/Grant?
                        </label>
                        <div className="mt-2 flex gap-4">
                          <label className="flex items-center gap-2 text-sm font-medium">
                            <input
                              type="radio"
                              name="priorSubsidy"
                              value="NO"
                              checked={formData.priorSubsidy === 'NO'}
                              onChange={handleChange}
                            />
                            NO
                          </label>
                          <label className="flex items-center gap-2 text-sm font-medium">
                            <input
                              type="radio"
                              name="priorSubsidy"
                              value="YES"
                              checked={formData.priorSubsidy === 'YES'}
                              onChange={handleChange}
                            />
                            YES
                          </label>
                        </div>
                        {formData.priorSubsidy === 'YES' && (
                          <input
                            type="text"
                            name="subsidyDetails"
                            value={formData.subsidyDetails}
                            onChange={handleChange}
                            placeholder="Scheme Name, Sanctioned Amount (₹), and Sanction Year"
                            className="mt-2 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                          />
                        )}
                      </div>

                      <div className="border-t border-line pt-4">
                        <label className="block text-sm font-semibold text-foreground/90">
                          4.2 Do you or your enterprise have any existing commercial bank
                          loans / credit facilities?
                        </label>
                        <div className="mt-2 flex gap-4">
                          <label className="flex items-center gap-2 text-sm font-medium">
                            <input
                              type="radio"
                              name="priorLoan"
                              value="NO"
                              checked={formData.priorLoan === 'NO'}
                              onChange={handleChange}
                            />
                            NO
                          </label>
                          <label className="flex items-center gap-2 text-sm font-medium">
                            <input
                              type="radio"
                              name="priorLoan"
                              value="YES"
                              checked={formData.priorLoan === 'YES'}
                              onChange={handleChange}
                            />
                            YES
                          </label>
                        </div>
                        {formData.priorLoan === 'YES' && (
                          <div className="mt-2 grid gap-3 sm:grid-cols-2">
                            <input
                              type="text"
                              name="loanDetails"
                              value={formData.loanDetails}
                              onChange={handleChange}
                              placeholder="Bank Name & Sanctioned Amount (₹)"
                              className="w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                            />
                            <select
                              name="loanStatus"
                              value={formData.loanStatus}
                              onChange={handleChange}
                              className="w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                            >
                              <option value="Standard">Account Status: Standard</option>
                              <option value="NPA">Account Status: NPA</option>
                            </select>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* SECTION 5 */}
                {currentSection === 5 && (
                  <div className="space-y-6">
                    <div className="border-b border-line pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        Section 5
                      </span>
                      <h3 className="text-xl font-bold text-primary">
                        Second-Tranche / Expansion Applicants Only
                      </h3>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-foreground/90">
                        5.1 Is this an application for 12-Month Expansion Funding under
                        Mission SEP?
                      </label>
                      <div className="mt-2 flex gap-4">
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input
                            type="radio"
                            name="isExpansion"
                            value="NO"
                            checked={formData.isExpansion === 'NO'}
                            onChange={handleChange}
                          />
                          NO (First-time Applicant)
                        </label>
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input
                            type="radio"
                            name="isExpansion"
                            value="YES"
                            checked={formData.isExpansion === 'YES'}
                            onChange={handleChange}
                          />
                          YES (Phase-II Expansion)
                        </label>
                      </div>
                    </div>

                    {formData.isExpansion === 'YES' && (
                      <div className="grid gap-4 sm:grid-cols-2 rounded-xl border border-line bg-secondary/20 p-5">
                        <div>
                          <label className="block text-xs font-bold text-foreground/80">
                            5.2 First Sanction Order No.
                          </label>
                          <input
                            type="text"
                            name="sanctionOrderNo"
                            value={formData.sanctionOrderNo}
                            onChange={handleChange}
                            placeholder="TTAADC/IND/SEP/2024/..."
                            className="mt-1 w-full rounded-lg border border-line bg-background px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-foreground/80">
                            First Sanction Date
                          </label>
                          <input
                            type="date"
                            name="sanctionDate"
                            value={formData.sanctionDate}
                            onChange={handleChange}
                            className="mt-1 w-full rounded-lg border border-line bg-background px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-foreground/80">
                            5.3 First Installment Disbursed (₹)
                          </label>
                          <input
                            type="number"
                            name="firstDisbursedAmount"
                            value={formData.firstDisbursedAmount}
                            onChange={handleChange}
                            placeholder="e.g. 250000"
                            className="mt-1 w-full rounded-lg border border-line bg-background px-3 py-2 text-sm"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-foreground/80">
                            5.4 Months of Continuous Operation (Min. 12)
                          </label>
                          <input
                            type="number"
                            name="operationMonths"
                            value={formData.operationMonths}
                            onChange={handleChange}
                            placeholder="Min 12 Months required"
                            className="mt-1 w-full rounded-lg border border-line bg-background px-3 py-2 text-sm"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* SECTION 6 */}
                {currentSection === 6 && (
                  <div className="space-y-6">
                    <div className="border-b border-line pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        Section 6
                      </span>
                      <h3 className="text-xl font-bold text-primary">
                        Mandatory Attachments Checklist
                      </h3>
                    </div>

                    <p className="text-sm text-foreground/75">
                      Verify that you possess valid copies of all mandatory documents
                      prior to final submission:
                    </p>

                    <div className="space-y-3">
                      {attachmentsList.map((item) => (
                        <label
                          key={item.id}
                          className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3.5 transition-colors hover:bg-secondary/30"
                        >
                          <input
                            type="checkbox"
                            checked={!!formData.attachments[item.id]}
                            onChange={() => handleCheckboxToggle(item.id)}
                            className="mt-1 size-4 rounded text-primary"
                          />
                          <span className="text-sm font-medium text-foreground/90">
                            {item.label}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* SECTION 7 */}
                {currentSection === 7 && (
                  <div className="space-y-6">
                    <div className="border-b border-line pb-4">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        Section 7
                      </span>
                      <h3 className="text-xl font-bold text-primary">
                        Applicant Declaration & Undertaking
                      </h3>
                    </div>

                    <div className="rounded-xl border border-line bg-secondary/30 p-5 text-[13.5px] leading-relaxed text-foreground/85">
                      <p>
                        I hereby solemnly declare that all statements and documents
                        submitted in this application under{' '}
                        <strong>Mission SEP (TTAADC)</strong> are true, complete, and
                        accurate to the best of my knowledge.
                      </p>
                      <p className="mt-2">
                        I understand that if any information is found to be false or
                        misleading, my application will be canceled immediately, and any
                        seed funds disbursed will be subject to recovery under law. I
                        authorize TTAADC to verify these details and forward my profile to
                        partner banking institutions for credit evaluation.
                      </p>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          Full Name of Declarant *
                        </label>
                        <input
                          type="text"
                          name="declarationName"
                          value={formData.declarationName || formData.applicantName}
                          onChange={handleChange}
                          placeholder="Your Full Name"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-sm font-semibold text-foreground/90">
                          Son / Daughter / Spouse of *
                        </label>
                        <input
                          type="text"
                          name="parentName"
                          value={formData.parentName}
                          onChange={handleChange}
                          placeholder="Parent or Spouse Name"
                          required
                          className="mt-1.5 w-full rounded-lg border border-line bg-background px-4 py-2.5 text-sm focus:border-primary focus:outline-none"
                        />
                      </div>
                    </div>

                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
                      <input
                        type="checkbox"
                        checked={formData.declarationAgreed}
                        onChange={(e) =>
                          setFormData((p) => ({
                            ...p,
                            declarationAgreed: e.target.checked,
                          }))
                        }
                        required
                        className="mt-1 size-4 rounded text-primary"
                      />
                      <span className="text-sm font-semibold text-primary">
                        I solemnly accept the terms, recovery obligations, and data
                        verification conditions of TTAADC Mission SEP 2026.
                      </span>
                    </label>
                  </div>
                )}

                {/* Form Navigation Buttons */}
                <div className="mt-8 flex items-center justify-between border-t border-line pt-6">
                  {currentSection > 1 ? (
                    <button
                      type="button"
                      onClick={() => setCurrentSection((c) => c - 1)}
                      className="rounded-full border border-line px-6 py-2.5 text-sm font-semibold text-foreground/80 hover:bg-secondary"
                    >
                      ← Back
                    </button>
                  ) : (
                    <div />
                  )}

                  {currentSection < 7 ? (
                    <button
                      type="button"
                      onClick={() => setCurrentSection((c) => c + 1)}
                      className="rounded-full bg-primary px-7 py-2.5 text-sm font-semibold text-white shadow-xs hover:bg-primary/90"
                    >
                      Next Section →
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-full bg-primary px-8 py-3 text-sm font-bold text-white shadow-md hover:bg-primary/90 hover:-translate-y-0.5 transition-all"
                    >
                      <Send className="size-4" />
                      <span>Submit Application</span>
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

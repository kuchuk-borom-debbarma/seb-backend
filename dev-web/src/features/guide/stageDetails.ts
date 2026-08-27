import type { ApplicationStatus } from '#/graphql/generated/schema'
import { DESKS, type Desk } from './tours'

export type StageDetail = {
  id: ApplicationStatus
  number: string
  name: string
  desk: Desk
  shortDescription: string
  fullDescription: string
  applicantQuote: {
    text: string
    waitingOn: string
  }
  aboutStage: Array<{
    icon: 'check' | 'document' | 'clock' | 'rupee' | 'bank' | 'user' | 'alert'
    text: string
  }>
  keyScreens: string[]
}

export const STAGE_DETAILS: StageDetail[] = [
  {
    id: 'DRAFT',
    number: '01',
    name: 'Draft',
    desk: DESKS.applicant,
    shortDescription:
      'The applicant is answering the cycle\u2019s stages and attaching evidence.',
    fullDescription:
      'The applicant fills in the enterprise profile, personal details, project costs, prior funding records, and uploads required identity and business documents. Work is autosaved privately.',
    applicantQuote: {
      text: 'You are working on this application. It has not yet been submitted to the office.',
      waitingOn: 'You (Applicant)',
    },
    aboutStage: [
      {
        icon: 'document',
        text: 'The cycle\u2019s own stages ensure all required statutory details are provided.',
      },
      {
        icon: 'check',
        text: 'Autosaves immediately as answers change, preventing any loss of work.',
      },
      {
        icon: 'user',
        text: 'Private to the applicant — nobody at the programme office can view a draft.',
      },
    ],
    keyScreens: [
      'Applicant dashboard → Start application',
      'Application form → 6 categories',
      'Attach evidence documents',
    ],
  },
  {
    id: 'SUBMITTED',
    number: '02',
    name: 'Submitted',
    desk: DESKS.office,
    shortDescription: 'A copy is frozen and a reference number issued.',
    fullDescription:
      'The applicant creates a formal submission. A permanent snapshot of all answers and evidence is frozen, a unique tracking reference number is minted, and it enters the intake queue.',
    applicantQuote: {
      text: 'Your application has been received and is waiting in the intake queue for assignment.',
      waitingOn: 'Programme office',
    },
    aboutStage: [
      {
        icon: 'check',
        text: 'Issues a permanent single reference number (e.g. SEP-2026-XXXXX).',
      },
      {
        icon: 'document',
        text: 'Freezes a cryptographic audit snapshot of all answers and evidence files.',
      },
      {
        icon: 'clock',
        text: 'Enters the programme office intake queue for officer assignment.',
      },
    ],
    keyScreens: [
      'All applications → Intake queue',
      'Application case overview',
    ],
  },
  {
    id: 'DESK_REVIEW',
    number: '03',
    name: 'Desk review',
    desk: DESKS.office,
    shortDescription: 'A named officer works through nine checks.',
    fullDescription:
      'A named desk review officer holds the application and systematically evaluates nine statutory checks covering identity, ST certificate validity, enterprise eligibility, jurisdiction inside TTAADC areas, document authenticity, and the detailed project report.',
    applicantQuote: {
      text: 'A reviewer is checking your answers, eligibility, and documents.',
      waitingOn: 'Programme office',
    },
    aboutStage: [
      {
        icon: 'check',
        text: 'Nine checks are recorded together with the outcome. A review cannot be left half-saved.',
      },
      {
        icon: 'document',
        text: 'If corrections are needed, specific sections are named and returned to the applicant.',
      },
      {
        icon: 'clock',
        text: 'Once cleared, the application moves to the partner bank for assessment.',
      },
    ],
    keyScreens: [
      'All applications → Desk review queue',
      'Application case → Desk review stage',
    ],
  },
  {
    id: 'REVISION_REQUIRED',
    number: '04',
    name: 'Correction asked for',
    desk: DESKS.applicant,
    shortDescription:
      'The office named specific sections. Only those unlock.',
    fullDescription:
      'The reviewing officer identified discrepancies or missing details and requested revisions. The office specifies exact sections that require changes; only those unlock for editing while other verified facts remain protected.',
    applicantQuote: {
      text: 'The programme office returned your application for corrections on specific sections.',
      waitingOn: 'You (Applicant)',
    },
    aboutStage: [
      {
        icon: 'alert',
        text: 'Specific sections requiring correction are highlighted with detailed officer feedback.',
      },
      {
        icon: 'document',
        text: 'Only unlocked sections can be edited; verified sections remain locked.',
      },
      {
        icon: 'check',
        text: 'Resubmission returns the file directly to the reviewing officer.',
      },
    ],
    keyScreens: [
      'Applicant dashboard → Needs attention',
      'Application form → Unlocked sections',
    ],
  },
  {
    id: 'PARTNER_BANK_EVALUATION',
    number: '05',
    name: 'With a partner bank',
    desk: DESKS.bank,
    shortDescription: 'A bank evaluates the proposal and writes back.',
    fullDescription:
      'A nominated partner bank evaluates the viability of the proposed project, credit history, promoter equity, and business financials, then records a formal appraisal report back to the programme office.',
    applicantQuote: {
      text: 'A partner bank is assessing your project proposal and viability.',
      waitingOn: 'Partner bank',
    },
    aboutStage: [
      {
        icon: 'bank',
        text: 'Financial appraisal and credit checks performed by the assigned partner bank.',
      },
      {
        icon: 'document',
        text: 'Bank enters formal evaluation remarks and recommendation into the system.',
      },
      {
        icon: 'clock',
        text: 'Prepares the application file for the programme office\u2019s formal decision.',
      },
    ],
    keyScreens: [
      'Partner bank queue → Pending evaluations',
      'Application case → Bank appraisal',
    ],
  },
  {
    id: 'AWAITING_DECISION',
    number: '06',
    name: 'Awaiting a decision',
    desk: DESKS.office,
    shortDescription: 'The file is complete and waits for the recorded decision.',
    fullDescription:
      'Desk findings and the partner bank\u2019s report are before the programme office, which records the formal decision \u2014 approval with an amount, rejection with a catalogued reason, or a request to defer \u2014 against the submitted application.',
    applicantQuote: {
      text: 'Your application is with the programme office for a decision.',
      waitingOn: 'Programme office',
    },
    aboutStage: [
      {
        icon: 'user',
        text: 'Everything gathered so far \u2014 the desk review and the bank report \u2014 travels with the file.',
      },
      {
        icon: 'check',
        text: 'A decision names its approved amount or its reason, and is recorded permanently.',
      },
      {
        icon: 'document',
        text: 'Records approval amount or grounds for deferral/rejection in official minutes.',
      },
    ],
    keyScreens: [
      'Intake queue → Awaiting decision',
      'Meeting session → Decision recording',
    ],
  },
  {
    id: 'APPROVED',
    number: '07',
    name: 'Approved',
    desk: DESKS.office,
    shortDescription: 'The programme office approved an amount.',
    fullDescription:
      'The programme office has formally approved seed funding for the enterprise, recording the sanctioned amount, special conditions, and preparing the legal sanction agreement.',
    applicantQuote: {
      text: 'Congratulations! Your application has been approved by the programme office.',
      waitingOn: 'Programme office',
    },
    aboutStage: [
      {
        icon: 'check',
        text: 'Official approval recorded against the verified meeting minutes.',
      },
      {
        icon: 'rupee',
        text: 'Approved grant amount is committed in the cycle budget ledger.',
      },
      {
        icon: 'document',
        text: 'Triggers preparation of the legal agreement and formal sanction order.',
      },
    ],
    keyScreens: [
      'Approved applications list',
      'Sanction preparation workflow',
    ],
  },
  {
    id: 'SANCTIONED',
    number: '08',
    name: 'Sanctioned',
    desk: DESKS.office,
    shortDescription:
      'A sanction order exists. Conditions must be met before payments.',
    fullDescription:
      'A formal sanction order has been issued. The applicant and office execute the bilateral grant agreement, verify bank account penny-drop details, and ensure all pre-disbursement compliance conditions are satisfied.',
    applicantQuote: {
      text: 'A formal sanction order is issued. Complete the agreement to receive funds.',
      waitingOn: 'Programme office & Applicant',
    },
    aboutStage: [
      {
        icon: 'document',
        text: 'Formal sanction order and grant agreement executed.',
      },
      {
        icon: 'bank',
        text: 'Bank account validation and beneficiary account verification completed.',
      },
      {
        icon: 'clock',
        text: 'Prepares the schedule of release instalments and milestones.',
      },
    ],
    keyScreens: [
      'Sanctions register',
      'Disbursement preparation queue',
    ],
  },
  {
    id: 'DISBURSED',
    number: '09',
    name: 'Money released',
    desk: DESKS.office,
    shortDescription:
      'Instalments have been paid. Evidence of utilization is required.',
    fullDescription:
      'Seed grant instalments are transferred directly to the verified enterprise bank account. The entrepreneur submits utilization certificates and milestone evidence as agreed in the scheme charter.',
    applicantQuote: {
      text: 'Funds have been disbursed to your account. Submit utilization evidence as required.',
      waitingOn: 'You (Applicant)',
    },
    aboutStage: [
      {
        icon: 'rupee',
        text: 'Direct Benefit Transfer (DBT) executed to the enterprise account.',
      },
      {
        icon: 'document',
        text: 'Payment reference and UTR numbers recorded in audit trail.',
      },
      {
        icon: 'check',
        text: 'Tracks utilization proof, invoices, and physical asset geotags.',
      },
    ],
    keyScreens: [
      'Disbursement & payment ledger',
      'Utilization certificate tracking',
    ],
  },
  {
    id: 'REJECTED',
    number: '10',
    name: 'Rejected',
    desk: DESKS.office,
    shortDescription: 'Closed without funding, with the reason recorded.',
    fullDescription:
      'The application was closed without grant approval following desk review or the recorded decision. A formal notice with catalogued statutory reasons is recorded and communicated.',
    applicantQuote: {
      text: 'Your application was not approved. The recorded reason is available in your file.',
      waitingOn: 'Closed',
    },
    aboutStage: [
      {
        icon: 'alert',
        text: 'Specific statutory reason selected from the programme cycle catalogue.',
      },
      {
        icon: 'document',
        text: 'Official notice issued with full audit notes preserved.',
      },
      {
        icon: 'check',
        text: 'Enterprise remains eligible to apply in future programme cycles.',
      },
    ],
    keyScreens: [
      'Closed applications archive',
      'Reason catalogue and rejection audit',
    ],
  },
  {
    id: 'CANCELLED',
    number: '11',
    name: 'Cancelled',
    desk: DESKS.office,
    shortDescription: 'Withdrawn before a decision. The record is kept.',
    fullDescription:
      'The application was withdrawn upon request by the applicant or cancelled due to cycle closure prior to a final decision. Full historic records and submitted files are permanently preserved.',
    applicantQuote: {
      text: 'The application was withdrawn or cancelled. The historical record is preserved.',
      waitingOn: 'Closed',
    },
    aboutStage: [
      {
        icon: 'document',
        text: 'Withdrawn by applicant or superceded by newer cycle submission.',
      },
      {
        icon: 'check',
        text: 'Permanent audit record kept with no negative impact on future eligibility.',
      },
    ],
    keyScreens: [
      'Cancelled applications archive',
      'Audit log and change history',
    ],
  },
]

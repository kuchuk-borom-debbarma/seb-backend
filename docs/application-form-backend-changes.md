# Application form backend changes

This record describes the breaking backend and persistence changes made for the
seven-stage application journey. It complements the user-facing
[application guide](application-guide.md) and is the compatibility checklist for
API clients and local development databases.

## Breaking GraphQL removals

The declaration section is no longer part of the portal application record.
The schema removes:

- `DECLARATION` from `ApplicationSection`;
- the `RelationshipType` enum;
- `DeclarationInput` and `DeclarationSnapshot`;
- `ApplicationDraftInput.declaration`;
- `ApplicationSnapshot.declaration`; and
- `ApplicationSnapshot.declarationAcceptedAt`.

An older client that still selects those snapshot fields or sends a
`declaration` input fails GraphQL document validation. Clients must regenerate
their operations against the current schema. Administrative revision choices,
application events, change comparisons, and section lists use the remaining
section vocabulary.

## Persistence removals

`seb_application_version` no longer contains:

- `relationship_type`;
- `related_person_name`;
- `declaration_accepted`;
- `declaration_accepted_at`; or
- `declaration_place`.

The corresponding declaration constraints are gone. `DECLARATION` is also
removed from the allowed section values on revision requests and application
events. `database/schema.sql` has been regenerated from the Drizzle schema.

This repository has no durable deployed database and no migration chain, so the
canonical empty-database baseline was updated instead of adding a migration.
The baseline uses `IF NOT EXISTS`, which cannot change a table already present
in a local D1 database. Existing local databases must be recreated:

```sh
rm -rf .wrangler
npm run db:setup:local
```

Do not apply that deletion to a database that must be retained. Once a durable
database exists, this kind of change requires an explicit migration and a data
retention decision.

## New server-side rules

The service, not the browser, remains authoritative for every rule below.

### Copied enterprise data

When a draft starts, business name, establishment date, registration type and
number, GSTIN, sector, and other-sector description are copied from the current
enterprise profile. A draft save is rejected if it changes any of them. Editing
the canonical enterprise later continues to affect only future applications,
not an existing snapshot. Application category and majority-ownership
confirmation remain applicant answers.

### Registered identity email

The application contact email is always initialized from the signed-in user's
verified portal identity. A draft save is rejected unless its registered email
matches that identity. An enterprise profile's contact email is not used as a
substitute.

### District

Enterprise profiles and application owner/address details accept only these
eight official Tripura districts, in alphabetical order:

- Dhalai
- Gomati
- Khowai
- North Tripura
- Sepahijala
- South Tripura
- Unakoti
- West Tripura

The Drizzle schema adds matching district constraints to enterprise and
application versions. The list follows the districts published by the
[Government of Tripura](https://agrilicense.tripura.gov.in/agricultureLMS/frmDashboard).

### Contact number

Enterprise and application contact numbers normalize spaces, hyphens, and
parentheses. The normalized value must contain exactly ten digits. A country
prefix such as `+91`, nine digits, eleven digits, or other characters is
rejected.

### Government-support sanction year

`governmentFundingSanctionYear` must be an integer from 1900 through 2026,
inclusive. The database applies the same bounds to application versions. No
year field has been added for existing bank credit.

## Submission and revision compatibility

Submission and resubmission no longer require, normalize, timestamp, or persist
a declaration. Formal snapshots contain the remaining answers and the exact
document versions. Change comparison and revision scoping cannot name the
removed section. Review and submitted summaries consume the same reduced
snapshot shape.

The removal of the paper-form declaration is an explicit user-approved portal
policy divergence, recorded in the
[policy-alignment crosswalk](policy-alignment.md).

PRAGMA foreign_keys = ON;

CREATE TABLE applicant (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'APPLICANT' CHECK (role = 'APPLICANT'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Raw session tokens live only in browser cookies. D1 stores HMAC digests.
CREATE TABLE applicant_session (
  id TEXT PRIMARY KEY NOT NULL,
  applicant_id TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY (applicant_id) REFERENCES applicant(id) ON DELETE CASCADE
);

CREATE INDEX applicant_session_applicant_idx
  ON applicant_session(applicant_id);
CREATE INDEX applicant_session_expiry_idx
  ON applicant_session(expires_at);

-- Repeated signup starts create independent rows containing only keyed digests.
CREATE TABLE applicant_signup_pair (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  challenge_digest TEXT NOT NULL UNIQUE,
  otp_digest TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts_remaining INTEGER NOT NULL CHECK (attempts_remaining BETWEEN 1 AND 20),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX applicant_signup_pair_email_idx
  ON applicant_signup_pair(email);
CREATE INDEX applicant_signup_pair_expiry_idx
  ON applicant_signup_pair(expires_at);

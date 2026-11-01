-- Bill Splitter schema.
-- All money is stored as integer cents. Timestamps are ISO 8601 strings (or NULL while unpaid).

CREATE TABLE homes (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE members (
  id      TEXT PRIMARY KEY,
  home_id TEXT NOT NULL REFERENCES homes(id),
  name    TEXT NOT NULL
);

CREATE INDEX idx_members_home ON members(home_id);

CREATE TABLE bills (
  id          TEXT PRIMARY KEY,
  home_id     TEXT NOT NULL REFERENCES homes(id),
  title       TEXT NOT NULL,
  total_cents INTEGER NOT NULL CHECK (total_cents > 0)
);

CREATE INDEX idx_bills_home ON bills(home_id);

CREATE TABLE shares (
  id              TEXT PRIMARY KEY,
  bill_id         TEXT NOT NULL REFERENCES bills(id),
  member_id       TEXT NOT NULL REFERENCES members(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_at         TEXT,
  idempotency_key TEXT,
  UNIQUE (bill_id, member_id)
);

CREATE INDEX idx_shares_bill ON shares(bill_id);
CREATE INDEX idx_shares_member ON shares(member_id);

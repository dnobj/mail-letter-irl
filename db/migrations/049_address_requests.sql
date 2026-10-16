-- 049: address requests (#604, concept 10 in docs/letter-creator-vision.md).
--
-- A sender who lacks someone's address makes a request. Letter IRL hands the
-- sender a private link once and keeps only the SHA-256 of its token. The
-- person the sender shares it with opens it on the website, signed out, and
-- gives a U.S. address or declines. Either closes the request: an answer or a
-- decline moves the row out of 'waiting' in one UPDATE that requires
-- 'waiting', so a link is used once. A CHECK ties the address to 'answered'.
--
-- 'expired' is not stored: a waiting request past expires_at reads as expired
-- (src/services/addressRequestService.ts), as a held letter reads as
-- scheduled.
--
-- The address is a third party's, given for one sender's mail. Erasure keeps
-- the users row, so the account's erasure deletes its requests explicitly
-- (accountErasureService); the sweep that deletes closed requests comes with
-- the public routes (#604).
--
-- Every object named here comes from 001, so the commerce ACID legacy replay,
-- which runs later migrations without 022 and 023, needs no to_regclass
-- guard. New string columns are TEXT: a parameter bound to a varchar column
-- and compared with a literal is refused by PostgreSQL. user_id matches
-- users.user_id, as every other account table's does.
--
-- Safe for the running image: it creates a table nothing reads yet.

CREATE TABLE address_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(255) NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  -- SHA-256 of the link's token. The token itself is never stored.
  token_hash BYTEA NOT NULL,
  -- What the sender calls the recipient, for the envelope unless the
  -- recipient gives another name.
  recipient_name TEXT NOT NULL,
  -- All the page shows of the sender.
  sender_first_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  -- The address given, in the preview tools' recipient shape.
  address JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  CONSTRAINT address_requests_token_hash_key UNIQUE (token_hash),
  CONSTRAINT valid_address_request_token_hash CHECK (octet_length(token_hash) = 32),
  CONSTRAINT valid_address_request_status CHECK (status IN ('waiting', 'answered', 'declined', 'cancelled')),
  CONSTRAINT valid_address_request_address CHECK ((status = 'answered') = (address IS NOT NULL)),
  CONSTRAINT valid_address_request_closed CHECK ((status = 'waiting') = (closed_at IS NULL)),
  CONSTRAINT valid_address_request_names CHECK (
    char_length(recipient_name) BETWEEN 1 AND 100
    AND char_length(sender_first_name) BETWEEN 1 AND 40
  ),
  CONSTRAINT valid_address_request_expiry CHECK (expires_at > created_at)
);

-- The caps count an account's waiting requests and its requests of the last
-- day.
CREATE INDEX idx_address_requests_user_created ON address_requests (user_id, created_at DESC);

COMMENT ON TABLE address_requests IS
  'Address request links (#604): a sender asks someone for their address; the token is stored hashed, and a request is answered or declined once.';

-- 050: a saved signature (#608, concept 3 in docs/letter-creator-vision.md).
--
-- A person saves a picture of their handwritten signature once, with
-- set_signature or on the website. The server cleans it into a grayscale PNG
-- of dark ink on white, cropped to the ink and at most 1200 x 400 pixels
-- (src/services/signatureImage.ts), and keeps only that: one row per account.
-- A letter draws it from a copy taken into its draft (#608's later parts), so
-- replacing or removing the saved one never changes a draft already previewed.
--
-- use_by_default is the account's remembered choice (Principle 4): true when a
-- signature is saved, then whatever the last preview chose.
--
-- A signature is the account's own data, kept until the person removes it or
-- deletes the account. Erasure keeps the users row, so it deletes this row
-- explicitly (accountErasureService), as it does address requests.
--
-- Every object named here comes from 001, so the commerce ACID legacy replay,
-- which runs later migrations without 022 and 023, needs no to_regclass
-- guard. user_id matches users.user_id, as every other account table's does.
--
-- Safe for the running image: it creates a table nothing reads yet.

CREATE TABLE user_signatures (
  user_id VARCHAR(255) PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  -- The cleaned signature: a PNG, by its own first eight bytes.
  image_png BYTEA NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  use_by_default BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_user_signature_png CHECK (
    octet_length(image_png) BETWEEN 8 AND 1048576
    AND substring(image_png FROM 1 FOR 8) = decode('89504e470d0a1a0a', 'hex')
  ),
  CONSTRAINT valid_user_signature_size CHECK (width BETWEEN 1 AND 1200 AND height BETWEEN 1 AND 400),
  CONSTRAINT valid_user_signature_times CHECK (updated_at >= created_at)
);

COMMENT ON TABLE user_signatures IS
  'A saved signature (#608): one cleaned grayscale PNG per account, kept until the person removes it or the account is erased.';

-- 037: personal access tokens carry scopes, and none of them sends (#470).
--
-- A personal access token used to carry no scopes and pass every scope check,
-- mail:send included, so an agent holding one could send letters and spend the
-- person's balance with nobody looking. Every token, existing and new, now
-- reads and drafts only. An agent on a token that wants to send gets the link
-- where the person sends it themselves on letterirl.com (the send rule,
-- docs/letter-send-flow.md).
--
-- mail:send stays an allowed value, so a later, explicit "may send without
-- confirming" token can be granted without another migration. Nothing grants
-- it today.

ALTER TABLE personal_access_tokens
  ADD COLUMN IF NOT EXISTS scopes TEXT[] NOT NULL
    DEFAULT ARRAY['mail:read', 'mail:draft']::TEXT[];

ALTER TABLE personal_access_tokens
  DROP CONSTRAINT IF EXISTS pat_scopes_known;
ALTER TABLE personal_access_tokens
  ADD CONSTRAINT pat_scopes_known
    CHECK (scopes <@ ARRAY['mail:read', 'mail:draft', 'mail:send']::TEXT[]);

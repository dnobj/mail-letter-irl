-- 031: take provider text out of the three error columns operators read (#162, audit A-08).
--
-- A definite provider rejection stored the provider's message verbatim in
-- letter_jobs.last_error (and its legacy twin error_message), orders.last_error
-- and commerce_order_events.metadata->'error'. PostGrid's validation messages
-- name the field and the value that failed, so a rejected letter could leave a
-- fragment of a recipient's address in three columns the admin reader role can
-- select and two pages render. The ambiguous and exception paths already stored
-- an error class only; the definite path now does the same
-- (letterJobService via summarizeProviderRejection): "provider_rejected http_<status>".
--
-- This rewrites the historic rows to that form. The predicate is the provider
-- message shape itself, "HTTP <three digits>", so nothing else is touched: an
-- internal or database error message stays as it was. Like 030, this overwrite
-- is deliberate and irreversible; the status code is the operational signal and
-- the message was the leak. Idempotent: a rewritten value no longer matches.
UPDATE letter_jobs
   SET last_error = 'provider_rejected http_' || substring(last_error from '^HTTP (\d{3})'),
       updated_at = NOW()
 WHERE last_error ~ '^HTTP \d{3}';

UPDATE letter_jobs
   SET error_message = 'provider_rejected http_' || substring(error_message from '^HTTP (\d{3})'),
       updated_at = NOW()
 WHERE error_message ~ '^HTTP \d{3}';

UPDATE orders
   SET last_error = 'provider_rejected http_' || substring(last_error from '^HTTP (\d{3})'),
       updated_at = NOW()
 WHERE last_error ~ '^HTTP \d{3}';

UPDATE commerce_order_events
   SET metadata = (metadata - 'error')
                  || jsonb_build_object('errorClass',
                       'provider_rejected http_' || substring(metadata->>'error' from '^HTTP (\d{3})'))
 WHERE event_type = 'provider.terminal_failure'
   AND metadata->>'error' ~ '^HTTP \d{3}';

COMMENT ON COLUMN letter_jobs.last_error IS
  'Error class and provider status only (e.g. provider_rejected http_400). Never provider message text: it can carry recipient address fragments. See migration 031.';
COMMENT ON COLUMN orders.last_error IS
  'Error class and provider status only for provider failures (e.g. provider_rejected http_400). Never provider message text. See migration 031.';

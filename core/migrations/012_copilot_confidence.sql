-- Keep the validated numeric value used by JCS/verdict_hash without rounding at persistence.
-- Existing numeric(4,3) values are preserved; previously lost digits cannot be recovered here.
ALTER TABLE copilot_verdicts
  ALTER COLUMN confidence TYPE numeric USING confidence::numeric;

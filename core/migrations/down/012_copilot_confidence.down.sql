-- Check under the same exclusive lock as the conversion, so concurrent appends cannot
-- introduce a value that would be silently rounded after the precision check.
LOCK TABLE copilot_verdicts IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM copilot_verdicts WHERE confidence <> round(confidence, 3)) THEN
    RAISE EXCEPTION 'copilot_confidence_precision_loss' USING ERRCODE = '22003';
  END IF;
END;
$$;
ALTER TABLE copilot_verdicts
  ALTER COLUMN confidence TYPE numeric(4,3) USING confidence::numeric(4,3);

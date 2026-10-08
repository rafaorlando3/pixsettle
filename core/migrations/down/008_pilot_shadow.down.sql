-- Remove only E1 shadow storage; no payment core or attested v1 data is read or written.
DROP TABLE pilot_shadow_events;
DROP TABLE pilot_shadow_batches;
DROP TABLE pilot_shadow_streams;
DROP FUNCTION pilot_shadow_immutable();
DROP FUNCTION pilot_shadow_checkpoint_monotonic();

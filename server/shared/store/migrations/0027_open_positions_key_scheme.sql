-- #686: mark which idempotency-key derivation a row's key was computed under.
--
-- The key gained a `side` ('open' | 'close') discriminator, so a key computed
-- before this migration can never match one computed after it for the same
-- (instrument, bar). That is not a cosmetic difference: a crash-replay spanning
-- the cutover would miss in `findByKey`, raise no `open_positions` primary-key
-- conflict, and present the broker a `client_order_id` it has not seen — a
-- double order with all three dedup layers passing it, because all three read
-- the same key.
--
-- `DEFAULT 2` then `UPDATE ... = 1` is deliberate and the order matters: the
-- ALTER backfills every EXISTING row with 2, and the UPDATE immediately
-- corrects them to 1, leaving the default in place for every row written from
-- now on. Doing it the other way (DEFAULT 1) would silently stamp new rows as
-- pre-cutover forever, which is the failure this column exists to detect.
ALTER TABLE open_positions ADD COLUMN key_scheme INTEGER NOT NULL DEFAULT 2;

UPDATE open_positions SET key_scheme = 1;

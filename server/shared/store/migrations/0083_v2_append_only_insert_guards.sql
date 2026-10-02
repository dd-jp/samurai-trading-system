CREATE TRIGGER IF NOT EXISTS v2_reconciles_no_replace
BEFORE INSERT ON v2_reconciles
WHEN NEW.reconcile_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_reconciles WHERE reconcile_id = NEW.reconcile_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_reconciles is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_news_no_replace
BEFORE INSERT ON v2_news
WHEN NEW.news_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_news WHERE news_id = NEW.news_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_news is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signal_events_no_replace
BEFORE INSERT ON v2_signal_events
WHEN NEW.event_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_signal_events WHERE event_id = NEW.event_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_signal_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_controls_no_replace
BEFORE INSERT ON v2_controls
WHEN (NEW.control_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_controls WHERE control_id = NEW.control_id))
   OR EXISTS (SELECT 1 FROM v2_controls WHERE idempotency_key = NEW.idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'v2_controls is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_commands_no_replace
BEFORE INSERT ON v2_commands
WHEN (NEW.command_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_commands WHERE command_id = NEW.command_id))
   OR EXISTS (SELECT 1 FROM v2_commands WHERE update_id = NEW.update_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_commands is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_signals_no_replace
BEFORE INSERT ON v2_signals
WHEN EXISTS (SELECT 1 FROM v2_signals WHERE signal_id = NEW.signal_id)
   OR EXISTS (SELECT 1 FROM v2_signals WHERE payload_digest = NEW.payload_digest)
BEGIN
  SELECT RAISE(ABORT, 'v2_signals is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_trials_no_replace
BEFORE INSERT ON v2_trials
WHEN EXISTS (SELECT 1 FROM v2_trials WHERE config_hash = NEW.config_hash)
BEGIN
  SELECT RAISE(ABORT, 'v2_trials is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_faults_no_replace
BEFORE INSERT ON v2_faults
WHEN NEW.fault_id IS NOT NULL AND EXISTS (SELECT 1 FROM v2_faults WHERE fault_id = NEW.fault_id)
BEGIN
  SELECT RAISE(ABORT, 'v2_faults is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_faults_replay_ignored
BEFORE INSERT ON v2_faults
WHEN EXISTS (
  SELECT 1 FROM v2_faults
  WHERE kind = NEW.kind AND trading_date = NEW.trading_date AND code = NEW.code AND detail = NEW.detail
)
BEGIN
  SELECT RAISE(IGNORE);
END;

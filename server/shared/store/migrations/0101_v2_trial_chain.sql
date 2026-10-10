CREATE TABLE IF NOT EXISTS v2_trial_chain (
  trial  INTEGER PRIMARY KEY REFERENCES v2_trials (trial),
  link   TEXT NOT NULL CHECK (length(link) = 64)
);

CREATE TRIGGER IF NOT EXISTS v2_trial_chain_no_update
BEFORE UPDATE ON v2_trial_chain
BEGIN
  SELECT RAISE(ABORT, 'v2_trial_chain is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_trial_chain_no_delete
BEFORE DELETE ON v2_trial_chain
BEGIN
  SELECT RAISE(ABORT, 'v2_trial_chain is append-only');
END;

CREATE TRIGGER IF NOT EXISTS v2_trial_chain_contiguous
BEFORE INSERT ON v2_trial_chain
WHEN NEW.trial <> (SELECT COALESCE(MAX(trial), 0) + 1 FROM v2_trial_chain)
BEGIN
  SELECT RAISE(ABORT, 'v2_trial_chain: links are contiguous from trial 1');
END;

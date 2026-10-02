-- #1980: a failed call (billed or not) is a row with error_class set and no response, and
-- stop_reason lets a replay serve a refusal as a refusal. error_message holds only the thrown
-- error's message, masked; request headers and keys are never written.
ALTER TABLE llm_call_log ADD COLUMN stop_reason TEXT;
ALTER TABLE llm_call_log ADD COLUMN error_class TEXT;
ALTER TABLE llm_call_log ADD COLUMN error_message TEXT;

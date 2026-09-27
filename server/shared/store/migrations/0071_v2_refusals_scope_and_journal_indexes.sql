ALTER TABLE v2_refusals ADD COLUMN book_id TEXT;
ALTER TABLE v2_refusals ADD COLUMN instrument TEXT;

CREATE INDEX IF NOT EXISTS idx_v2_decisions_trading_date ON v2_decisions (trading_date);
CREATE INDEX IF NOT EXISTS idx_v2_orders_trading_date ON v2_orders (trading_date);
CREATE INDEX IF NOT EXISTS idx_v2_orders_decision_id ON v2_orders (decision_id);
CREATE INDEX IF NOT EXISTS idx_v2_fills_client_order_id ON v2_fills (client_order_id);
CREATE INDEX IF NOT EXISTS idx_v2_refusals_trading_date ON v2_refusals (trading_date);

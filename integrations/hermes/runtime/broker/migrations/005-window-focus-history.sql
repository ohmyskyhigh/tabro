ALTER TABLE logical_windows ADD COLUMN last_focused_at TEXT;

UPDATE logical_windows
SET last_focused_at = last_observed_at
WHERE focused = 1;

CREATE INDEX IF NOT EXISTS idx_logical_windows_focus_history
ON logical_windows(endpoint_ref, eligible, last_focused_at DESC, window_ref);

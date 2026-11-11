ALTER TABLE browser_input_states RENAME TO browser_input_states_by_window;
CREATE TABLE browser_input_states (
  tab_ref TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL
);
INSERT INTO browser_input_states(tab_ref,state_json)
  SELECT json_extract(state_json, '$.tabRef'), state_json FROM browser_input_states_by_window;
DROP TABLE browser_input_states_by_window;

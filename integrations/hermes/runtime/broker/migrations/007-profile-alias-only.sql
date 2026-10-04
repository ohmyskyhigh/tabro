ALTER TABLE managed_profiles DROP COLUMN display_name;

-- Remove only the retired Profile field, never similarly named website/CDP data.
UPDATE request_tickets
SET normalized_body_json = json_remove(normalized_body_json, '$.arguments.display_name')
WHERE tool_name = 'create_browser_profile'
  AND json_type(normalized_body_json, '$.arguments.display_name') IS NOT NULL;

UPDATE request_tickets
SET result_json = json_remove(result_json, '$.facts.profile.display_name', '$.known_facts.profile.display_name')
WHERE tool_name IN ('create_browser_profile', 'open_browser_profile', 'stop_browser_profile')
  AND (json_type(result_json, '$.facts.profile.display_name') IS NOT NULL
    OR json_type(result_json, '$.known_facts.profile.display_name') IS NOT NULL);

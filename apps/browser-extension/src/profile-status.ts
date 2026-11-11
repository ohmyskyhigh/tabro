import type { DashboardSnapshot } from '../../shared/protocol/src/dashboard.js';

type Profile = DashboardSnapshot['profiles'][number];
interface Status { label: string; tone: 'good' | 'warning' | 'error' | ''; detail: string }

/** Connection health and automation control are independent facts. */
export function profileStatus(profile: Profile): { connection: Status; automation: Status } {
  let connection: Status;
  if (profile.ready || profile.extension_state === 'connected') {
    connection = { label: 'Connected', tone: 'good', detail: 'The extension is connected to this Broker.' };
  } else if (profile.problem_code) {
    connection = { label: 'Connection failed', tone: 'error', detail: profile.problem_code === 'PROFILE_EXTENSION_TIMEOUT'
      ? 'The extension did not connect before the timeout. Reopen this Tabro profile through your agent to retry.'
      : `Connection needs attention: ${profile.problem_code}` };
  } else if (profile.browser_state === 'starting' || profile.extension_state === 'connecting') {
    connection = { label: 'Connecting', tone: 'warning', detail: 'Waiting for the extension to connect.' };
  } else if (profile.browser_state === 'stopped' || profile.browser_state === 'unknown') {
    connection = { label: 'Offline', tone: '', detail: 'This browser profile is not currently available.' };
  } else {
    connection = { label: 'Disconnected', tone: 'warning', detail: profile.ownership === 'user'
      ? 'Open Tabro in this profile and reconnect.' : 'Chrome is open, but its extension is disconnected.' };
  }
  const automation: Status = profile.automation_paused
    ? { label: 'Paused', tone: 'warning', detail: 'Automation was stopped or needs recovery. Connecting does not resume it.' }
    : profile.ready
      ? { label: 'Ready', tone: 'good', detail: 'Ready for browser tasks.' }
      : { label: 'Not ready', tone: '', detail: profile.problem_code ?? 'Waiting for a ready browser connection.' };
  return { connection, automation };
}

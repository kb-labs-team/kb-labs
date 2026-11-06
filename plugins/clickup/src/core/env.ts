import { useEnv } from '@kb-labs/sdk';

export function requireApiKey(): string {
  const key = useEnv('CLICKUP_API_KEY');
  if (!key) { throw new Error('CLICKUP_API_KEY is not set'); }
  return key;
}

export function requireTeamId(): string {
  const id = useEnv('CLICKUP_TEAM_ID');
  if (!id) { throw new Error('CLICKUP_TEAM_ID is not set'); }
  return id;
}

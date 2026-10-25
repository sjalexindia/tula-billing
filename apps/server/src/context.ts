import { one, type Exec } from '@tula/db';

export interface Ctx {
  deviceId: string;
  userId: string;
}

export async function localDeviceId(ex: Exec): Promise<string> {
  const r = await one<{ value: string }>(ex, "SELECT value FROM sync_state WHERE key = 'device_id'");
  if (!r) throw new Error('Device not initialised — run the seed/setup first');
  return r.value;
}

export class UserError extends Error {
  constructor(message: string, public code = 'BAD_REQUEST', public status = 400) {
    super(message);
  }
}

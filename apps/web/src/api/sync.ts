import { req } from '../api';

export interface SyncStatus {
  configured: boolean;
  running: boolean;
  /** host of the cloud copy only */
  hub: string | null;
  /** when the access token stops working; null if it never does */
  tokenExpiresAt: string | null;
  device: { id: string; name: string; seriesCode: string; revoked: boolean };
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: { code: string; message: string; at: string | null } | null;
  pending: number;
  rejected: number;
  joinedAt: string | null;
  joinMode: string | null;
}

export interface DeviceRow {
  id: string; name: string; series_code: string; is_primary: number; revoked: number;
  created_at: string; updated_at: string; this_device: boolean;
}

export interface NetworkInfo {
  port: number;
  addresses: Array<{ name: string; address: string; url: string; private: boolean }>;
}

export const syncApi = {
  status: () => req<SyncStatus>('GET', '/api/sync/status'),
  syncNow: () => req<{ result: { ok: boolean }; status: SyncStatus }>('POST', '/api/sync/now', {}),
  devices: () => req<DeviceRow[]>('GET', '/api/devices'),
  updateDevice: (id: string, patch: { name?: string; revoked?: boolean }) => req<{ ok: true }>('PUT', `/api/devices/${id}`, patch),
  network: () => req<NetworkInfo>('GET', '/api/network'),
};

import { isSettingKey, settingsIssues, validateSetting, withDefaults, type SettingKey, type Settings } from '@tula/core';
import { getSettings, insert, nowIso, setSetting, type Db } from '@tula/db';
import { applyNumberingSettings } from './bills';
import { UserError } from './context';

/** Settings that shape the current year's invoice series; GST needs the series consecutive. */
const NUMBERING = ['invoice.prefix', 'invoice.number_format', 'invoice.seq_digits', 'invoice.start_number'] as const;

export interface SaveSettingsResult { saved: string[]; refused: Record<string, string> }
type Refuse = (keys: string[], message: string, code: string) => void;

/**
 * Drop the changes that would make the settings contradict each other, until what is left is consistent.
 * Only the changed settings named in a broken rule are dropped; a rule already broken before this save
 * (none of its settings changed) is not this save's doing and is left to the Settings screen's warnings.
 */
function dropContradictions(current: Settings, clean: Record<string, string>, refuse: Refuse) {
  for (;;) {
    const broken = settingsIssues(withDefaults({ ...current, ...clean })).find((i) => i.keys.some((k) => k in clean));
    if (!broken) return;
    refuse(broken.keys.filter((k) => k in clean), broken.message, 'INCONSISTENT');
  }
}

/**
 * Save the changes that can be saved, and say which were refused and why, instead of refusing all of
 * them because of one. A change is refused when:
 *   - its value is not valid for that setting;
 *   - it would make the settings contradict each other (GSTIN state vs business state, languages…);
 *   - it changes the invoice numbering after this year's first bill (all numbering changes go together).
 * When nothing at all can be saved, it fails as before (same error code), with the refusals in `details`.
 */
export async function saveSettings(db: Db, deviceId: string, userId: string, body: Record<string, unknown>): Promise<SaveSettingsResult> {
  const refused: Record<string, string> = {};
  const clean: Record<string, string> = {};
  let firstCode: string | null = null; // the error code when nothing can be saved
  const refuse: Refuse = (keys, message, code) => {
    for (const k of keys) {
      refused[k] = message;
      delete clean[k];
    }
    firstCode ??= code;
  };

  for (const [k, v] of Object.entries(body)) {
    try {
      clean[k] = validateSetting(k, v);
    } catch (e) {
      refuse([k], (e as Error).message, 'BAD_VALUE');
    }
  }

  const tx = await db.transaction('write');
  try {
    const current = withDefaults(await getSettings(tx));
    dropContradictions(current, clean, refuse);

    const changing = NUMBERING.filter((k) => clean[k] !== undefined && clean[k] !== current[k]);
    if (changing.length) {
      await tx.execute('SAVEPOINT numbering');
      try {
        await applyNumberingSettings(tx, deviceId, withDefaults({ ...current, ...clean }), changing);
        await tx.execute('RELEASE numbering');
      } catch (e) {
        await tx.execute('ROLLBACK TO numbering');
        await tx.execute('RELEASE numbering');
        if (!(e instanceof UserError)) throw e;
        refuse([...changing], e.message, e.code);
        dropContradictions(current, clean, refuse); // without them, the rest must still agree
      }
    }

    const saved = Object.keys(clean).filter((k) => isSettingKey(k)) as SettingKey[];
    if (!saved.length && Object.keys(refused).length) {
      await tx.rollback();
      throw new UserError([...new Set(Object.values(refused))].join('; '), firstCode ?? 'BAD_VALUE', 400, { refused });
    }
    for (const k of saved) await setSetting(tx, deviceId, k, clean[k]!);
    if (saved.length) {
      await insert(tx, 'audit_log', deviceId, { at: nowIso(), user_id: userId, entity: 'settings', entity_id: saved.join(','), action: 'update', after_json: clean });
    }
    await tx.commit();
    return { saved, refused };
  } catch (e) {
    if (!tx.closed) await tx.rollback();
    throw e;
  }
}

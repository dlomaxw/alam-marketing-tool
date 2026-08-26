import { eq } from "drizzle-orm";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { env, envSendEnabled } from "@/lib/env";

export const SETTING_KEYS = {
  globalSendEnabled: "global_send_enabled",
  dailySendLimit: "daily_send_limit",
  contactConfidenceThreshold: "contact_confidence_threshold",
  minScoreToDraft: "min_score_to_draft",
  testSendAllowlist: "test_send_allowlist",
  launchApprovedBy: "launch_approved_by",
} as const;

export const SETTING_DEFAULTS: Record<string, unknown> = {
  [SETTING_KEYS.globalSendEnabled]: false,
  [SETTING_KEYS.dailySendLimit]: 25,
  [SETTING_KEYS.contactConfidenceThreshold]: 70,
  [SETTING_KEYS.minScoreToDraft]: 60,
  [SETTING_KEYS.testSendAllowlist]: [],
  [SETTING_KEYS.launchApprovedBy]: null,
};

export async function getSetting<T>(key: string): Promise<T> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row) return SETTING_DEFAULTS[key] as T;
  return row.value as T;
}

export async function setSetting(
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<void> {
  await db.insert(settings)
    .values({ key, value: value as never, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: value as never, updatedBy, updatedAt: new Date() },
    });
}

export interface SendSwitchState {
  enabled: boolean;
  envEnabled: boolean;
  dbEnabled: boolean;
  reason: string;
}

/**
 * Section 14 kill switch, evaluated as an AND of two independent controls.
 *
 * The environment variable is set by whoever controls the deployment; the
 * database row is set by an administrator in the UI. Requiring both means
 * neither a database compromise nor a stray config change can enable delivery
 * on its own, and an administrator can stop all sending instantly without a
 * redeploy.
 */
export async function getSendSwitch(): Promise<SendSwitchState> {
  const envEnabled = envSendEnabled();
  const dbEnabled = await getSetting<boolean>(SETTING_KEYS.globalSendEnabled);
  const enabled = envEnabled && dbEnabled === true;

  let reason = "Sending is enabled.";
  if (!envEnabled && !dbEnabled) {
    reason = "Sending is disabled by both the deployment config and the admin switch.";
  } else if (!envEnabled) {
    reason = "GLOBAL_SEND_ENABLED is false in the deployment environment.";
  } else if (!dbEnabled) {
    reason = "An administrator has turned the global send switch off.";
  }

  return { enabled, envEnabled, dbEnabled: dbEnabled === true, reason };
}

export async function getDailySendLimit(): Promise<number> {
  const configured = await getSetting<number>(SETTING_KEYS.dailySendLimit);
  // The environment cap is a ceiling the UI cannot raise.
  return Math.min(Number(configured) || 0, env.DAILY_SEND_LIMIT);
}

export async function getTestAllowlist(): Promise<string[]> {
  const fromDb = await getSetting<string[]>(SETTING_KEYS.testSendAllowlist);
  const list = Array.isArray(fromDb) ? fromDb : [];
  return list.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
}

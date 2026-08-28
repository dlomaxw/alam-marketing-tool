import { desc, isNull, eq } from "drizzle-orm";
import { db } from "@/db";
import { propertyFacts, suppressions, users, roles } from "@/db/schema";
import { guardPage } from "@/lib/auth/page-guard";
import {
  getSendSwitch, getDailySendLimit, getTestAllowlist, getSetting, SETTING_KEYS,
} from "@/lib/settings";
import { pendingJobCount } from "@/lib/email/send-guard";
import { emailStatus } from "@/lib/email/provider";
import { env } from "@/lib/env";
import { Card, CardHeader, Empty, Badge, SendStateBanner } from "@/components/ui";
import { KillSwitch, FactRow, NumericSetting, AllowlistForm, SuppressionForm } from "./settings-forms";

export default async function SettingsPage() {
  await guardPage("settings:manage");
  const mail = emailStatus();

  const [send, facts, suppressionRows, userRows, limit, allowlist, minScore, threshold, pending] =
    await Promise.all([
      getSendSwitch(),
      db.select().from(propertyFacts).where(isNull(propertyFacts.supersededAt))
        .orderBy(propertyFacts.key),
      db.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(50),
      db.select({
        id: users.id, name: users.name, email: users.email,
        role: roles.name, mfa: users.mfaEnabled, status: users.status,
      }).from(users).innerJoin(roles, eq(roles.id, users.roleId)),
      getDailySendLimit(),
      getTestAllowlist(),
      getSetting<number>(SETTING_KEYS.minScoreToDraft),
      getSetting<number>(SETTING_KEYS.contactConfidenceThreshold),
      pendingJobCount(),
    ]);

  const unapproved = facts.filter((f) => f.approvedAt === null);

  return (
    <div className="space-y-4">
      <SendStateBanner enabled={send.enabled} reason={send.reason} />

      <Card>
        <CardHeader
          title="Email delivery"
          subtitle="Which provider carries approved messages, and the address they leave as."
          action={<Badge tone={mail.ready ? (mail.live ? "ok" : "neutral") : "danger"}>
            {mail.ready ? (mail.live ? "ready" : "log only") : "not ready"}
          </Badge>}
        />
        <dl className="grid gap-3 px-5 py-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--color-muted)]">Provider</dt>
            <dd className="mt-0.5 text-sm font-medium text-[var(--color-ink)]">{mail.provider}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted)]">Sends as</dt>
            <dd className="mt-0.5 text-sm text-[var(--color-ink-2)]">{mail.sender}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-muted)]">Replies to</dt>
            <dd className="mt-0.5 text-sm text-[var(--color-ink-2)]">{mail.replyTo}</dd>
          </div>
        </dl>
        <p className={`border-t border-[var(--color-line)] px-5 py-3 text-sm ${
          mail.ready ? "text-[var(--color-muted)]" : "text-[var(--color-alam-red)]"
        }`}>
          {mail.detail}
        </p>
      </Card>

      <Card>
        <CardHeader
          title="Global send control"
          subtitle="Delivery requires BOTH the deployment setting and this switch. Either one turns it off instantly."
        />
        <div className="space-y-3 px-5 py-4">
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-[var(--color-muted)]">Deployment (GLOBAL_SEND_ENABLED)</dt>
              <dd className="mt-1">
                <Badge tone={send.envEnabled ? "ok" : "danger"}>
                  {send.envEnabled ? "enabled" : "disabled"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">Administrator switch</dt>
              <dd className="mt-1">
                <Badge tone={send.dbEnabled ? "ok" : "danger"}>
                  {send.dbEnabled ? "enabled" : "disabled"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--color-muted)]">Unsent jobs in queue</dt>
              <dd className="tnum mt-1 text-sm font-medium">{pending}</dd>
            </div>
          </dl>

          <KillSwitch enabled={send.dbEnabled} pendingJobs={pending} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title={`Property facts (${facts.length})`}
          subtitle="Generation may only use approved, current facts. Editing one supersedes it and requires fresh approval."
          action={unapproved.length > 0 ? <Badge tone="danger">{unapproved.length} unapproved</Badge> : undefined}
        />
        <ul className="divide-y divide-[var(--color-line)]">
          {facts.map((f) => (
            <FactRow
              key={f.id}
              id={f.id}
              label={f.label}
              factKey={f.key}
              value={f.value}
              version={f.version}
              approved={f.approvedAt !== null}
            />
          ))}
        </ul>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Limits and thresholds" />
          <div className="space-y-4 px-5 py-4">
            <NumericSetting
              settingKey={SETTING_KEYS.dailySendLimit}
              label="Daily send limit"
              hint={`Capped by the deployment ceiling of ${env.DAILY_SEND_LIMIT}. Section 13: start low and increase gradually.`}
              value={limit}
            />
            <NumericSetting
              settingKey={SETTING_KEYS.contactConfidenceThreshold}
              label="Contact confidence threshold"
              hint="Below this, an extracted email must be confirmed by a person before use."
              value={threshold}
            />
            <NumericSetting
              settingKey={SETTING_KEYS.minScoreToDraft}
              label="Minimum relevance score to draft"
              hint="Drafts below this are generated flagged for manual review."
              value={minScore}
            />
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Internal test allow-list"
            subtitle="The only addresses a TEST send may ever reach."
          />
          <AllowlistForm value={allowlist.join("\n")} />
        </Card>
      </div>

      <Card>
        <CardHeader
          title={`Suppressions (${suppressionRows.length})`}
          subtitle="Addresses and domains that must never be contacted again."
        />
        <SuppressionForm />
        {suppressionRows.length === 0 ? (
          <Empty>Nothing is suppressed.</Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {suppressionRows.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="font-medium text-[var(--color-ink)]">
                  {s.email ?? `@${s.domain}`}
                </span>
                <span className="flex-1 truncate text-[var(--color-muted)]">{s.reason}</span>
                <Badge>{s.source}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title={`Users (${userRows.length})`} subtitle="Approve and send are separate permissions." />
        <ul className="divide-y divide-[var(--color-line)]">
          {userRows.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <div>
                <div className="font-medium text-[var(--color-ink)]">{u.name}</div>
                <div className="text-xs text-[var(--color-muted)]">{u.email}</div>
              </div>
              <div className="flex items-center gap-2">
                <Badge>{u.role}</Badge>
                <Badge tone={u.mfa ? "ok" : "warn"}>{u.mfa ? "MFA on" : "no MFA"}</Badge>
                <Badge tone={u.status === "active" ? "ok" : "danger"}>{u.status}</Badge>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

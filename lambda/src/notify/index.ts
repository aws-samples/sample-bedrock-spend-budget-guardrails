/**
 * Email-notification Lambda. Triggered by the same DynamoDB stream on
 * `RunningSpend` that drives enforcement, but on a separate event-source
 * mapping so notifications and enforcement run independently. Both run
 * for every row update; enforcement attaches a deny policy on breach,
 * this Lambda emails the human (when one's mapped) at threshold crossings
 * and on enforcement events.
 *
 * Notification rules:
 *   - At 50% / 80% / 100% of the tightest matching budget's limit, send
 *     a "heads-up" email to the Cognito user whose
 *     `custom:iam_principal` matches the breached principal. Track the
 *     last threshold notified on the row (`lastNotifiedThreshold`) so
 *     we don't re-send on every invocation.
 *   - When `enforcementPolicyArn` lands on the row (set by the
 *     enforcement Lambda), send a "your access has been blocked" email
 *     immediately, regardless of threshold tracking.
 *   - `action=alert` budgets fire the same threshold emails as
 *     `action=deny` ones — the only difference is whether enforcement
 *     also attaches a deny policy.
 *
 * Cognito reverse-lookup: in-memory cache, refreshed every 5 minutes per
 * Lambda execution context. We pull the user pool's full user list and
 * index by `custom:iam_principal`. Acceptable up to a few thousand users
 * (typical operator headcount); beyond that, switch to a dedicated DDB
 * table populated by the api/users handler.
 *
 * SES: requires `NOTIFY_SENDER_ADDRESS` env (operator-config-sourced) to
 * be a verified SES identity in the deploy region. Without it, the
 * Lambda logs a warning and exits cleanly.
 */
import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  ListUsersInGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { ddb } from '../shared/ddb.js';
import { logger, metrics, MetricUnit } from '../shared/powertools.js';
import { recordActivity } from '../shared/activity.js';
import {
  Threshold,
  blockThreshold,
  highestCrossedWarn,
  resolveThresholds,
} from '../shared/thresholds.js';

const BUDGETS_TABLE = process.env.BUDGETS_TABLE!;
const RUNNING_SPEND_TABLE = process.env.RUNNING_SPEND_TABLE!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const SENDER = process.env.NOTIFY_SENDER_ADDRESS;
// ops mailbox for principals that map to no Cognito human (IAM
// roles, or IAM users with no operator account). Empty ⇒ legacy behavior
// (unmapped principals surface only via admin-watch, and only on enforcement).
const OPS_FALLBACK = process.env.NOTIFY_OPS_FALLBACK_ADDRESS ?? '';
const APP_URL = process.env.APP_URL ?? '';
const STAGE_PREFIX = process.env.STAGE_PREFIX ?? 'dev';

const ses = new SESClient({});
const cognito = new CognitoIdentityProviderClient({});

interface BudgetRow {
  principal: string;
  target: string;
  limitUsd: number;
  action: 'deny' | 'alert';
  thresholds?: Threshold[];
  enabled: boolean;
}

interface SpendRow {
  principal: string;
  sk: string;
  spendUsd?: number;
  target?: string;
  period?: string;
  enforcementPolicyArn?: string;
  lastNotifiedThreshold?: number;
  prevEnforcementPolicyArn?: string;
  /** BBG-RATELIMITS — what triggered the active enforcement. */
  enforcementReason?: 'usd' | 'rpm' | 'tpm';
  /** BBG-RATELIMITS — value/limit/window snapshot at deny time. */
  enforcementMetric?: { value: number; limit: number; windowSeconds?: number };
  /** identity-lens rows (per-identity view of a role's spend). */
  identityLens?: 'sso-user' | 'source-identity';
}

/**
 * Threshold-floor sentinel used when the user has explicitly disabled
 * all warn-emails (or had all 3 legacy toggles off). Any threshold ≤
 * 100 fails `crossedPct >= floor` since 101 > any threshold.
 */
const THRESHOLD_NEVER = 101;

/**
 * Compat-derive a threshold floor from the legacy 3-toggle ladder. Used
 * when `custom:notify_pct_floor` is missing on a user — keeps
 * pre-users behaving the same way they did before.
 *
 * Mapping: floor = the lowest still-enabled bucket. All-disabled →
 * THRESHOLD_NEVER.
 */
const deriveLegacyFloor = (
  t50: boolean,
  t80: boolean,
  t100: boolean,
): number => {
  if (t50) return 50;
  if (t80) return 80;
  if (t100) return 100;
  return THRESHOLD_NEVER;
};

/**
 * Parse the `custom:notify_pct_floor` attribute. Returns
 * undefined if missing or invalid (caller falls back to the legacy
 * 3-toggle derivation).
 */
const parseFloor = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > THRESHOLD_NEVER) return undefined;
  return n;
};

/**
 * Per-user notification preferences. The four threshold/enforcement
 * channels default to opt-in (missing = enabled) so a user who hasn't
 * touched their settings still gets the same emails they would have
 * before this feature shipped. The admin-watch channel defaults to
 * opt-out (admins explicitly subscribe).
 */
interface NotifyPrefs {
  /**
   * Lowest budget-threshold percentage that should trigger an email to
   * this user. A budget warn-threshold at `crossedPct` emails the user
   * iff `crossedPct >= thresholdFloor`. `THRESHOLD_NEVER` (101) opts
   * out of all warn emails entirely; enforcement emails are still
   * controlled by `enforcement` below.
   */
  thresholdFloor: number;
  enforcement: boolean;
  /** Opt-in to "watch all enforcement events". Only honored for Admins. */
  adminWatch: boolean;
}

interface UserCacheEntry {
  email: string;
  username?: string;
  prefs: NotifyPrefs;
}

/**
 * In-memory cache: principal-key → { email, prefs }. Refreshed every
 * CACHE_TTL_MS. Keyed by `principal#<arn>` to match the spend-row
 * principal exactly.
 *
 * Plus a parallel list of admin-watch subscribers — Admins-group users
 * who have set `custom:notify_admin_watch = 'true'`. Used to
 * fan out enforcement-just-fired emails to oncall admins regardless of
 * whose principal triggered the breach.
 */
let cacheBuiltAt = 0;
const principalToUser = new Map<string, UserCacheEntry>();
// secondary index email(lowercased) → user, so SSO/identity-lens
// budgets keyed `principal#sso-user#<email>` can resolve the person even
// though they have no `custom:iam_principal` ARN mapping.
const emailToUser = new Map<string, UserCacheEntry>();
let adminWatchEmails: string[] = [];
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Cognito stores 'true'/'false' as strings; missing → opt-in. */
const parsePref = (raw: string | undefined): boolean => raw !== 'false';
/** Stricter parse: missing → opt-OUT. Used for the admin-watch flag. */
const parseOptIn = (raw: string | undefined): boolean => raw === 'true';

const refreshPrincipalEmailMap = async (): Promise<void> => {
  if (Date.now() - cacheBuiltAt < CACHE_TTL_MS) return;
  principalToUser.clear();
  emailToUser.clear();
  // Build the admin-username set first so we can flag user-cache rows
  // and also build the admin-watch fan-out list in one pass.
  const adminUsernames = new Set<string>();
  let groupToken: string | undefined;
  do {
    const g = await cognito
      .send(
        new ListUsersInGroupCommand({
          UserPoolId: USER_POOL_ID,
          GroupName: 'Admins',
          Limit: 60,
          NextToken: groupToken,
        }),
      )
      .catch((err) => {
        // If the Admins group doesn't exist yet (fresh pool), treat
        // as no admins. Other errors propagate.
        if ((err as { name?: string }).name === 'ResourceNotFoundException') return undefined;
        throw err;
      });
    if (!g) break;
    for (const u of g.Users ?? []) if (u.Username) adminUsernames.add(u.Username);
    groupToken = g.NextToken;
  } while (groupToken);

  const watchEmails: string[] = [];
  let token: string | undefined;
  do {
    const r = await cognito.send(
      new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Limit: 60,
        PaginationToken: token,
      }),
    );
    for (const u of r.Users ?? []) {
      const attr = (name: string) =>
        u.Attributes?.find((a) => a.Name === name)?.Value;
      const arn = attr('custom:iam_principal');
      const email = attr('email');
      const verified = attr('email_verified') === 'true';
      const adminWatch = parseOptIn(attr('custom:notify_admin_watch'));
      const isAdmin = u.Username ? adminUsernames.has(u.Username) : false;

      // Admin-watch fan-out: any Admins-group user with the flag on.
      // Admins don't need a custom:iam_principal mapping for this; they
      // just need a verified email.
      if (isAdmin && adminWatch && email && verified) {
        watchEmails.push(email);
      }

      // Need a verified email to notify anyone. An IAM ARN mapping is
      // optional: SSO/identity-lens users are keyed only by email.
      if (!email || !verified) continue;
      const explicitFloor = parseFloor(attr('custom:notify_pct_floor'));
      const thresholdFloor =
        explicitFloor ??
        deriveLegacyFloor(
          parsePref(attr('custom:notify_50pct')),
          parsePref(attr('custom:notify_80pct')),
          parsePref(attr('custom:notify_100pct')),
        );
      const entry: UserCacheEntry = {
        email,
        username: u.Username,
        prefs: {
          thresholdFloor,
          enforcement: parsePref(attr('custom:notify_enforcement')),
          adminWatch: adminWatch,
        },
      };
      if (arn) principalToUser.set(`principal#${arn}`, entry);
      // index by lowercased email so SSO lens rows can resolve.
      emailToUser.set(email.toLowerCase(), entry);
    }
    token = r.PaginationToken;
  } while (token);

  adminWatchEmails = [...new Set(watchEmails)];
  cacheBuiltAt = Date.now();
  logger.info('refreshed notification cache', {
    principals: principalToUser.size,
    adminWatchSubscribers: adminWatchEmails.length,
  });
};

/** `principal#sso-user#<email>` → `<email>` (lowercased); undefined otherwise. */
const ssoEmailFromPrincipal = (principalKey: string): string | undefined => {
  const m = /^principal#sso-user#(.+)$/.exec(principalKey);
  return m ? m[1].toLowerCase() : undefined;
};

const userFor = async (principalKey: string): Promise<UserCacheEntry | undefined> => {
  await refreshPrincipalEmailMap();
  const direct = principalToUser.get(principalKey);
  if (direct) return direct;
  // an SSO identity-lens budget (`principal#sso-user#<email>`) has no
  // IAM-ARN mapping — resolve the person by their SSO email instead.
  const ssoEmail = ssoEmailFromPrincipal(principalKey);
  return ssoEmail ? emailToUser.get(ssoEmail) : undefined;
};

const getAdminWatchEmails = async (): Promise<string[]> => {
  await refreshPrincipalEmailMap();
  return adminWatchEmails;
};

const fetchBudget = async (principal: string, target: string): Promise<BudgetRow | undefined> => {
  const r = await ddb.send(
    new GetCommand({ TableName: BUDGETS_TABLE, Key: { principal, target } }),
  );
  return r.Item as BudgetRow | undefined;
};


interface SendArgs {
  toEmail: string;
  subject: string;
  bodyText: string;
}

const sendEmail = async ({ toEmail, subject, bodyText }: SendArgs): Promise<void> => {
  if (!SENDER) {
    logger.warn('NOTIFY_SENDER_ADDRESS not set; skipping email', { toEmail, subject });
    return;
  }
  await ses.send(
    new SendEmailCommand({
      Source: SENDER,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Text: { Data: bodyText, Charset: 'UTF-8' } },
      },
    }),
  );
  metrics.addMetric('NotifyEmailsSent', MetricUnit.Count, 1);
  logger.info('email sent', { toEmail, subject });
};

const formatTarget = (target: string): string => {
  if (target.startsWith('model#')) return target.slice('model#'.length);
  if (target.startsWith('profile#')) {
    const tail = target.slice('profile#'.length).split('/').slice(-1)[0];
    return `inference profile ${tail}`;
  }
  return target;
};

/**
 * one-line description of what tripped an enforcement, shared by the
 * admin-watch and ops-fallback channels. Mirrors the USD/RPM/TPM branching
 * used in the user-self enforcement copy.
 */
const enforcementTriggerLine = (row: SpendRow, limitUsd: number, pct: number): string => {
  const reason = row.enforcementReason ?? 'usd';
  const metric = row.enforcementMetric;
  if (reason === 'rpm' && metric) {
    return `  Trigger:   RPM rate limit — ${metric.value} requests in ${metric.windowSeconds ?? 60}s ≥ ${metric.limit} (likely runaway loop)\n`;
  }
  if (reason === 'tpm' && metric) {
    return `  Trigger:   TPM rate limit — ${metric.value} tokens in ${metric.windowSeconds ?? 60}s ≥ ${metric.limit}\n`;
  }
  const spend = typeof row.spendUsd === 'number' ? `$${row.spendUsd.toFixed(4)}` : '$0';
  return `  Trigger:   USD spend ${spend} of $${limitUsd.toFixed(4)} (${pct.toFixed(0)}%)\n`;
};

const handleSpendRow = async (row: SpendRow): Promise<void> => {
  if (!row.target || row.target === 'model#*' || row.target === 'profile#*') return;
  if (!row.spendUsd || row.spendUsd <= 0) return;
  // identity-lens rows (`principal#sso-user#<email>`) mirror the
  // primary role row's dollars but represent the *individual* SSO user. We
  // now process them so the person gets their own budget email at their SSO
  // address (resolved via userFor's email index), instead of only the role's
  // mapped human. The lens row is used for the USER-SELF channel only — the
  // ADMIN-WATCH fan-out is suppressed below for lens rows so the role row's
  // admin copy isn't duplicated (see the `!row.identityLens` guard).

  const budget = await fetchBudget(row.principal, row.target);
  if (!budget || !budget.enabled || budget.limitUsd <= 0) return;

  const thresholds = resolveThresholds(budget);
  const pct = (row.spendUsd / budget.limitUsd) * 100;
  const threshold = highestCrossedWarn(pct, thresholds, row.lastNotifiedThreshold ?? 0);
  const blockTh = blockThreshold(thresholds);

  // Enforcement-just-fired detection: enforcementPolicyArn newly present
  // on the row (was absent in the previous image). Always email,
  // independently of the threshold cadence.
  const enforcementJustFired =
    Boolean(row.enforcementPolicyArn) && !row.prevEnforcementPolicyArn;

  if (!threshold && !enforcementJustFired) return;

  // record the threshold crossing on the principal's activity
  // timeline (the enforcement-applied event is recorded by the enforcement
  // Lambda itself; here we capture the warning-threshold crossings that
  // don't necessarily attach a deny). Best-effort; never blocks the email.
  if (threshold) {
    await recordActivity({
      principal: row.principal,
      type: 'threshold.warning',
      summary: `Spend crossed ${threshold}% of budget for ${formatTarget(row.target)} (${Math.round(pct)}% used)`,
      detail: { target: row.target, thresholdPct: threshold, usedPct: Math.round(pct), spendUsd: row.spendUsd },
    });
  }

  const user = await userFor(row.principal);
  const friendlyTarget = formatTarget(row.target);
  const period = row.period ?? '';
  const appLink = APP_URL ? `\n\nView details: ${APP_URL}/me/spend` : '';
  const adminLink = APP_URL ? `\n\nReview on the Budgets page: ${APP_URL}/budgets` : '';

  // Track who we've already emailed for this event to prevent dupes
  // (e.g. an admin who is also the offending principal shouldn't get
  // both copies of the enforcement email).
  const sentTo = new Set<string>();

  // ---------- USER-SELF channel ----------
  if (user) {
    const prefs = user.prefs;
    let userOptedIn = false;
    if (enforcementJustFired) {
      userOptedIn = prefs.enforcement;
      if (!userOptedIn) {
        logger.info('user opted out of enforcement emails', { principal: row.principal });
        metrics.addMetric('NotifyOptedOut', MetricUnit.Count, 1);
      }
    } else if (threshold) {
      userOptedIn = threshold >= prefs.thresholdFloor;
      if (!userOptedIn) {
        logger.info('user threshold below floor; skipping', {
          principal: row.principal,
          threshold,
          floor: prefs.thresholdFloor,
        });
        metrics.addMetric('NotifyOptedOut', MetricUnit.Count, 1);
      }
    }

    if (userOptedIn) {
      if (enforcementJustFired) {
        // BBG-RATELIMITS — branch the email body based on the reason
        // stamped on the spend row. USD is the default for legacy /
        // unset rows.
        const reason = row.enforcementReason ?? 'usd';
        const metric = row.enforcementMetric;
        let subject: string;
        let bodyText: string;
        if (reason === 'rpm' && metric) {
          subject = `[BBG ${STAGE_PREFIX}] Bedrock access blocked (rate limit): ${friendlyTarget}`;
          bodyText =
            `Your Bedrock access on ${friendlyTarget} has been blocked because your ` +
            `request rate exceeded the configured limit:\n\n` +
            `  Requests: ${metric.value} in the last ${metric.windowSeconds ?? 60}s\n` +
            `  Limit:    ${metric.limit} in the same window\n` +
            `  Principal: ${row.principal}\n\n` +
            `An IAM deny policy has been attached to your principal. Future Bedrock ` +
            `invocations against this target will fail with AccessDeniedException ` +
            `until an admin releases the budget.\n\n` +
            `This usually means a runaway agent loop or unintended retry storm. ` +
            `Investigate the calling code before requesting a release.${appLink}`;
        } else if (reason === 'tpm' && metric) {
          subject = `[BBG ${STAGE_PREFIX}] Bedrock access blocked (token rate): ${friendlyTarget}`;
          bodyText =
            `Your Bedrock access on ${friendlyTarget} has been blocked because your ` +
            `token throughput exceeded the configured limit:\n\n` +
            `  Tokens:   ${metric.value} in the last ${metric.windowSeconds ?? 60}s ` +
            `(input + output combined)\n` +
            `  Limit:    ${metric.limit} in the same window\n` +
            `  Principal: ${row.principal}\n\n` +
            `An IAM deny policy has been attached to your principal. Future Bedrock ` +
            `invocations against this target will fail with AccessDeniedException ` +
            `until an admin releases the budget.\n\n` +
            `This usually means an oversized prompt-caching loop or context-stuffing ` +
            `agent. Investigate before requesting a release.${appLink}`;
        } else {
          // Default USD-breach copy (legacy behavior).
          subject = `[BBG ${STAGE_PREFIX}] Bedrock access blocked: ${friendlyTarget}`;
          bodyText =
            `Your Bedrock spend on ${friendlyTarget} reached $${row.spendUsd.toFixed(4)} ` +
            `against a budget of $${budget.limitUsd.toFixed(4)} (${pct.toFixed(0)}%) ` +
            `for the period ${period}.\n\n` +
            `An IAM deny policy has been attached to your principal:\n  ${row.principal}\n\n` +
            `Future Bedrock invocations against this target will fail with AccessDeniedException ` +
            `until the next budget period rolls over (the 1st of the next month UTC).\n\n` +
            `If you need access restored sooner, ask an admin to release the budget on the ` +
            `Budgets page.${appLink}`;
        }
        await sendEmail({ toEmail: user.email, subject, bodyText });
        metrics.addMetric('NotifyEnforcement', MetricUnit.Count, 1);
        sentTo.add(user.email.toLowerCase());
      } else if (threshold) {
        const willBlock = blockTh && blockTh.at >= threshold;
        const action = willBlock
          ? `Once you reach ${blockTh.at}%, BBG will automatically attach a deny policy and your Bedrock invocations will fail until the next budget period.`
          : `This is an alert-only budget (no automatic deny). Spend will keep accumulating; reach out to an admin if you need a hard cap.`;
        await sendEmail({
          toEmail: user.email,
          subject: `[BBG ${STAGE_PREFIX}] ${threshold}% of your ${friendlyTarget} budget used`,
          bodyText:
            `Your Bedrock spend on ${friendlyTarget} has reached $${row.spendUsd.toFixed(4)} ` +
            `(${pct.toFixed(0)}% of the $${budget.limitUsd.toFixed(4)} budget) for ${period}.\n\n` +
            `${action}${appLink}`,
        });
        metrics.addMetric('NotifyThreshold', MetricUnit.Count, 1);
        sentTo.add(user.email.toLowerCase());
      }
    }
  } else {
    logger.info('no Cognito user matches principal; user-self email skipped', {
      principal: row.principal,
    });
    metrics.addMetric('NotifyUnmappedPrincipal', MetricUnit.Count, 1);
  }

  // ---------- ADMIN-WATCH channel (enforcement only) ----------
  // Fan out to every Admins-group user with custom:notify_admin_watch = 'true'.
  // Only on enforcement-just-fired events; threshold pings are noise at the
  // org scale.
  // skip for identity-lens rows — the primary role row fires the
  // admin-watch copy for the same dollars, so emitting it again here would
  // double-send. The lens row only drives the per-SSO-user self email above.
  if (enforcementJustFired && !row.identityLens) {
    const watchers = await getAdminWatchEmails();
    // BBG-RATELIMITS — annotate the admin-watch body with the
    // enforcement reason so on-call admins know whether to investigate
    // a runaway loop (rate-triggered) or a budget overrun (USD).
    const reason = row.enforcementReason ?? 'usd';
    const triggerLine = enforcementTriggerLine(row, budget.limitUsd, pct);
    for (const watcherEmail of watchers) {
      if (sentTo.has(watcherEmail.toLowerCase())) continue;
      await sendEmail({
        toEmail: watcherEmail,
        subject: `[BBG ${STAGE_PREFIX}] [admin] Enforcement (${reason}): ${friendlyTarget} on ${row.principal}`,
        bodyText:
          `Enforcement just fired on a budget you're subscribed to as an admin watcher.\n\n` +
          `  Principal: ${row.principal}\n` +
          `  Target:    ${friendlyTarget}\n` +
          triggerLine +
          `  Period:    ${period}\n` +
          `  Policy:    ${row.enforcementPolicyArn ?? '(missing)'}\n\n` +
          `The deny policy is attached. The user has been notified separately ` +
          `(if they have a Cognito account with custom:iam_principal mapped). ` +
          `${reason !== 'usd' ? 'Investigate the calling code before releasing — rate-triggered denies usually indicate a runaway loop or leaked credential.' : 'You can release the budget on the Budgets page if needed.'}${adminLink}\n\n` +
          `To unsubscribe from these admin-watch emails, toggle off ` +
          `"Admin: all enforcement events" on your My profile page.`,
      });
      sentTo.add(watcherEmail.toLowerCase());
      metrics.addMetric('NotifyAdminWatch', MetricUnit.Count, 1);
    }
  }

  // ---------- OPS-FALLBACK channel ----------
  // principals that map to no Cognito human (IAM roles, or IAM users
  // with no operator account) would otherwise get NO threshold email at all,
  // and only an admin-watch enforcement email if any admin subscribed. When an
  // ops mailbox is configured, send it BOTH the threshold and enforcement
  // emails for such principals so unmapped roles/users aren't silent. Skipped
  // for identity-lens rows (the primary role row covers the same dollars) and
  // when the ops address was already emailed via another channel.
  if (OPS_FALLBACK && !user && !row.identityLens && !sentTo.has(OPS_FALLBACK.toLowerCase())) {
    if (enforcementJustFired) {
      const reason = row.enforcementReason ?? 'usd';
      await sendEmail({
        toEmail: OPS_FALLBACK,
        subject: `[BBG ${STAGE_PREFIX}] [ops] Enforcement (${reason}): ${friendlyTarget} on ${row.principal}`,
        bodyText:
          `Enforcement just fired on a principal with no mapped operator account, so ` +
          `no user-self email was sent. Routed to the ops fallback mailbox.\n\n` +
          `  Principal: ${row.principal}\n` +
          `  Target:    ${friendlyTarget}\n` +
          enforcementTriggerLine(row, budget.limitUsd, pct) +
          `  Period:    ${period}\n` +
          `  Policy:    ${row.enforcementPolicyArn ?? '(missing)'}\n\n` +
          `The deny policy is attached. If this principal should belong to a person, ` +
          `map an operator to it (custom:iam_principal) so they're notified directly.` +
          `${adminLink}`,
      });
      metrics.addMetric('NotifyOpsFallback', MetricUnit.Count, 1);
      sentTo.add(OPS_FALLBACK.toLowerCase());
    } else if (threshold) {
      await sendEmail({
        toEmail: OPS_FALLBACK,
        subject: `[BBG ${STAGE_PREFIX}] [ops] ${threshold}% of ${friendlyTarget} budget used — ${row.principal}`,
        bodyText:
          `A budget threshold was crossed by a principal with no mapped operator ` +
          `account, so no user-self email was sent. Routed to the ops fallback mailbox.\n\n` +
          `  Principal: ${row.principal}\n` +
          `  Target:    ${friendlyTarget}\n` +
          `  Spend:     $${row.spendUsd.toFixed(4)} of $${budget.limitUsd.toFixed(4)} (${pct.toFixed(0)}%)\n` +
          `  Period:    ${period}\n\n` +
          `If this principal should belong to a person, map an operator to it ` +
          `(custom:iam_principal) so they're notified directly.${adminLink}`,
      });
      metrics.addMetric('NotifyOpsFallback', MetricUnit.Count, 1);
      sentTo.add(OPS_FALLBACK.toLowerCase());
    }
  }

  // Persist threshold (regardless of whether the email actually went —
  // this keeps the Lambda idempotent against retries).
  if (threshold && !enforcementJustFired) {
    await ddb
      .send(
        new UpdateCommand({
          TableName: RUNNING_SPEND_TABLE,
          Key: { principal: row.principal, sk: row.sk },
          UpdateExpression: 'SET lastNotifiedThreshold = :t',
          ConditionExpression:
            'attribute_not_exists(lastNotifiedThreshold) OR lastNotifiedThreshold < :t',
          ExpressionAttributeValues: { ':t': threshold },
        }),
      )
      .catch((err) => {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      });
  }

};

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
  for (const record of event.Records) {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') continue;
    const newImage = record.dynamodb?.NewImage;
    const oldImage = record.dynamodb?.OldImage;
    if (!newImage) continue;
    const next = unmarshall(newImage as never) as SpendRow;
    const prev = oldImage ? (unmarshall(oldImage as never) as SpendRow) : undefined;
    next.prevEnforcementPolicyArn = prev?.enforcementPolicyArn;
    try {
      await handleSpendRow(next);
    } catch (err) {
      logger.error('notify failed', {
        err: (err as Error).message,
        principal: next.principal,
        sk: next.sk,
      });
      // Surface notify failures as a metric so they're not invisible.
      // Every real failure path — including the rethrows from the
      // ListUsersInGroup and threshold-persist `.catch` sites above —
      // funnels here, so a single emission counts each failure once.
      // The NotifyError alarm lives in observability-stack.ts.
      metrics.addMetric('NotifyError', MetricUnit.Count, 1);
    }
  }
  metrics.publishStoredMetrics();
};

// Suppress an unused-import warning when the QueryCommand/ScanCommand
// imports are kept for future per-principal lookups (e.g. when we move
// to a dedicated cognito-by-iam-principal index table).
void QueryCommand;
void ScanCommand;

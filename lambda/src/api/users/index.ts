import { randomBytes } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ListGroupsCommand,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  callerIdentity,
  callerScope,
  json,
  noContent,
  parseBody,
  requireAdmin,
} from '../../shared/api.js';
import { canonicalizeCurPrincipal } from '../../shared/arn.js';
import { emitAudit } from '../../shared/audit.js';
import { recordActivity } from '../../shared/activity.js';
import { metrics } from '../../shared/powertools.js';

/**
 * Generates a Cognito-policy-compliant temp password.
 *
 * Why: the pool requires min 12 chars + lowercase + uppercase + digit +
 * symbol. A naive `randomBytes(...).toString('base64url')` can omit a
 * class (e.g. all lowercase + digits + `_-`), tripping
 * InvalidPasswordException at AdminCreateUser time.
 *
 * Strategy: pick one mandatory char from each required class, fill the
 * rest from a wide pool, then Fisher–Yates shuffle so the mandatory
 * chars aren't always at the front (Cognito doesn't care about order
 * but a predictable prefix makes the password subtly less random).
 */
const generateTempPassword = (length = 16): string => {
  const lower = 'abcdefghijkmnpqrstuvwxyz'; // omit ambiguous l/o
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // omit ambiguous I/O
  const digits = '23456789'; // omit 0/1
  const symbols = '!@#$%^&*-_=+';
  const all = lower + upper + digits + symbols;
  const pick = (set: string): string => set[randomBytes(1)[0] % set.length];
  const chars: string[] = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  for (let i = chars.length; i < length; i++) chars.push(pick(all));
  // Fisher–Yates shuffle (cryptographic random for index selection).
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
};

const USER_POOL_ID = process.env.USER_POOL_ID!;
const cognito = new CognitoIdentityProviderClient({});

const attrMap = (attrs?: Array<{ Name?: string; Value?: string }>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) if (a.Name && a.Value !== undefined) out[a.Name] = a.Value;
  return out;
};

/**
 * Resolve a Cognito Username (the immutable UUID) from whatever the caller put
 * in the {username} path param. This pool uses `signInAliases: {email:true}`, so
 * Cognito treats email as a sign-in ALIAS and the real Username is an opaque
 * UUID — but AdminGetUser accepts the alias as input, so this doubles as an
 * alias→UUID resolver. Used to key PrincipalActivity rows on the stable UUID so
 * a user's timeline isn't split across `user#<email>` (create) and
 * `user#<uuid>` (lifecycle) — and isn't influenced by the self-writable email.
 *
 * NEVER throws — activity is best-effort; on any error (incl. the user already
 * deleted) it falls back to the input so a Cognito hiccup can't 500 an admin
 * mutation.
 */
const canonicalUsername = async (u: string): Promise<string> => {
  try {
    const r = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: u }));
    return r.Username ?? u;
  } catch {
    return u;
  }
};

interface CreateUserBody {
  email: string;
  /** Standard Cognito `name` — the display name shown in the SPA top-right. */
  name?: string;
  givenName?: string;
  familyName?: string;
  team?: string;
  iamPrincipal?: string;
  groups?: string[];
  /** Optional admin override. Blank → server generates a random one. */
  temporaryPassword?: string;
  /** When true, sets the password permanent immediately (no first-login change). */
  permanent?: boolean;
  /**
   * When true (default), Cognito sends the standard invitation email with
   * the temp password to the new user's address. When false, the email is
   * suppressed and the response carries the temp password for the admin
   * to deliver out-of-band.
   */
  sendInvite?: boolean;
}

interface UpdateUserBody {
  /** Standard Cognito `name` — the display name shown in the SPA top-right. */
  name?: string;
  givenName?: string;
  familyName?: string;
  email?: string;
  team?: string;
  iamPrincipal?: string;
  /** Notification preferences (admin override). Stored as 'true'/'false' strings on Cognito. */
  notify50pct?: boolean;
  notify80pct?: boolean;
  notify100pct?: boolean;
  notifyEnforcement?: boolean;
  /** Admin-only: opt-in to receive every enforcement email across the org. */
  notifyAdminWatch?: boolean;
  /**
   * lowest budget-threshold percentage that triggers an email.
   * 50/75/80/90/100, or 101 for "never". Persisted as a string on
   * `custom:notify_pct_floor`.
   */
  notifyThresholdFloor?: number;
}

interface GroupsBody {
  groups: string[];
}

const usernameFromPath = (event: APIGatewayProxyEventV2WithJWTAuthorizer): string =>
  decodeURIComponent(event.pathParameters?.username ?? '');

const handleRoute = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const route = event.routeKey;

  if (route === 'GET /admin/users') {
    const r = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }));
    const users = await Promise.all(
      (r.Users ?? []).map(async (u) => {
        const groupsResp = await cognito
          .send(
            new AdminListGroupsForUserCommand({
              UserPoolId: USER_POOL_ID,
              Username: u.Username!,
            }),
          )
          .catch(() => undefined);
        return {
          username: u.Username,
          status: u.UserStatus,
          enabled: u.Enabled,
          createdAt: u.UserCreateDate?.toISOString(),
          lastModifiedAt: u.UserLastModifiedDate?.toISOString(),
          attributes: attrMap(u.Attributes),
          groups: (groupsResp?.Groups ?? []).map((g) => g.GroupName).filter(Boolean) as string[],
        };
      }),
    );
    return json(200, { items: users });
  }

  if (route === 'GET /admin/users/groups') {
    const r = await cognito.send(new ListGroupsCommand({ UserPoolId: USER_POOL_ID }));
    return json(200, {
      items: (r.Groups ?? []).map((g) => ({ name: g.GroupName, description: g.Description })),
    });
  }

  if (route === 'POST /admin/users') {
    const body = parseBody<CreateUserBody>(event);
    if (!body?.email) return json(400, { error: 'email required' });

    const userAttributes: Array<{ Name: string; Value: string }> = [
      { Name: 'email', Value: body.email },
      { Name: 'email_verified', Value: 'true' },
    ];
    if (body.name) userAttributes.push({ Name: 'name', Value: body.name });
    if (body.givenName) userAttributes.push({ Name: 'given_name', Value: body.givenName });
    if (body.familyName) userAttributes.push({ Name: 'family_name', Value: body.familyName });
    if (body.team) userAttributes.push({ Name: 'custom:team', Value: body.team });
    // Canonicalize server-side (assumed-role → base-role) so /me lookups —
    // keyed on the meter's canonical principal# — match regardless of whether
    // the value came from the SPA (which also canonicalizes) or a direct API
    // call. The pre-token-gen bbg:principal claim reads this stored value.
    if (body.iamPrincipal)
      userAttributes.push({ Name: 'custom:iam_principal', Value: canonicalizeCurPrincipal(body.iamPrincipal.trim()) });

    // If the admin doesn't supply one, generate a random temp password.
    // The result is returned so the admin can deliver it out-of-band when
    // sendInvite=false.
    const tempPwd =
      body.temporaryPassword && body.temporaryPassword.length > 0
        ? body.temporaryPassword
        : generateTempPassword();

    // Default: Cognito emails the standard invitation. Admin can opt out
    // (e.g. when password will be set permanent + handed off in person).
    const sendInvite = body.sendInvite !== false;

    let createdUsername = body.email; // falls back to email if the response omits it
    try {
      const created = await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: body.email,
          UserAttributes: userAttributes,
          TemporaryPassword: tempPwd,
          DesiredDeliveryMediums: sendInvite ? ['EMAIL'] : undefined,
          MessageAction: sendInvite ? undefined : 'SUPPRESS',
        }),
      );
      // Cognito generates the immutable UUID Username; key activity on it.
      createdUsername = created.User?.Username ?? body.email;
    } catch (err) {
      const name = (err as { name?: string }).name;
      const msg = (err as { message?: string }).message ?? 'unknown';
      if (name === 'UsernameExistsException') return json(409, { error: 'User already exists' });
      // Surface Cognito client validation as 400 instead of bubbling a 500.
      if (
        name === 'InvalidPasswordException' ||
        name === 'InvalidParameterException' ||
        name === 'PasswordResetRequiredException'
      ) {
        return json(400, { error: msg, code: name });
      }
      throw err;
    }

    if (body.permanent) {
      await cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: USER_POOL_ID,
          Username: body.email,
          Password: tempPwd,
          Permanent: true,
        }),
      );
    }

    for (const g of body.groups ?? []) {
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: body.email,
          GroupName: g,
        }),
      );
    }

    // activity keyed on the immutable Cognito Username (UUID) so every
    // lifecycle event for this user lands on ONE partition (disable/enable/
    // delete key the same way). For a mapped user, ALSO mirror to their IAM
    // `principal#<arn>` so the (single-key) admin per-principal modal — opened
    // from Identities by ARN — still shows lifecycle events.
    const createActivity = {
      type: 'user.created' as const,
      summary: `User ${body.email} created${body.iamPrincipal ? ` (mapped to ${body.iamPrincipal})` : ''}`,
      detail: { username: body.email, groups: body.groups ?? [] },
      actor: callerIdentity(event),
    };
    await recordActivity({ principal: `user#${createdUsername}`, ...createActivity });
    if (body.iamPrincipal) {
      await recordActivity({
        principal: `principal#${canonicalizeCurPrincipal(body.iamPrincipal.trim())}`,
        ...createActivity,
      });
    }

    return json(201, { username: body.email, temporaryPassword: tempPwd });
  }

  if (route === 'PUT /admin/users/{username}') {
    const username = usernameFromPath(event);
    const body = parseBody<UpdateUserBody>(event);
    if (!body) return json(400, { error: 'Invalid body' });
    const updates: Array<{ Name: string; Value: string }> = [];
    if (body.name !== undefined) updates.push({ Name: 'name', Value: body.name });
    if (body.givenName !== undefined) updates.push({ Name: 'given_name', Value: body.givenName });
    if (body.familyName !== undefined) updates.push({ Name: 'family_name', Value: body.familyName });
    if (body.email !== undefined) updates.push({ Name: 'email', Value: body.email });
    if (body.team !== undefined) updates.push({ Name: 'custom:team', Value: body.team });
    if (body.iamPrincipal !== undefined)
      updates.push({
        Name: 'custom:iam_principal',
        Value: body.iamPrincipal ? canonicalizeCurPrincipal(body.iamPrincipal.trim()) : body.iamPrincipal,
      });
    if (body.notify50pct !== undefined)
      updates.push({ Name: 'custom:notify_50pct', Value: body.notify50pct ? 'true' : 'false' });
    if (body.notify80pct !== undefined)
      updates.push({ Name: 'custom:notify_80pct', Value: body.notify80pct ? 'true' : 'false' });
    if (body.notify100pct !== undefined)
      updates.push({ Name: 'custom:notify_100pct', Value: body.notify100pct ? 'true' : 'false' });
    if (body.notifyEnforcement !== undefined)
      updates.push({
        Name: 'custom:notify_enforcement',
        Value: body.notifyEnforcement ? 'true' : 'false',
      });
    if (body.notifyAdminWatch !== undefined)
      updates.push({
        Name: 'custom:notify_admin_watch',
        Value: body.notifyAdminWatch ? 'true' : 'false',
      });
    if (body.notifyThresholdFloor !== undefined) {
      const v = body.notifyThresholdFloor;
      if (!Number.isFinite(v) || v < 0 || v > 101) {
        return json(400, { error: 'notifyThresholdFloor must be 0–101' });
      }
      updates.push({
        Name: 'custom:notify_pct_floor',
        Value: String(Math.round(v)),
      });
    }
    if (updates.length > 0) {
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          UserAttributes: updates,
        }),
      );
      // key on the immutable Cognito Username (UUID) so this row joins
      // the rest of the user's timeline; mirror to the mapped principal#<arn>
      // (when set) for the admin per-principal modal.
      const canonical = await canonicalUsername(username);
      const changed = updates.map((u) => u.Name.replace(/^custom:/, ''));
      const meta = {
        type: 'user.metadata_changed' as const,
        summary: `User ${username} updated: ${changed.join(', ')}`,
        detail: { username, changed },
        actor: callerIdentity(event),
      };
      await recordActivity({ principal: `user#${canonical}`, ...meta });
      if (body.iamPrincipal !== undefined && body.iamPrincipal) {
        await recordActivity({
          principal: `principal#${canonicalizeCurPrincipal(body.iamPrincipal.trim())}`,
          ...meta,
        });
      }
    }
    return json(200, { username, updated: updates.map((u) => u.Name) });
  }

  if (route === 'PUT /admin/users/{username}/groups') {
    const username = usernameFromPath(event);
    const body = parseBody<GroupsBody>(event);
    if (!body?.groups) return json(400, { error: 'groups[] required' });
    const target = new Set(body.groups);
    const current = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
    );
    const have = new Set((current.Groups ?? []).map((g) => g.GroupName).filter(Boolean) as string[]);
    const toAdd = [...target].filter((g) => !have.has(g));
    const toRemove = [...have].filter((g) => !target.has(g));
    for (const g of toAdd) {
      await cognito.send(
        new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: username, GroupName: g }),
      );
    }
    for (const g of toRemove) {
      await cognito.send(
        new AdminRemoveUserFromGroupCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          GroupName: g,
        }),
      );
    }
    // record group changes on the user's timeline (was previously silent).
    if (toAdd.length || toRemove.length) {
      await recordActivity({
        principal: `user#${await canonicalUsername(username)}`,
        type: 'user.groups_changed',
        summary: `User ${username} groups changed`,
        detail: { username, added: toAdd, removed: toRemove },
        actor: callerIdentity(event),
      });
    }
    return json(200, { username, groups: [...target] });
  }

  if (route === 'POST /admin/users/{username}/disable') {
    const username = usernameFromPath(event);
    await cognito.send(new AdminDisableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    await recordActivity({
      principal: `user#${await canonicalUsername(username)}`,
      type: 'user.disabled',
      summary: `User ${username} disabled`,
      detail: { username },
      actor: callerIdentity(event),
    });
    return json(200, { username, enabled: false });
  }

  if (route === 'POST /admin/users/{username}/enable') {
    const username = usernameFromPath(event);
    await cognito.send(new AdminEnableUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    await recordActivity({
      principal: `user#${await canonicalUsername(username)}`,
      type: 'user.enabled',
      summary: `User ${username} enabled`,
      detail: { username },
      actor: callerIdentity(event),
    });
    return json(200, { username, enabled: true });
  }

  if (route === 'POST /admin/users/{username}/reset-password') {
    const username = usernameFromPath(event);
    await cognito.send(new AdminResetUserPasswordCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    // record the reset on the user's timeline (was previously silent).
    await recordActivity({
      principal: `user#${await canonicalUsername(username)}`,
      type: 'user.password_reset',
      summary: `Password reset initiated for ${username}`,
      detail: { username },
      actor: callerIdentity(event),
    });
    return json(200, { username, reset: true });
  }

  if (route === 'DELETE /admin/users/{username}') {
    const username = usernameFromPath(event);
    // ORDERING IS LOAD-BEARING: resolve the canonical UUID BEFORE deleting the
    // user — AdminGetUser after deletion throws UserNotFound and would fall
    // back to the raw (possibly email) path param, splitting the timeline on
    // the one path that can never be repaired afterward.
    const canonical = await canonicalUsername(username);
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    await recordActivity({
      principal: `user#${canonical}`,
      type: 'user.deleted',
      summary: `User ${username} deleted`,
      detail: { username },
      actor: callerIdentity(event),
    });
    return noContent();
  }

  if (route === 'GET /admin/users/{username}') {
    const username = usernameFromPath(event);
    const u = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    const groupsResp = await cognito.send(
      new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
    );
    return json(200, {
      username: u.Username,
      status: u.UserStatus,
      enabled: u.Enabled,
      createdAt: u.UserCreateDate?.toISOString(),
      lastModifiedAt: u.UserLastModifiedDate?.toISOString(),
      attributes: attrMap(u.UserAttributes),
      groups: (groupsResp.Groups ?? []).map((g) => g.GroupName).filter(Boolean),
    });
  }

  return json(404, { error: `Unknown route: ${route}` });
};

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  if (!requireAdmin(event)) return json(403, { error: 'Forbidden' });
  const scope = callerScope(event);
  // Cognito user/group management is super-admin only. The
  // user pool is a single global resource; allowing per-account
  // delegated admins to create/delete users would let them span
  // accounts across the org.
  if (!scope.isWildcard) {
    return json(403, { error: 'Forbidden: user management is super-admin only' });
  }

  const result = await handleRoute(event);

  // Emit one audit per non-GET request after the operation succeeds.
  // GET routes are read-only and don't need audit (already a lot of
  // them in this handler — listing users, fetching one user, etc.).
  if (event.requestContext.http.method !== 'GET') {
    emitAudit(callerIdentity(event), scope, {
      action: `users.${event.requestContext.http.method.toLowerCase()}`,
      targetAccountId: '*',
      detail: {
        route: event.routeKey,
        username: event.pathParameters?.username,
      },
    });
    metrics.publishStoredMetrics();
  }
  return result;
};

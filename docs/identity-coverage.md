# Identity coverage

The `identity-cache` Lambda canonicalizes every Bedrock-callable IAM principal it sees in CloudTrail. Examples below are real CloudTrail event shapes for each caller type, with the resulting `principal#` key BBG writes into the `IdentityCache` table.

## 1. IAM user

```jsonc
{
  "userIdentity": {
    "type": "IAMUser",
    "arn": "arn:aws:iam::123456789012:user/alice",
    "accountId": "123456789012",
    "userName": "alice"
  }
}
```

→ `principal#arn:aws:iam::123456789012:user/alice`
Enforcement: `iam:AttachUserPolicy --user-name alice --policy-arn arn:aws:iam::123456789012:policy/bbg-deny-...`

## 2. IAM role (direct AssumeRole, EC2 instance profile, Lambda execution role)

```jsonc
{
  "userIdentity": {
    "type": "AssumedRole",
    "arn": "arn:aws:sts::123456789012:assumed-role/Dev/alice-session",
    "principalId": "AROAEXAMPLE:alice-session",
    "sessionContext": {
      "sessionIssuer": {
        "type": "Role",
        "arn": "arn:aws:iam::123456789012:role/Dev",
        "userName": "Dev"
      }
    }
  }
}
```

→ `principal#arn:aws:iam::123456789012:role/Dev` (canonicalized via `sessionIssuer.arn`)
Enforcement: `iam:AttachRolePolicy --role-name Dev`

## 3. IAM Identity Center (SSO)

```jsonc
{
  "userIdentity": {
    "type": "AssumedRole",
    "arn": "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Admin_abc/leo@example.com",
    "principalId": "AROAEXAMPLE:leo@example.com",
    "sessionContext": {
      "sessionIssuer": {
        "type": "Role",
        "arn": "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_Admin_abc",
        "userName": "AWSReservedSSO_Admin_abc"
      }
    }
  }
}
```

BBG records both:

- `principal#arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/us-west-2/AWSReservedSSO_Admin_abc` (the SSO reserved role)
- `principal#sso-user#leo@example.com` (the human, parsed from the session name)

Admins can budget either grain. For an `sso-user#<email>` budget, enforcement attaches the deny to the SSO reserved role **scoped to just that user** via `Condition: { StringLike: { "aws:userid": "*:<email>" } }` — an assumed-role session's `aws:userid` is `<role-id>:<session-name>`, and Identity Center sets the session name to the user's email, so only that user's sessions are denied, not every assumer of the shared role. No ABAC / session-tag configuration is required. The wildcard on the role-id makes the condition resilient to Identity Center rotating the role's hash suffix.

The `sso-user#<email>` key also drives **per-identity budget email**: the notify Lambda keeps a secondary email→user index, so a `principal#sso-user#<email>` spend row resolves to that human's own address for threshold/enforcement emails even though the SSO user has no `custom:iam_principal` ARN mapping. No per-user IAM mapping is required for either enforcement or notification.

## 4. Federated SAML / OIDC user

```jsonc
{
  "userIdentity": {
    "type": "AssumedRole",
    "arn": "arn:aws:sts::123456789012:assumed-role/SAMLProd/some-session",
    "sessionContext": {
      "sessionIssuer": {
        "type": "Role",
        "arn": "arn:aws:iam::123456789012:role/SAMLProd"
      },
      "attributes": {
        "principalTag/principal": "leo@example.com",
        "principalTag/team": "wwps-sales"
      }
    }
  }
}
```

→ `principal#sessionTag/principal=leo@example.com` (when the optional gateway is deployed — see below) or the assumed-role fallback `principal#arn:aws:iam::…:role/SAMLProd`.

**Enforcement, by key shape:**
- **`sso-user#<email>` / `sourceIdentity#<value>`** (recommended for per-human denies): enforcement attaches the deny to the underlying/issuer role scoped by `aws:userid` (SSO) or `aws:SourceIdentity`. These keys are produced automatically for SSO users and for gateway traffic that sets `sts:SetSourceIdentity`.
- **Role-keyed budget + a `condition`** (`{ tagKey, tagValue }`): enforcement attaches to that role with `Condition: { StringEquals: { "aws:PrincipalTag/<tagKey>": "<tagValue>" } }`. Requires the federation to set that as a **session tag** on the role's sessions.
- **`sessionTag/…` key**: only auto-enforces when the BBG **gateway** (`bbg:enableGateway`) attaches the deny to the federation role. Without the gateway, a `sessionTag/…` budget meters + alerts but does not attach a deny; enforcement emits `EnforcementUnattachable` (see the alarm runbook) — prefer an `sso-user#`/`sourceIdentity#` key or a role-keyed budget + condition.
- **`principal#unknown`** (unattributable caller): cannot be enforced — alert-only. A `deny` budget on it is rejected by the API and, if one exists, surfaces via `EnforcementUnattachable`.

## 5. Bedrock Agent (single agent)

```jsonc
{
  "userIdentity": {
    "type": "AWSService",
    "invokedBy": "bedrock.amazonaws.com",
    "sessionContext": {
      "sessionIssuer": {
        "type": "Role",
        "arn": "arn:aws:iam::123456789012:role/AmazonBedrockExecutionRoleForAgents_abc"
      }
    }
  }
}
```

→ `principal#agent-role#arn:aws:iam::123456789012:role/AmazonBedrockExecutionRoleForAgents_abc`
Enforcement: deny on the agent's service role.

## 6. Bedrock Agent (multi-agent collaboration)

Each `InvokeAgent` and downstream `InvokeModel` runs under the respective agent's service role. CloudTrail records each hop separately, linked by `requestParameters.sessionId`. BBG writes:

- One `principal#agent-role#<supervisorRoleArn>` and one per collaborator role.
- One row in `AgentSessions` per `sessionId` aggregating the entire conversation, with the optional `endUser` attribute populated when the gateway propagated `sts:SetSourceIdentity`.

Admins can budget the chain root (deny on supervisor → cuts the whole conversation), specific collaborators, or via the gateway, the actual end user.

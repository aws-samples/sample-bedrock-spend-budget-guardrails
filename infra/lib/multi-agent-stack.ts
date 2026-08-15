import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import type { GatewayStack } from './gateway-stack.js';

export interface MultiAgentStackProps extends cdk.StackProps {
  readonly stagePrefix: string;
  readonly gateway: GatewayStack;
}

/**
 * Reference deployment of a Bedrock multi-agent collaboration chain
 * wired through the gateway, used to demonstrate end-user attribution
 * propagation via transitive session tags + sts:SetSourceIdentity.
 *
 * Topology:
 *   - **Supervisor** (Claude Sonnet 4.6) — receives the user-facing
 *     prompt via gateway → InvokeAgent. Has multi-agent collaboration
 *     enabled with two collaborator subordinates and is instructed to
 *     delegate based on intent.
 *   - **Researcher** (Claude Haiku 4.5) — collaborator. Cheap; pretends
 *     to look things up.
 *   - **Summarizer** (Claude Haiku 4.5) — collaborator. Cheap; rewrites
 *     researcher output for a target audience.
 *
 * Pricing rationale: supervisor reasons (Sonnet), collaborators do
 * narrow tasks cheaply (Haiku). Realistic real-world pattern.
 *
 * The full demo (set $0.05 budget on the supervisor's role, invoke,
 * watch enforcement fire) lives in `docs/multi-agent.md`.
 *
 * Off by default; only deployed when both `bbg:enableGateway` and
 * `bbg:enableMultiAgent` context flags are true.
 */
export class MultiAgentStack extends cdk.Stack {
  readonly supervisorAgentId: string;
  readonly supervisorAliasId: string;
  readonly researcherAgentId: string;
  readonly summarizerAgentId: string;

  constructor(scope: Construct, id: string, props: MultiAgentStackProps) {
    super(scope, id, props);

    const { stagePrefix } = props;

    // Inference profile ARNs (CRIS / Cross-Region) for Anthropic
    // Claude. Bedrock Agents require model ARNs (or inference-profile
    // ARNs); using `us.` prefix profiles so the agents work in any
    // metered us-* region.
    const sonnetProfile = `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6`;
    const haikuProfile = `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`;

    /** Service role each agent assumes to invoke its model. */
    const buildAgentRole = (id: string, modelArn: string): iam.Role => {
      const role = new iam.Role(this, `${id}Role`, {
        roleName: `${stagePrefix}-bbg-agent-${id.toLowerCase()}`,
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: {
              'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:agent/*`,
            },
          },
        }),
        description: `BBG demo agent service role (${id}). Scoped to InvokeModel on ${modelArn}.`,
      });
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
            'bedrock:Converse',
            'bedrock:ConverseStream',
          ],
          resources: [
            modelArn,
            // CRIS profiles require permission on the underlying foundation
            // model ARNs as well. Wildcards on the bedrock:: namespace are
            // standard practice for agent service roles.
            `arn:aws:bedrock:*::foundation-model/*`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          ],
        }),
      );
      return role;
    };

    const researcherRole = buildAgentRole('Researcher', haikuProfile);
    const summarizerRole = buildAgentRole('Summarizer', haikuProfile);
    const supervisorRole = buildAgentRole('Supervisor', sonnetProfile);

    // Two collaborator agents on Haiku.
    const researcher = new bedrock.CfnAgent(this, 'Researcher', {
      agentName: `${stagePrefix}-bbg-researcher`,
      agentResourceRoleArn: researcherRole.roleArn,
      foundationModel: haikuProfile,
      idleSessionTtlInSeconds: 1800,
      instruction:
        'You are a researcher. Given a topic, produce 2-3 short factual bullets ' +
        'that another agent will later summarize. Stay terse: <80 words total. ' +
        'Do not preface; just bullets.',
      autoPrepare: true,
    });
    this.researcherAgentId = researcher.attrAgentId;

    const summarizer = new bedrock.CfnAgent(this, 'Summarizer', {
      agentName: `${stagePrefix}-bbg-summarizer`,
      agentResourceRoleArn: summarizerRole.roleArn,
      foundationModel: haikuProfile,
      idleSessionTtlInSeconds: 1800,
      instruction:
        'You are a summarizer. Given research bullets, rewrite them as a ' +
        'one-paragraph briefing aimed at an executive reader. Keep it under 100 words.',
      autoPrepare: true,
    });
    this.summarizerAgentId = summarizer.attrAgentId;

    // Aliases for the collaborators (multi-agent collaboration requires
    // alias ARNs to associate, not bare agent IDs).
    const researcherAlias = new bedrock.CfnAgentAlias(this, 'ResearcherAlias', {
      agentId: researcher.attrAgentId,
      agentAliasName: 'live',
    });
    researcherAlias.addDependency(researcher);
    const summarizerAlias = new bedrock.CfnAgentAlias(this, 'SummarizerAlias', {
      agentId: summarizer.attrAgentId,
      agentAliasName: 'live',
    });
    summarizerAlias.addDependency(summarizer);

    // Supervisor on Sonnet, with collaboration enabled and the two
    // collaborators wired in via their alias ARNs. The CfnAgent
    // collaboration syntax is verbose — each collaborator gets a
    // `collaborationInstruction` that the supervisor uses to decide
    // when to delegate.
    const supervisor = new bedrock.CfnAgent(this, 'Supervisor', {
      agentName: `${stagePrefix}-bbg-supervisor`,
      agentResourceRoleArn: supervisorRole.roleArn,
      foundationModel: sonnetProfile,
      idleSessionTtlInSeconds: 1800,
      instruction:
        'You are a supervisor agent that delegates work between two ' +
        'subordinates. Use the Researcher to gather facts and the ' +
        'Summarizer to produce the final response. Always call them in ' +
        'that order. Reply with the summarizer\'s output verbatim.',
      autoPrepare: true,
      agentCollaboration: 'SUPERVISOR',
      agentCollaborators: [
        {
          collaboratorName: 'researcher',
          agentDescriptor: { aliasArn: researcherAlias.attrAgentAliasArn },
          collaborationInstruction:
            'Call this collaborator first to gather 2-3 factual bullets on the user\'s topic.',
          relayConversationHistory: 'TO_COLLABORATOR',
        },
        {
          collaboratorName: 'summarizer',
          agentDescriptor: { aliasArn: summarizerAlias.attrAgentAliasArn },
          collaborationInstruction:
            'Call this collaborator after the researcher returns. Pass the ' +
            'researcher bullets as input; ask for an executive-style paragraph.',
          relayConversationHistory: 'TO_COLLABORATOR',
        },
      ],
    });
    supervisor.addDependency(researcherAlias);
    supervisor.addDependency(summarizerAlias);
    this.supervisorAgentId = supervisor.attrAgentId;

    const supervisorAlias = new bedrock.CfnAgentAlias(this, 'SupervisorAlias', {
      agentId: supervisor.attrAgentId,
      agentAliasName: 'live',
    });
    supervisorAlias.addDependency(supervisor);
    this.supervisorAliasId = supervisorAlias.attrAgentAliasId;

    new cdk.CfnOutput(this, 'SupervisorAgentId', { value: supervisor.attrAgentId });
    new cdk.CfnOutput(this, 'SupervisorAliasId', { value: supervisorAlias.attrAgentAliasId });
    new cdk.CfnOutput(this, 'ResearcherAgentId', { value: researcher.attrAgentId });
    new cdk.CfnOutput(this, 'SummarizerAgentId', { value: summarizer.attrAgentId });
    new cdk.CfnOutput(this, 'GatewayApiUrl', { value: props.gateway.httpApi.apiEndpoint });
  }
}

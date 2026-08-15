#!/usr/bin/env python3
"""
Generates docs/architecture.drawio from a declarative zone/node/edge spec.

Why a generator: the hand-authored diagram had grown into a flat wall of ~35
equal-weight boxes as features were bolted on. This lays the system out as a
small number of functional PLANES (data plane / control plane / cross-account /
foundation), sizes every node box to fit a 2-line label under its icon (so text
never collides with the icon), and computes zone/node coordinates so nothing
overlaps. Re-run after architecture changes:  python3 scripts/gen-architecture-diagram.py

Render to PNG:  drawio --export --format png --scale 2 --no-sandbox \\
                  --output docs/architecture.png docs/architecture.drawio
"""
from __future__ import annotations
import html
from dataclasses import dataclass, field

# ---- node/zone geometry (px) ---------------------------------------------
NODE_W, NODE_H = 178, 150
ICON = 48
ICON_X = (NODE_W - ICON) // 2
ICON_Y = 16
TXT_Y = ICON_Y + ICON + 6           # label sits BELOW the icon — never overlaps
TXT_H = NODE_H - TXT_Y - 8
ZPAD_X = 18
ZTITLE_H = 30
ZPAD_BOT = 16
GX, GY = 20, 22                     # gaps between nodes within a zone

# ---- palette: (fill, stroke, fontColor) per plane ------------------------
PAL = {
    'actor':   ('#F5F5F5', '#5A6B86', '#232F3E'),
    'ingest':  ('#FCE4EC', '#E7157B', '#C2185B'),
    'meter':   ('#FFF3E8', '#ED7100', '#C25E00'),
    'state':   ('#F7E9FB', '#C925D1', '#9C1FA6'),
    'pricing': ('#E1F3F0', '#01A88D', '#017A66'),
    'web':     ('#EDE7F6', '#8C4FFF', '#6C3FD1'),
    'analytics':('#E9F5EA', '#3F8624', '#2E6319'),
    'xacct':   ('#EEF1F6', '#5A6B86', '#3B4A63'),
    'member':  ('#FFEBEE', '#DD344C', '#B0263A'),
    'ops':     ('#F2F2F2', '#879196', '#5A6470'),
}
# AWS category tint used for the small icon tile behind each resource icon.
ICON_FILL = {
    'actor': '#232F3D', 'ingest': '#E7157B', 'meter': '#ED7100', 'state': '#C925D1',
    'pricing': '#01A88D', 'web': '#8C4FFF', 'analytics': '#3F8624', 'xacct': '#5A6B86',
    'member': '#DD344C', 'ops': '#879196',
}

@dataclass
class Node:
    nid: str
    icon: str            # mxgraph.aws4.<name>
    title: str
    sub: str = ''

@dataclass
class Zone:
    zid: str
    title: str
    plane: str
    x: int
    y: int
    cols: int
    nodes: list = field(default_factory=list)
    dashed: bool = False
    def width(self):
        c = self.cols
        return ZPAD_X * 2 + c * NODE_W + (c - 1) * GX
    def rows(self):
        return (len(self.nodes) + self.cols - 1) // self.cols
    def height(self):
        r = self.rows()
        return ZTITLE_H + r * NODE_H + (r - 1) * GY + ZPAD_BOT

@dataclass
class Edge:
    src: str
    dst: str
    label: str = ''
    color: str = '#5A6B86'
    dashed: bool = False
    exit: tuple | None = None    # (x,y) 0..1 on source
    entry: tuple | None = None   # (x,y) 0..1 on target
    step: int | None = None      # if set, a numbered badge is drawn on the edge
    badge_at: float = -0.6       # position along the -1..1 edge axis (source end ≈ -1)
    badge_dy: int = 0            # perpendicular nudge (px) to clear node labels

@dataclass
class Step:
    n: int
    title: str
    desc: str

BADGE = '#007CBD'   # teal step-badge fill (AWS reference-arch convention)

def esc(s: str) -> str:
    return html.escape(s, quote=True)

def label_html(title: str, sub: str) -> str:
    """Rich label for a node's value attribute. The HTML tags MUST be
    entity-escaped (&lt;b&gt;…) — a raw '<' in an XML attribute value is invalid
    XML and makes draw.io stop parsing (that was the v1/v2 render bug). We build
    the markup, then escape the whole thing so tags become &lt;…&gt; and the
    text is escaped too."""
    inner = f'<b>{title}</b>'
    if sub:
        inner += f'<div><i>{sub}</i></div>'
    return esc(inner)

cells: list[str] = []

def emit(s: str):
    cells.append(s)

def render_zone(z: Zone):
    """Emit the zone box + every node at ABSOLUTE canvas coordinates.

    Everything is parent="1" (no container nesting): draw.io renders nested
    resourceIcon children unreliably in headless export, so we compute absolute
    positions ourselves. Icon and text occupy disjoint y-ranges within each node
    card, so a label can never overlap its icon.
    """
    fill, stroke, fc = PAL[z.plane]
    dash = 'dashed=1;dashPattern=8 4;' if z.dashed else ''
    emit(f'<mxCell id="{z.zid}" value="{esc(z.title)}" '
         f'style="rounded=1;whiteSpace=wrap;html=1;fillColor={fill};strokeColor={stroke};'
         f'fontColor={fc};fontStyle=1;fontSize=13;verticalAlign=top;align=left;spacingLeft=12;'
         f'spacingTop=8;{dash}shadow=0;strokeWidth=1.5;fontFamily=Helvetica;" '
         f'vertex="1" parent="1"><mxGeometry x="{z.x}" y="{z.y}" width="{z.width()}" height="{z.height()}" as="geometry"/></mxCell>')
    for i, n in enumerate(z.nodes):
        col = i % z.cols
        row = i // z.cols
        nx = z.x + ZPAD_X + col * (NODE_W + GX)
        ny = z.y + ZTITLE_H + row * (NODE_H + GY)
        # node card (absolute)
        emit(f'<mxCell id="{n.nid}" value="" style="rounded=1;whiteSpace=wrap;html=1;'
             f'fillColor=#FFFFFF;strokeColor={stroke};strokeWidth=1;shadow=0;fontFamily=Helvetica;" '
             f'vertex="1" parent="1"><mxGeometry x="{nx}" y="{ny}" width="{NODE_W}" height="{NODE_H}" as="geometry"/></mxCell>')
        # icon (absolute), label suppressed on the icon itself
        emit(f'<mxCell id="{n.nid}-i" value="" style="sketch=0;outlineConnect=0;fontColor=#232F3E;'
             f'fillColor={ICON_FILL[z.plane]};strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;'
             f'labelPosition=center;verticalAlign=top;align=center;html=1;fontSize=10;aspect=fixed;'
             f'shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{n.icon};fontFamily=Helvetica;" '
             f'vertex="1" parent="1"><mxGeometry x="{nx+ICON_X}" y="{ny+ICON_Y}" width="{ICON}" height="{ICON}" as="geometry"/></mxCell>')
        # text under icon (absolute) — disjoint y-range from the icon
        emit(f'<mxCell id="{n.nid}-t" value="{label_html(n.title, n.sub)}" '
             f'style="text;html=1;align=center;verticalAlign=top;whiteSpace=wrap;spacing=2;'
             f'fontSize=11;fontColor={fc};fontFamily=Helvetica;" vertex="1" parent="1">'
             f'<mxGeometry x="{nx+4}" y="{ny+TXT_Y}" width="{NODE_W-8}" height="{TXT_H}" as="geometry"/></mxCell>')

def render_edge(e: Edge, idx: int):
    style = (f'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;'
             f'strokeColor={e.color};strokeWidth=1.5;jettySize=auto;orthogonalLoop=1;'
             f'fontFamily=Helvetica;fontSize=9;fontColor={e.color};labelBackgroundColor=#FFFFFF;')
    if e.dashed:
        style += 'dashed=1;dashPattern=6 4;'
    if e.exit:
        style += f'exitX={e.exit[0]};exitY={e.exit[1]};exitDx=0;exitDy=0;'
    if e.entry:
        style += f'entryX={e.entry[0]};entryY={e.entry[1]};entryDx=0;entryDy=0;'
    eid = f'e{idx}'
    emit(f'<mxCell id="{eid}" value="{esc(e.label)}" style="{style}" edge="1" parent="1" '
         f'source="{e.src}" target="{e.dst}"><mxGeometry relative="1" as="geometry"/></mxCell>')
    # Numbered step badge pinned NEAR THE SOURCE END of the edge (x≈-0.7 along
    # the -1..1 edge axis), so it sits in the open channel just off the
    # originating node instead of at the midpoint (which often bends over a box).
    if e.step is not None:
        emit(f'<mxCell id="{eid}-b" value="{e.step}" style="ellipse;whiteSpace=wrap;html=1;'
             f'fillColor={BADGE};strokeColor=#FFFFFF;strokeWidth=2;fontColor=#FFFFFF;fontStyle=1;'
             f'fontSize=13;fontFamily=Helvetica;" vertex="1" connectable="0" parent="{eid}">'
             f'<mxGeometry x="{e.badge_at}" y="0" width="26" height="26" relative="1" as="geometry">'
             f'<mxPoint x="0" y="{e.badge_dy}" as="offset"/></mxGeometry></mxCell>')

def render_legend(steps: list, x: int, y: int, w: int):
    """Right-side numbered legend panel — the prose for each hot-path step, so
    the canvas keeps small numbered badges instead of long inline edge labels
    (AWS reference-architecture convention)."""
    row_h = 46
    h = 40 + len(steps) * row_h
    emit(f'<mxCell id="legend-box" value="Data flow" style="rounded=1;whiteSpace=wrap;html=1;'
         f'fillColor=#F7F9FC;strokeColor=#B4C0D3;fontColor=#232F3E;fontStyle=1;fontSize=15;'
         f'verticalAlign=top;align=left;spacingLeft=14;spacingTop=10;shadow=0;strokeWidth=1.5;'
         f'fontFamily=Helvetica;" vertex="1" parent="1">'
         f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/></mxCell>')
    for i, s in enumerate(steps):
        ry = 40 + i * row_h
        emit(f'<mxCell id="legend-{s.n}-b" value="{s.n}" style="ellipse;whiteSpace=wrap;html=1;'
             f'fillColor={BADGE};strokeColor=#FFFFFF;strokeWidth=2;fontColor=#FFFFFF;fontStyle=1;'
             f'fontSize=13;fontFamily=Helvetica;" vertex="1" parent="1">'
             f'<mxGeometry x="{x+14}" y="{y+ry}" width="26" height="26" as="geometry"/></mxCell>')
        emit(f'<mxCell id="legend-{s.n}-t" value="{label_html(s.title, s.desc)}" '
             f'style="text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;spacing=2;'
             f'fontSize=11;fontColor=#232F3E;fontFamily=Helvetica;" vertex="1" parent="1">'
             f'<mxGeometry x="{x+50}" y="{y+ry-2}" width="{w-64}" height="{row_h}" as="geometry"/></mxCell>')

# ==========================================================================
#  SPEC  — the whole architecture as data. Edit here; layout is computed.
# ==========================================================================
zones: list[Zone] = []
edges: list[Edge] = []
steps: list = []

# The spec + layout is filled in build() so the file stays importable/testable.
def build():
    global zones, edges
    zones = []
    edges = []
    # --- geometry lanes -----------------------------------------------------
    # We arrange planes top→bottom. Data plane (the story) on top, then the
    # control/admin plane, analytics, and a foundation band. Cross-account sits
    # to the right spanning the data + control planes.
    LEFT = 40
    TOP = 150

    # ----- DATA PLANE (top band) -------------------------------------------
    actors = Zone('z-actors', 'Actors', 'actor', LEFT, TOP, 1, [
        Node('n-callers', 'users', 'Bedrock callers', 'IAM users / roles / SSO / Agents'),
        Node('n-operators', 'user', 'Operators', 'super-admin / per-account admin'),
    ])
    zones.append(actors)

    ingest_x = actors.x + actors.width() + 40
    ingest = Zone('z-ingest', 'Ingest & identity', 'ingest', ingest_x, TOP, 2, [
        Node('n-bedrock', 'bedrock', 'Bedrock', 'InvokeModel / Converse'),
        Node('n-cwl', 'cloudwatch_2', 'CloudWatch Logs', 'invocation logs (token counts)'),
        Node('n-cloudtrail', 'cloudtrail', 'CloudTrail', 'identity + requestId'),
        Node('n-eventbridge', 'eventbridge', 'EventBridge', 'default bus'),
        Node('n-identity', 'lambda', 'identity-cache', 'canonicalize principal ARN'),
    ])
    zones.append(ingest)

    meter_x = ingest.x + ingest.width() + 40
    # Layout (2 cols): row0 [meter | enforcement], row1 [notify | IAM deny],
    # row2 [period-rollover]. IAM deny sits directly BELOW enforcement (right
    # column) so the "attach deny" edge is a clean vertical drop in its own
    # column, clear of every other node's label.
    meter = Zone('z-meter', 'Meter & enforce', 'meter', meter_x, TOP, 2, [
        Node('n-meter', 'lambda', 'meter', 'requestId join, USD, discount'),
        Node('n-enforce', 'lambda', 'enforcement', 'attach bbg-deny-* on breach'),
        Node('n-notify', 'lambda', 'notify', 'SES: user / admin / ops-fallback'),
        Node('n-iamdeny', 'identity_and_access_management', 'IAM deny', 'bbg-deny-* policies'),
        Node('n-rollover', 'lambda', 'period-rollover', 'detach + reset (scheduled)'),
    ])
    zones.append(meter)

    state_x = meter.x + meter.width() + 40
    state = Zone('z-state', 'State (DynamoDB)', 'state', state_x, TOP, 1, [
        Node('n-ddb-core', 'dynamodb', 'Budgets · RunningSpend', 'RateCounters · IdentityCache'),
        Node('n-ddb-activity', 'dynamodb', 'PrincipalActivity', '+ byDay GSI (central feed)'),
        Node('n-ddb-pricing', 'dynamodb', 'Pricing', 'rates + discount#* rows'),
    ])
    zones.append(state)

    # ----- CONTROL / ADMIN PLANE (second band) -----------------------------
    band2_y = TOP + max(ingest.height(), meter.height()) + 46

    web = Zone('z-web', 'Admin & web plane', 'web', LEFT, band2_y, 3, [
        Node('n-cloudfront', 'cloudfront', 'CloudFront', 'React SPA + WAFv2'),
        Node('n-s3web', 's3', 'S3', 'web bundle'),
        Node('n-cognito', 'cognito', 'Cognito', 'passkey + bbg:scope'),
        Node('n-pretoken', 'lambda', 'pre-token-gen', 'emits bbg:scope claim'),
        Node('n-apigw', 'api_gateway', 'HTTP API', 'JWT authorizer'),
        Node('n-apilambdas', 'lambda', 'API handlers', 'budgets · spend · activity · pricing · users · enroll · audit · readiness'),
    ])
    zones.append(web)

    pricing_x = web.x + web.width() + 40
    pricing = Zone('z-pricing', 'Pricing & discounts', 'pricing', pricing_x, band2_y, 1, [
        Node('n-pricingref', 'lambda', 'pricing-refresher', 'daily · Pricing API'),
        Node('n-discountres', 'lambda', 'org-discount-resolver', 'hourly + on-write · Org walk → effectivePct'),
    ])
    zones.append(pricing)

    analytics_x = pricing.x + pricing.width() + 40
    analytics = Zone('z-analytics', 'Analytics & reconciliation', 'analytics', analytics_x, band2_y, 2, [
        Node('n-ledger', 'lambda', 'ledger-writer', 'DDB stream → S3'),
        Node('n-s3ledger', 's3', 'S3 ledger', 'append-only JSONL'),
        Node('n-athena', 'athena', 'Athena', 'Reports (ad-hoc)'),
        Node('n-cur', 'lambda', 'cur-reconciler', 'daily vs CUR 2.0'),
    ])
    zones.append(analytics)

    # ----- CROSS-ACCOUNT (right, spans the two bands) ----------------------
    xacct_x = state.x + state.width() + 46
    xacct = Zone('z-xacct', 'Cross-account (Org-wide)', 'xacct', xacct_x, TOP, 1, [
        Node('n-org', 'organizations', 'Organizations', 'account / OU tree'),
        Node('n-stackset', 'cloudformation', 'StackSets', 'member role provisioning'),
    ])
    zones.append(xacct)
    member_y = xacct.y + xacct.height() + 22
    member = Zone('z-member', 'Enrolled member account (×N)', 'member', xacct_x, member_y, 1, [
        Node('n-mbedrock', 'bedrock', 'Bedrock', 'in member account'),
        Node('n-mfwd', 'lambda', 'cwl-forwarder', 'PutEvents → home bus'),
        Node('n-miam', 'identity_and_access_management', 'bbg-enforcement', 'assumed via STS'),
    ], dashed=True)
    zones.append(member)

    # ----- FOUNDATION BAND (bottom, de-emphasized, single row) -------------
    found_y = band2_y + max(web.height(), analytics.height()) + 46
    foundation = Zone('z-foundation', 'Foundation & operations', 'ops', LEFT, found_y, 6, [
        Node('n-dash', 'cloudwatch_2', 'CloudWatch', 'dashboards + alarms'),
        Node('n-sns', 'sns', 'SNS', 'alarm fan-out'),
        Node('n-kms', 'key_management_service', 'KMS', 'CMK encryption'),
        Node('n-config', 'config', 'AWS Config', 'posture rules'),
        Node('n-waf', 'waf', 'WAFv2', 'prod CloudFront'),
        Node('n-pipeline', 'cloudformation', 'CDK Pipelines', 'GitOps deploy'),
    ])
    zones.append(foundation)

    # ---- EDGES ------------------------------------------------------------
    # The primary hot path carries NUMBERED BADGES (prose lives in the right
    # legend panel — AWS reference-arch convention). Secondary edges are thin,
    # mostly dashed, and UNLABELED so they don't compete with the numbered spine.
    C = {'flow': '#01A88D', 'ctrl': '#8C4FFF', 'price': '#017A66', 'x': '#8795A8', 'enf': '#DD344C'}
    edges += [
        # ---- primary real-time hot path (numbered) ----
        Edge('n-callers', 'n-bedrock', color=C['flow'], step=1, exit=(1, 0.5), entry=(0, 0.5)),
        Edge('n-bedrock', 'n-cwl', color=C['flow'], step=2),
        Edge('n-bedrock', 'n-cloudtrail', color=C['flow'], step=3),
        Edge('n-cwl', 'n-meter', color=C['flow']),
        Edge('n-cloudtrail', 'n-eventbridge', color=C['flow']),
        Edge('n-eventbridge', 'n-meter', color=C['flow'], step=4),
        Edge('n-identity', 'n-meter', color=C['flow'], dashed=True),
        # meter is NOT adjacent to State — enforcement sits between them — so a
        # straight meter→State line would cross the enforcement node. Route it up
        # and over: exit meter's TOP, travel the channel above the Meter cells,
        # drop into RunningSpend's top. enforcement reads the stream back the
        # other way at the title row (its right edge IS adjacent to State).
        Edge('n-meter', 'n-ddb-core', color=C['flow'], step=5, exit=(0.5, 0), entry=(0.5, 0), badge_at=0.0),
        # ---- enforce / notify off the RunningSpend stream (numbered) ----
        Edge('n-ddb-core', 'n-enforce', color=C['enf'], step=6, entry=(1, 0.32), exit=(0, 0.32), badge_at=0.35, badge_dy=-14),
        # enforcement → IAM deny: clean vertical drop in the right column (IAM
        # deny now sits directly below enforcement).
        Edge('n-enforce', 'n-iamdeny', color=C['enf'], step=7, exit=(0.5, 1), entry=(0.5, 0), badge_at=-0.55),
        # notify also reacts to the stream. Enter notify from the TOP (like the
        # other reactors) via a short drop from enforcement's row, not a loop.
        Edge('n-ddb-core', 'n-notify', color=C['enf'], entry=(0.5, 0), exit=(0, 0.7)),
        # ---- pricing + discounts feed the Pricing table (numbered 8) ----
        Edge('n-pricingref', 'n-ddb-pricing', color=C['price'], exit=(1, 0.5), entry=(0, 0.65)),
        Edge('n-discountres', 'n-ddb-pricing', color=C['price'], step=8, exit=(1, 0.5), badge_at=-0.85),
        Edge('n-discountres', 'n-org', color=C['price'], dashed=True, exit=(1, 0.2), entry=(0, 1)),
        # ---- admin / web plane (unlabeled connectors) ----
        Edge('n-cloudfront', 'n-apigw', color=C['ctrl']),
        Edge('n-apigw', 'n-apilambdas', color=C['ctrl']),
        Edge('n-apilambdas', 'n-ddb-core', color=C['ctrl'], step=9, exit=(1, 0.3), entry=(0.5, 1), badge_at=-0.85),
        # ---- analytics (unlabeled) ----
        Edge('n-ddb-core', 'n-ledger', color=C['x'], dashed=True, exit=(0.4, 1)),
        Edge('n-ledger', 'n-s3ledger', color=C['x']),
        Edge('n-s3ledger', 'n-athena', color=C['x']),
        # ---- cross-account (numbered 10/11) ----
        Edge('n-stackset', 'n-miam', color=C['x'], dashed=True, exit=(0.5, 1), entry=(1, 0.5)),
        Edge('n-mfwd', 'n-eventbridge', color=C['x'], step=10, dashed=True, exit=(0, 0.5), badge_at=-0.85),
        Edge('n-enforce', 'n-miam', color=C['enf'], step=11, dashed=True, exit=(0.5, 1), entry=(0, 0.5), badge_at=0.85),
    ]

    global steps
    steps = [
        Step(1, 'Invoke', 'Caller (IAM user/role, SSO, or Agent) calls InvokeModel / Converse on Amazon Bedrock.'),
        Step(2, 'Invocation log', 'Bedrock writes token + dimension counts (no prompts) to CloudWatch Logs.'),
        Step(3, 'Identity', 'CloudTrail records the caller identity + requestId onto the default EventBridge bus.'),
        Step(4, 'Join', 'meter joins the log with the canonicalized identity on requestId and computes USD across all dimensions.'),
        Step(5, 'Add spend', 'Idempotent ADD into the per-principal × per-target RunningSpend row (scaled by the effective discount).'),
        Step(6, 'Stream', 'The RunningSpend stream drives enforcement (and notify) on every update.'),
        Step(7, 'Deny', 'On a breached deny-budget, an IAM bbg-deny-* policy attaches to the principal. Sub-30s p95.'),
        Step(8, 'Resolve discounts', 'org-discount-resolver walks the Org tree (hourly + on-write) and materializes each account’s effective discount % onto its Pricing row.'),
        Step(9, 'Admin & web', 'Operators use the CloudFront SPA → HTTP API → per-route Lambdas to manage budgets, discounts, users, enrollment, and read spend/activity.'),
        Step(10, 'Cross-account ingest', 'Member-account Bedrock calls → cwl-forwarder → PutEvents on the home bus → same meter. Spend appears in home RunningSpend < 60s.'),
        Step(11, 'Cross-account enforce', 'enforcement assumes the bbg-enforcement role in the member account and attaches the deny there; period-rollover detaches.'),
    ]

def main():
    build()
    # Legend panel sits to the right of everything.
    LEGEND_W = 460
    zones_right = max(z.x + z.width() for z in zones)
    legend_x = zones_right + 46
    legend_y = 150
    maxx = legend_x + LEGEND_W + 60
    maxy = max(z.y + z.height() for z in zones) + 60
    for z in zones:
        render_zone(z)
    for i, e in enumerate(edges):
        render_edge(e, i)
    render_legend(steps, legend_x, legend_y, LEGEND_W)
    body = "\n        ".join(cells)
    doc = f'''<mxfile host="bbg-generator">
  <diagram name="BBG-Architecture" id="bbg-architecture">
    <mxGraphModel dx="1400" dy="900" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="{maxx}" pageHeight="{maxy}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <mxCell id="title-text" value="Bedrock Budget Guard" style="text;html=1;align=left;verticalAlign=top;fontSize=30;fontStyle=1;fontFamily=Helvetica;" vertex="1" parent="1"><mxGeometry x="40" y="34" width="1200" height="42" as="geometry"/></mxCell>
        <mxCell id="subtitle-text" value="Real-time per-IAM-principal x per-model Amazon Bedrock spend metering, budget enforcement, and hierarchical custom pricing discounts — multi-region + Org-wide" style="text;html=1;align=left;verticalAlign=top;fontSize=15;fontColor=#5A6470;fontFamily=Helvetica;" vertex="1" parent="1"><mxGeometry x="40" y="78" width="1600" height="24" as="geometry"/></mxCell>
        <mxCell id="title-rule" value="" style="line;strokeWidth=3;strokeColor=#FF9900;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="110" width="1600" height="8" as="geometry"/></mxCell>
        {body}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
'''
    with open('docs/architecture.drawio', 'w') as f:
        f.write(doc)
    print(f'wrote docs/architecture.drawio  canvas={maxx}x{maxy}  zones={len(zones)} nodes={sum(len(z.nodes) for z in zones)} edges={len(edges)}')

if __name__ == '__main__':
    main()

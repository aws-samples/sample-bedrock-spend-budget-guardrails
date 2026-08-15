"""Self-contained HTML report writer — Cloudscape Design System styling.

Generates a single HTML file per account (and a top-level org-summary.html
when running in org mode). Embeds CSS that uses Cloudscape Design System
design tokens (colors, typography, spacing, border-radius) drawn from the
official @cloudscape-design/design-tokens package, so the output matches
the look-and-feel of the AWS Console.

No external dependencies, no CDN calls — opens offline. Print-friendly.
"""
from __future__ import annotations

from html import escape
from pathlib import Path

from core.models import AccountFindings, OrgFindings, Readiness


READINESS_BADGE = {
    Readiness.GREEN: ("✓", "GREEN", "status-success"),
    Readiness.YELLOW: ("!", "YELLOW", "status-warning"),
    Readiness.RED: ("⊗", "RED", "status-error"),
    Readiness.UNKNOWN: ("—", "UNKNOWN", "status-neutral"),
}


# Cloudscape Design System tokens (Visual Refresh defaults, light mode).
# Sourced from @cloudscape-design/design-tokens v3.0.x. We embed the
# defaults as CSS custom properties so the report stays self-contained.
CSS = """
:root {
  /* Typography */
  --awsui-font-family-base: 'Open Sans', 'Helvetica Neue', Roboto, Arial, sans-serif;
  --awsui-font-family-mono: Monaco, Menlo, Consolas, 'Courier New', monospace;
  --awsui-font-size-body-s: 12px;
  --awsui-font-size-body-m: 14px;
  --awsui-font-size-heading-xs: 14px;
  --awsui-font-size-heading-s: 16px;
  --awsui-font-size-heading-m: 18px;
  --awsui-font-size-heading-l: 20px;
  --awsui-font-size-heading-xl: 24px;
  --awsui-line-height-body-m: 20px;
  --awsui-line-height-heading-xl: 30px;
  --awsui-font-weight-normal: 400;
  --awsui-font-weight-bold: 700;

  /* Color: text */
  --awsui-color-text-body-default: #0f141a;
  --awsui-color-text-body-secondary: #424650;
  --awsui-color-text-accent: #006ce0;
  --awsui-color-text-link-default: #006ce0;
  --awsui-color-text-link-hover: #002b66;
  --awsui-color-text-status-success: #00802f;
  --awsui-color-text-status-warning: #855900;
  --awsui-color-text-status-error: #db0000;
  --awsui-color-text-status-info: #006ce0;
  --awsui-color-text-breadcrumb-current: #656871;

  /* Color: background */
  --awsui-color-background-layout-main: #ffffff;
  --awsui-color-background-container-content: #ffffff;
  --awsui-color-background-cell-shaded: #f6f6f9;
  --awsui-color-background-status-success: #effff1;
  --awsui-color-background-status-warning: #fffef0;
  --awsui-color-background-status-error: #fff5f5;
  --awsui-color-background-status-info: #f0fbff;
  --awsui-color-background-home-header: #0f141a;
  --awsui-color-background-button-primary-default: #006ce0;

  /* Color: borders */
  --awsui-color-border-divider-default: #c6c6cd;
  --awsui-color-border-divider-secondary: #ebebf0;
  --awsui-color-border-status-success: #00802f;
  --awsui-color-border-status-warning: #855900;
  --awsui-color-border-status-error: #db0000;
  --awsui-color-border-status-info: #006ce0;

  /* Spacing */
  --awsui-space-xxxs: 2px;
  --awsui-space-xxs: 4px;
  --awsui-space-xs: 8px;
  --awsui-space-s: 12px;
  --awsui-space-m: 16px;
  --awsui-space-l: 20px;
  --awsui-space-xl: 24px;
  --awsui-space-xxl: 32px;
  --awsui-space-xxxl: 40px;

  /* Border radius */
  --awsui-border-radius-badge: 4px;
  --awsui-border-radius-alert: 12px;
  --awsui-border-radius-card: 16px;
  --awsui-border-radius-button: 20px;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  font-family: var(--awsui-font-family-base);
  font-size: var(--awsui-font-size-body-m);
  line-height: var(--awsui-line-height-body-m);
  color: var(--awsui-color-text-body-default);
  background: var(--awsui-color-background-layout-main);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

a {
  color: var(--awsui-color-text-link-default);
  text-decoration: none;
}
a:hover { color: var(--awsui-color-text-link-hover); text-decoration: underline; }

/* ───── App shell: sidebar + main content (Cloudscape AppLayout pattern) ───── */
.app-shell {
  display: grid;
  grid-template-columns: 260px 1fr;
  min-height: calc(100vh - 100px);  /* leave room for service header */
}
.sidebar {
  background: var(--awsui-color-background-cell-shaded);
  border-right: 1px solid var(--awsui-color-border-divider-default);
  padding: var(--awsui-space-l) 0;
  position: sticky;
  top: 0;
  align-self: start;
  max-height: 100vh;
  overflow-y: auto;
}
.sidebar-section {
  margin-bottom: var(--awsui-space-l);
}
.sidebar-section-title {
  font-size: var(--awsui-font-size-body-s);
  font-weight: var(--awsui-font-weight-bold);
  color: var(--awsui-color-text-body-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 var(--awsui-space-l);
  margin-bottom: var(--awsui-space-xs);
}
.sidebar nav a {
  display: block;
  padding: var(--awsui-space-xs) var(--awsui-space-l);
  color: var(--awsui-color-text-body-default);
  font-size: var(--awsui-font-size-body-m);
  font-weight: var(--awsui-font-weight-normal);
  text-decoration: none;
  border-left: 3px solid transparent;
}
.sidebar nav a:hover {
  background: var(--awsui-color-background-container-content);
  text-decoration: none;
}
.sidebar nav a.active {
  background: var(--awsui-color-background-container-content);
  color: var(--awsui-color-text-accent);
  font-weight: var(--awsui-font-weight-bold);
  border-left-color: var(--awsui-color-text-accent);
}
.sidebar nav a .nav-count {
  float: right;
  color: var(--awsui-color-text-body-secondary);
  font-size: var(--awsui-font-size-body-s);
  background: var(--awsui-color-background-cell-shaded);
  padding: 0 6px;
  border-radius: 999px;
  margin-top: 2px;
}
.sidebar nav a.active .nav-count {
  background: var(--awsui-color-background-status-info);
  color: var(--awsui-color-text-status-info);
}

.main-pane {
  padding: var(--awsui-space-l) var(--awsui-space-xl);
  max-width: 1280px;
}

/* SPA section visibility */
.section {
  display: none;
}
.section.active {
  display: block;
}

/* Section header inside the main pane */
.section-header {
  margin-bottom: var(--awsui-space-l);
}
.section-header h1 {
  font-size: var(--awsui-font-size-heading-xl);
  line-height: var(--awsui-line-height-heading-xl);
  font-weight: var(--awsui-font-weight-bold);
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--awsui-space-m);
  flex-wrap: wrap;
}
.section-header .description {
  margin-top: var(--awsui-space-xs);
  font-size: var(--awsui-font-size-body-m);
  color: var(--awsui-color-text-body-secondary);
}

/* ───── Home dashboard ───── */
.kpi-strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--awsui-space-m);
  margin-bottom: var(--awsui-space-l);
  padding: var(--awsui-space-l);
  background: var(--awsui-color-background-container-content);
  border: 1px solid var(--awsui-color-border-divider-default);
  border-radius: var(--awsui-border-radius-card);
}
.kpi-strip .kpi-item .kpi-label {
  font-size: var(--awsui-font-size-body-s);
  color: var(--awsui-color-text-body-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: var(--awsui-space-xxs);
}
.kpi-strip .kpi-item .kpi-value {
  font-size: var(--awsui-font-size-heading-l);
  font-weight: var(--awsui-font-weight-bold);
  color: var(--awsui-color-text-body-default);
}

.snippet-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--awsui-space-l);
}
.snippet-card {
  background: var(--awsui-color-background-container-content);
  border: 1px solid var(--awsui-color-border-divider-default);
  border-radius: var(--awsui-border-radius-card);
  padding: var(--awsui-space-l) var(--awsui-space-xl);
  display: flex;
  flex-direction: column;
}
.snippet-card h3 {
  margin: 0 0 var(--awsui-space-s) 0;
  font-size: var(--awsui-font-size-heading-s);
  font-weight: var(--awsui-font-weight-bold);
  color: var(--awsui-color-text-body-default);
}
.snippet-card .snippet-body {
  flex: 1;
  font-size: var(--awsui-font-size-body-m);
  color: var(--awsui-color-text-body-default);
  margin-bottom: var(--awsui-space-m);
}
.snippet-card .snippet-body ul,
.snippet-card .snippet-body ol {
  margin: 0;
  padding-left: var(--awsui-space-l);
}
.snippet-card .snippet-body ul li,
.snippet-card .snippet-body ol li {
  margin-bottom: var(--awsui-space-xxs);
}
.snippet-card a.see-all {
  font-size: var(--awsui-font-size-body-s);
  font-weight: var(--awsui-font-weight-bold);
  color: var(--awsui-color-text-link-default);
  margin-top: auto;
  align-self: flex-start;
}
.snippet-card a.see-all:hover {
  color: var(--awsui-color-text-link-hover);
}

/* ---- Service header (top dark banner, like Cloudscape's home header) ---- */
.service-header {
  background: var(--awsui-color-background-home-header);
  color: #ffffff;
  padding: var(--awsui-space-xxl) 0;
  margin-bottom: var(--awsui-space-xl);
}
.service-header .layout {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 var(--awsui-space-xl);
}
.service-header .breadcrumb {
  font-size: var(--awsui-font-size-body-s);
  color: #b4b4bb;
  margin-bottom: var(--awsui-space-xs);
}
.service-header .breadcrumb code {
  background: rgba(255,255,255,0.10);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--awsui-font-family-mono);
  color: #ebebf0;
}
.service-header h1 {
  font-size: var(--awsui-font-size-heading-xl);
  line-height: var(--awsui-line-height-heading-xl);
  font-weight: var(--awsui-font-weight-bold);
  margin: 0 0 var(--awsui-space-xs) 0;
  color: #ffffff;
}
.service-header .meta {
  font-size: var(--awsui-font-size-body-s);
  color: #d6d6dd;
}
.service-header .meta strong { color: #ffffff; }
.service-header .meta code {
  background: rgba(255,255,255,0.10);
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--awsui-font-family-mono);
  color: #ebebf0;
}

/* ---- Header relationship pill (under the H1) ---- */
.service-header .header-relationship {
  margin-top: 8px;
  margin-bottom: 4px;
}
.service-header .header-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  font-family: var(--awsui-font-family-base);
  letter-spacing: 0.2px;
}
.service-header .header-pill-mgmt {
  background: rgba(83, 145, 245, 0.18);
  color: #aac6f5;
  border: 1px solid rgba(83, 145, 245, 0.5);
}
.service-header .header-pill-member {
  background: rgba(167, 167, 173, 0.18);
  color: #d1d1d8;
  border: 1px solid rgba(167, 167, 173, 0.4);
}
.service-header .header-pill-standalone {
  background: rgba(245, 191, 91, 0.18);
  color: #f0d2a0;
  border: 1px solid rgba(245, 191, 91, 0.4);
}
.service-header .header-pill-org {
  background: rgba(120, 220, 160, 0.18);
  color: #b8e8c8;
  border: 1px solid rgba(120, 220, 160, 0.4);
}
.service-header .header-pill code {
  background: rgba(255,255,255,0.18);
  color: inherit;
  padding: 0 4px;
  border-radius: 3px;
  font-size: inherit;
}
.service-header .header-org-id {
  font-size: 0.7em;
  color: #a8a8b0;
  font-weight: 400;
  letter-spacing: 0;
  margin-left: 4px;
}

/* ---- Container (Cloudscape Container component) ---- */
.container {
  background: var(--awsui-color-background-container-content);
  border: 1px solid var(--awsui-color-border-divider-default);
  border-radius: var(--awsui-border-radius-card);
  margin-bottom: var(--awsui-space-l);
  overflow: hidden;
}
.container-header {
  padding: var(--awsui-space-l) var(--awsui-space-xl);
  border-bottom: 1px solid var(--awsui-color-border-divider-default);
  cursor: pointer;
  user-select: none;
  position: relative;
  transition: background 0.1s ease;
}
.container-header:hover {
  background: var(--awsui-color-background-cell-shaded);
}
.container-header .chevron {
  display: inline-block;
  width: 14px;
  margin-right: var(--awsui-space-xs);
  color: var(--awsui-color-text-body-secondary);
  font-size: var(--awsui-font-size-body-m);
  transition: transform 0.15s ease;
  vertical-align: middle;
}
.container.collapsed .chevron {
  transform: rotate(-90deg);
}
.container.collapsed .container-content {
  display: none;
}
.container.collapsed .container-header {
  border-bottom: none;
}
.expand-collapse-toolbar {
  display: flex;
  gap: var(--awsui-space-s);
  margin-bottom: var(--awsui-space-m);
  font-size: var(--awsui-font-size-body-s);
}
.expand-collapse-toolbar button {
  background: var(--awsui-color-background-container-content);
  border: 1px solid var(--awsui-color-border-divider-default);
  border-radius: var(--awsui-border-radius-button);
  padding: var(--awsui-space-xxs) var(--awsui-space-m);
  font-family: var(--awsui-font-family-base);
  font-size: var(--awsui-font-size-body-s);
  font-weight: var(--awsui-font-weight-normal);
  color: var(--awsui-color-text-link-default);
  cursor: pointer;
  transition: background 0.1s ease;
}
.expand-collapse-toolbar button:hover {
  background: var(--awsui-color-background-cell-shaded);
}
.container-header h2 {
  font-size: var(--awsui-font-size-heading-l);
  font-weight: var(--awsui-font-weight-bold);
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--awsui-space-m);
  flex-wrap: wrap;
}
.container-header .description {
  margin-top: var(--awsui-space-xs);
  margin-left: 22px;  /* align with the text after the chevron */
  font-size: var(--awsui-font-size-body-m);
  color: var(--awsui-color-text-body-secondary);
}
.container-content {
  padding: var(--awsui-space-l) var(--awsui-space-xl);
}
.container-content > h3 {
  font-size: var(--awsui-font-size-heading-s);
  font-weight: var(--awsui-font-weight-bold);
  margin: var(--awsui-space-l) 0 var(--awsui-space-s) 0;
  color: var(--awsui-color-text-body-default);
}
.container-content > h3:first-child { margin-top: 0; }

/* ---- Status indicator (icon + text) ---- */
.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--awsui-space-xxs);
  font-weight: var(--awsui-font-weight-bold);
  font-size: var(--awsui-font-size-body-m);
  padding: 2px 10px;
  border-radius: var(--awsui-border-radius-badge);
}
.status-indicator-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--awsui-font-weight-bold);
  width: 16px; height: 16px;
}
.status-success {
  color: var(--awsui-color-text-status-success);
  background: var(--awsui-color-background-status-success);
}
.status-warning {
  color: var(--awsui-color-text-status-warning);
  background: var(--awsui-color-background-status-warning);
}
.status-error {
  color: var(--awsui-color-text-status-error);
  background: var(--awsui-color-background-status-error);
}
.status-info {
  color: var(--awsui-color-text-status-info);
  background: var(--awsui-color-background-status-info);
}
.status-neutral {
  color: var(--awsui-color-text-body-secondary);
  background: var(--awsui-color-background-cell-shaded);
}

/* ---- Key-value pair grid (Cloudscape KeyValuePairs) ---- */
.kv-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--awsui-space-l) var(--awsui-space-xl);
}
.kv-item .kv-label {
  font-size: var(--awsui-font-size-body-s);
  color: var(--awsui-color-text-body-secondary);
  margin-bottom: var(--awsui-space-xxs);
}
.kv-item .kv-value {
  font-size: var(--awsui-font-size-heading-m);
  font-weight: var(--awsui-font-weight-bold);
  color: var(--awsui-color-text-body-default);
}
.kv-item .kv-value-small {
  font-size: var(--awsui-font-size-body-m);
  font-weight: var(--awsui-font-weight-normal);
}

/* ---- Alert / Notification (Cloudscape Alert) ---- */
.alert {
  display: flex;
  gap: var(--awsui-space-s);
  padding: var(--awsui-space-m) var(--awsui-space-l);
  border-radius: var(--awsui-border-radius-alert);
  border: 1px solid;
  margin: var(--awsui-space-m) 0;
}
.alert.alert-warning {
  border-color: var(--awsui-color-border-status-warning);
  background: var(--awsui-color-background-status-warning);
  color: var(--awsui-color-text-body-default);
}
.alert.alert-info {
  border-color: var(--awsui-color-border-status-info);
  background: var(--awsui-color-background-status-info);
}
.alert.alert-error {
  border-color: var(--awsui-color-border-status-error);
  background: var(--awsui-color-background-status-error);
}
.alert.alert-success {
  border-color: var(--awsui-color-border-status-success);
  background: var(--awsui-color-background-status-success);
}
.alert .alert-icon {
  font-weight: var(--awsui-font-weight-bold);
  flex-shrink: 0;
  font-size: var(--awsui-font-size-heading-s);
  line-height: 1.2;
}
.alert.alert-warning .alert-icon { color: var(--awsui-color-text-status-warning); }
.alert.alert-info .alert-icon { color: var(--awsui-color-text-status-info); }
.alert.alert-error .alert-icon { color: var(--awsui-color-text-status-error); }
.alert.alert-success .alert-icon { color: var(--awsui-color-text-status-success); }

/* ─── Next-steps playbook styling ────────────────────────────────────── */
.step-heading {
  display: flex;
  align-items: center;
  gap: var(--awsui-space-s);
  margin-top: var(--awsui-space-xl);
  margin-bottom: var(--awsui-space-s);
  font-size: var(--awsui-font-size-heading-m);
  font-weight: var(--awsui-font-weight-heading);
  color: var(--awsui-color-text-heading-default);
}
.step-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--awsui-color-background-button-primary-default);
  color: var(--awsui-color-text-button-primary-default);
  font-size: var(--awsui-font-size-body-m);
  font-weight: var(--awsui-font-weight-bold);
  flex-shrink: 0;
}
.step-caveat {
  font-size: var(--awsui-font-size-body-s);
  font-weight: var(--awsui-font-weight-normal);
  color: var(--awsui-color-text-body-secondary);
}
.code-block {
  background: var(--awsui-color-background-code-syntax-default);
  border: 1px solid var(--awsui-color-border-divider-default);
  border-radius: var(--awsui-border-radius-code-editor);
  padding: var(--awsui-space-m);
  margin: var(--awsui-space-s) 0 var(--awsui-space-m) 0;
  font-family: var(--awsui-font-family-monospace);
  font-size: var(--awsui-font-size-body-s);
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
  color: var(--awsui-color-text-body-default);
}
.code-block code {
  background: transparent;
  padding: 0;
  font-size: inherit;
  color: inherit;
}
.alert .alert-body { flex: 1; }
.alert .alert-header {
  font-weight: var(--awsui-font-weight-bold);
  margin-bottom: var(--awsui-space-xxs);
}

/* ---- Table (Cloudscape Table) ---- */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--awsui-font-size-body-m);
}
thead th {
  text-align: left;
  padding: var(--awsui-space-s) var(--awsui-space-m);
  background: var(--awsui-color-background-cell-shaded);
  font-weight: var(--awsui-font-weight-bold);
  color: var(--awsui-color-text-body-default);
  border-bottom: 1px solid var(--awsui-color-border-divider-default);
  cursor: pointer;
  user-select: none;
  position: sticky;
  top: 0;
}
thead th.sortable::after {
  content: " ⇅";
  color: var(--awsui-color-text-body-secondary);
  font-size: var(--awsui-font-size-body-s);
  font-weight: var(--awsui-font-weight-normal);
}
thead th.sort-asc::after { content: " ↑"; color: var(--awsui-color-text-accent); }
thead th.sort-desc::after { content: " ↓"; color: var(--awsui-color-text-accent); }
tbody td {
  padding: var(--awsui-space-s) var(--awsui-space-m);
  border-bottom: 1px solid var(--awsui-color-border-divider-secondary);
  vertical-align: top;
}
tbody tr:hover { background: var(--awsui-color-background-cell-shaded); }
tbody tr:last-child td { border-bottom: none; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.table-wrapper {
  border: 1px solid var(--awsui-color-border-divider-default);
  border-radius: 8px;
  overflow: hidden;
}

/* ---- Code & inline tags ---- */
code, .mono {
  font-family: var(--awsui-font-family-mono);
  font-size: var(--awsui-font-size-body-s);
  color: var(--awsui-color-text-body-default);
  background: var(--awsui-color-background-cell-shaded);
  padding: 1px 6px;
  border-radius: 3px;
  word-break: break-all;
}
.tag {
  display: inline-block;
  padding: 1px 8px;
  margin: 1px 2px;
  background: var(--awsui-color-background-cell-shaded);
  border: 1px solid var(--awsui-color-border-divider-secondary);
  border-radius: var(--awsui-border-radius-badge);
  font-family: var(--awsui-font-family-mono);
  font-size: var(--awsui-font-size-body-s);
}

/* ---- Lists ---- */
ol.recommendations, ul.bullets {
  margin: var(--awsui-space-s) 0;
  padding-left: var(--awsui-space-xl);
}
ol.recommendations li, ul.bullets li {
  margin-bottom: var(--awsui-space-xs);
}

/* ---- Footer ---- */
footer {
  margin-top: var(--awsui-space-xxxl);
  padding: var(--awsui-space-l) 0;
  text-align: center;
  font-size: var(--awsui-font-size-body-s);
  color: var(--awsui-color-text-body-secondary);
  border-top: 1px solid var(--awsui-color-border-divider-secondary);
}

/* ---- Print ---- */
@media print {
  body { font-size: 10pt; }
  .container { page-break-inside: avoid; box-shadow: none; }
  thead th { position: static; }
  thead { display: table-row-group; }
  .service-header { padding: 16px 0; }
  /* Print: show ALL sections + hide the sidebar */
  .sidebar { display: none; }
  .app-shell { grid-template-columns: 1fr; }
  .section { display: block !important; page-break-before: always; }
  .section[data-route="home"] { page-break-before: auto; }
  .expand-collapse-toolbar { display: none; }
}
"""


SORT_JS = """
// =====================================================================
// SPA routing: each <section data-route="..."> is a separate "page"
// =====================================================================

function getRouteFromHash() {
  return (location.hash || '#home').slice(1);
}

function showRoute(routeId) {
  var sections = document.querySelectorAll('.section');
  var found = false;
  sections.forEach(function(s) {
    if (s.getAttribute('data-route') === routeId) {
      s.classList.add('active');
      found = true;
    } else {
      s.classList.remove('active');
    }
  });
  if (!found) {
    var home = document.querySelector('.section[data-route="home"]');
    if (home) home.classList.add('active');
  }
  // Sidebar highlight
  document.querySelectorAll('.sidebar nav a').forEach(function(a) {
    a.classList.toggle('active', a.getAttribute('href') === '#' + routeId);
  });
  // Scroll to top of main content
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', function() { showRoute(getRouteFromHash()); });
showRoute(getRouteFromHash());

// =====================================================================
// Snippet card: clicking anywhere on the card navigates to its target
// =====================================================================

document.querySelectorAll('.snippet-card[data-target]').forEach(function(card) {
  card.style.cursor = 'pointer';
  card.addEventListener('click', function(e) {
    if (e.target.closest('a, button')) return;  // let links handle their own clicks
    location.hash = '#' + card.getAttribute('data-target');
  });
});

// =====================================================================
// Sortable tables (existing functionality)
// =====================================================================

document.querySelectorAll('table.sortable').forEach(function(table) {
  Array.from(table.querySelectorAll('thead th')).forEach(function(th, idx) {
    th.classList.add('sortable');
    th.addEventListener('click', function() {
      var asc = !th.classList.contains('sort-asc');
      Array.from(table.querySelectorAll('thead th')).forEach(function(other) {
        other.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(asc ? 'sort-asc' : 'sort-desc');
      var rows = Array.from(table.querySelector('tbody').querySelectorAll('tr'));
      rows.sort(function(a, b) {
        var x = a.cells[idx].textContent.trim();
        var y = b.cells[idx].textContent.trim();
        var nx = parseFloat(x.replace(/[^0-9.\\-]/g, ''));
        var ny = parseFloat(y.replace(/[^0-9.\\-]/g, ''));
        if (!isNaN(nx) && !isNaN(ny)) return asc ? nx - ny : ny - nx;
        return asc ? x.localeCompare(y) : y.localeCompare(x);
      });
      var tbody = table.querySelector('tbody');
      rows.forEach(function(r) { tbody.appendChild(r); });
    });
  });
});
"""


def _badge(readiness: Readiness) -> str:
    icon, label, cls = READINESS_BADGE[readiness]
    return (
        f'<span class="status-indicator {cls}">'
        f'<span class="status-indicator-icon">{icon}</span> {label}'
        f"</span>"
    )


def _kv(label: str, value: str, *, value_small: bool = False) -> str:
    """Render a single Cloudscape-style key-value pair."""
    val_class = "kv-value kv-value-small" if value_small else "kv-value"
    return (
        '<div class="kv-item">'
        f'<div class="kv-label">{escape(label)}</div>'
        f'<div class="{val_class}">{value}</div>'
        "</div>"
    )


def _html_doc(title: str, body: str) -> str:
    return (
        "<!DOCTYPE html>\n"
        "<html lang=\"en\">\n"
        "<head>\n"
        '  <meta charset="utf-8">\n'
        '  <meta name="viewport" content="width=device-width,initial-scale=1">\n'
        f"  <title>{escape(title)}</title>\n"
        f"  <style>{CSS}</style>\n"
        "</head>\n"
        "<body>\n"
        f"{body}\n"
        '  <footer>Generated by <code>bedrock-attribution-audit</code> · Cloudscape Design System</footer>\n'
        f"  <script>{SORT_JS}</script>\n"
        "</body>\n"
        "</html>\n"
    )


def _render_account_next_steps(findings, setup_script_content):
    """Render the conditional 'Next steps' playbook for the per-account HTML report.

    Walks the user through a numbered ordered sequence of actions, with copyable
    code blocks pulled from the generated setup-tier1.sh content. The playbook
    is conditional on:
      - findings.readiness (RED / YELLOW / GREEN drives top-of-page guidance)
      - findings.is_management_account (gates Steps 4 and 5)
      - tag-suggestion confidence distribution (gates Step 1's tone)
      - principal count (suppresses tagging steps if there are no principals)
    """
    setup_script_name = f"setup-tier1-{findings.account_id}.sh"
    suggestions = findings.tag_suggestions or []
    n_principals = findings.tag_coverage.total_principals
    n_high = sum(1 for s in suggestions if s.get("confidence") == "high")
    n_med = sum(1 for s in suggestions if s.get("confidence") == "medium")
    n_low = sum(1 for s in suggestions if s.get("confidence") == "low")
    n_ic = sum(1 for p in findings.candidate_principals if p.is_identity_center_role)
    is_mgmt = findings.is_management_account

    # ─── Extract per-section bash content from the generated script ────────
    section1_block = section2_block = section3_block = ""
    if setup_script_content:
        try:
            s1 = setup_script_content.index("# Section 1:")
            s2 = setup_script_content.index("# Section 2:", s1)
            s3 = setup_script_content.index("# Section 3:", s2)
            done = setup_script_content.find("# Done.", s3)
            if done < 0:
                done = len(setup_script_content)
            section1_block = setup_script_content[s1:s2].rstrip()
            section2_block = setup_script_content[s2:s3].rstrip()
            section3_block = setup_script_content[s3:done].rstrip()
        except ValueError:
            # Markers not found — leave blocks empty; we'll still link to the file
            pass

    # ─── Top-of-page guardrail banner — conditional on readiness ───────────
    if findings.readiness.name == "RED":
        banner = (
            '        <div class="alert alert-error">\n'
            '          <span class="alert-icon">!</span>\n'
            '          <div class="alert-body">\n'
            '            <div class="alert-header">Stop — don\'t run anything yet.</div>\n'
            "            Most readiness gaps in this account are upstream of the "
            "setup script. Step 1 below tells you what to do first. Steps 2 onward "
            "won\u2019t deliver value until step 1 is complete.\n"
            "          </div>\n"
            "        </div>\n"
        )
    elif findings.readiness.name == "YELLOW":
        banner = (
            '        <div class="alert alert-warning">\n'
            '          <span class="alert-icon">!</span>\n'
            '          <div class="alert-body">\n'
            '            <div class="alert-header">Review tag suggestions before running.</div>\n'
            f"            Of <strong>{len(suggestions)}</strong> suggested tag set(s), "
            f"<strong>{n_low}</strong> have placeholder values that need editing. "
            "Open the Tagging Taxonomy section, decide on real values, then proceed.\n"
            "          </div>\n"
            "        </div>\n"
        )
    elif n_principals == 0:
        banner = (
            '        <div class="alert alert-info">\n'
            '          <span class="alert-icon">i</span>\n'
            '          <div class="alert-body">\n'
            '            <div class="alert-header">No Bedrock-capable principals found.</div>\n'
            "            This account has no IAM principals with <code>bedrock:*</code> "
            "permissions yet. There\u2019s nothing for the setup script to tag. "
            "Re-run this audit after granting Bedrock access to at least one role.\n"
            "          </div>\n"
            "        </div>\n"
        )
    else:
        banner = (
            '        <div class="alert alert-success">\n'
            '          <span class="alert-icon">\u2713</span>\n'
            '          <div class="alert-body">\n'
            '            <div class="alert-header">Ready to enable Tier 1.</div>\n'
            f"            <strong>{n_high}</strong> of <strong>{len(suggestions)}</strong> "
            "principal(s) have high-confidence tag suggestions. "
            "Walk through the steps below — they\u2019re ordered.\n"
            "          </div>\n"
            "        </div>\n"
        )

    # ─── Step 1 — review tagging taxonomy ──────────────────────────────────
    step1 = (
        '        <h2 class="step-heading"><span class="step-num">1</span> '
        "Review your tagging taxonomy</h2>\n"
        '        <p>The audit suggested tag values for '
        f'<strong>{len(suggestions)}</strong> principal(s) — '
        f'<strong>{n_high} high</strong> confidence, '
        f'<strong>{n_med} medium</strong>, '
        f'<strong>{n_low} low</strong>. Open the '
        '<a href="#taxonomy">Tagging Taxonomy</a> route in the sidebar, '
        "decide which values are right for your org structure, and edit "
        f"<code>{escape(setup_script_name)}</code> in place. Replace every "
        "<code>TAG_VALUE_TO_REVIEW</code> placeholder with a real value before "
        "running anything.</p>\n"
    )
    if n_ic > 0:
        step1 += (
            '        <div class="alert alert-info">\n'
            '          <span class="alert-icon">i</span>\n'
            '          <div class="alert-body">\n'
            f"            <strong>{n_ic}</strong> of your principals are Identity Center / "
            "SSO-issued role(s). They cannot be tagged with <code>iam:TagRole</code> "
            "directly — edit the underlying permission set in IAM Identity Center to "
            "apply tags. The setup script flags these inline.\n"
            "          </div>\n"
            "        </div>\n"
        )

    # ─── Step 2 — apply tags (Section 1 of the script) ─────────────────────
    if section1_block and n_principals > 0:
        step2 = (
            '        <h2 class="step-heading"><span class="step-num">2</span> '
            "Apply the tags to your IAM principals</h2>\n"
            "        <p>Once you\u2019ve decided on tag values and edited the placeholders, "
            f"run <code>{escape(setup_script_name)}</code> from a shell that "
            "has the right AWS credentials, or copy individual commands out of "
            "this block and run them one at a time:</p>\n"
            f'        <pre class="code-block"><code>{escape(section1_block)}</code></pre>\n'
            "        <p>Verify a tag landed on a role:</p>\n"
            '        <pre class="code-block"><code>aws iam list-role-tags '
            "--role-name &lt;role-name&gt; --profile $AWS_PROFILE</code></pre>\n"
        )
    else:
        step2 = ""

    # ─── Step 3 — trigger a Bedrock call so tags propagate to Billing ──────
    step3 = (
        '        <h2 class="step-heading"><span class="step-num">3</span> '
        "Trigger a Bedrock call from each tagged principal</h2>\n"
        "        <p>IAM tags only appear in the Billing console for activation "
        "<em>after</em> the principal carrying the tag has made at least one "
        "Bedrock API call. Run a quick test invocation with each tagged role:</p>\n"
        '        <pre class="code-block"><code>aws bedrock-runtime invoke-model \\\n'
        '  --model-id anthropic.claude-3-haiku-20240307-v1:0 \\\n'
        '  --body \'{"anthropic_version":"bedrock-2023-05-31",'
        '"max_tokens":10,"messages":[{"role":"user","content":"hi"}]}\' \\\n'
        '  --profile &lt;profile-using-the-tagged-role&gt; \\\n'
        '  /tmp/out.json</code></pre>\n'
        "        <p>Wait roughly 24 hours for the call to flow through to AWS "
        "Billing before continuing.</p>\n"
    )

    # ─── Step 4 — activate cost-allocation tags (mgmt-only) ────────────────
    step4_heading = (
        '        <h2 class="step-heading"><span class="step-num">4</span> '
        'Activate cost allocation tags <span class="step-caveat">(management '
        "account only)</span></h2>\n"
    )
    if is_mgmt and section2_block:
        step4 = (
            step4_heading
            + "        <p>From the Organizations management account, activate the "
            "tag dimensions you applied in step 2. Edit the loop to match your "
            "actual dimensions:</p>\n"
            f'        <pre class="code-block"><code>{escape(section2_block)}</code></pre>\n'
        )
    else:
        step4 = (
            step4_heading
            + '        <div class="alert alert-warning">\n'
            '          <span class="alert-icon">!</span>\n'
            '          <div class="alert-body">\n'
            "            This account is <strong>not</strong> the Organizations "
            "management account. You can\u2019t activate cost allocation tags from "
            "here. Coordinate with whoever owns the management (payer) account to "
            "run this step.\n"
            "          </div>\n"
            "        </div>\n"
        )

    # ─── Step 5 — create CUR 2.0 export (mgmt-only) ────────────────────────
    step5_heading = (
        '        <h2 class="step-heading"><span class="step-num">5</span> '
        'Create a CUR 2.0 export with caller identity '
        '<span class="step-caveat">(management account only)</span></h2>\n'
    )
    if is_mgmt and section3_block:
        step5 = (
            step5_heading
            + "        <p>This creates a fresh CUR 2.0 data export that includes the "
            "<code>line_item_iam_principal</code> column. Existing CUR exports "
            "are <em>not</em> retroactively patched — a new export is required.</p>\n"
            f'        <pre class="code-block"><code>{escape(section3_block)}</code></pre>\n'
        )
    else:
        step5 = (
            step5_heading
            + '        <div class="alert alert-warning">\n'
            '          <span class="alert-icon">!</span>\n'
            '          <div class="alert-body">\n'
            "            CUR 2.0 exports are managed at the management account. "
            "This account can\u2019t create one. The same FinOps owner who runs "
            "step 4 should run this.\n"
            "          </div>\n"
            "        </div>\n"
        )

    # ─── Step 6 — verify ───────────────────────────────────────────────────
    step6 = (
        '        <h2 class="step-heading"><span class="step-num">6</span> '
        "Verify in Cost Explorer</h2>\n"
        "        <p>After roughly one billing cycle, open AWS Cost Explorer "
        "and filter by tag <code>iamPrincipal/team</code> (or whichever tag "
        "dimension you activated). You should see Bedrock spend broken down "
        "per team, per cost center, or per environment depending on what "
        "you tagged.</p>\n"
    )

    return (
        '      <section class="section" data-route="setup">\n'
        '        <div class="section-header">\n'
        '          <h1>Next steps</h1>\n'
        '          <div class="description">'
        "Step-by-step playbook to enable Tier 1 IAM Principal Cost Tracking "
        "in this account. The audit also generated <code>"
        f"{escape(setup_script_name)}</code> with all of the commands below "
        "pre-filled — you can run that file directly after editing the "
        "<code>TAG_VALUE_TO_REVIEW</code> placeholders. Either path works."
        "</div>\n"
        "        </div>\n"
        f"{banner}"
        f"{step1}"
        f"{step2}"
        f"{step3}"
        f"{step4}"
        f"{step5}"
        f"{step6}"
        "      </section>"
    )


def render_account_html(
    findings: AccountFindings,
    setup_script_content: str | None = None,
) -> str:
    """Render the per-account HTML report as a sidebar-navigated SPA.

    Every major topic is a separate route (#home, #spend, #principals, etc.).
    The sidebar lets the user jump between them. The home page is a
    dashboard of snippet cards previewing each section.

    All sections live in the same HTML file so it stays single-file (easy
    to email / archive). Print mode unhides every section so the printout
    contains everything.
    """
    title_label = (
        f"{findings.account_name} ({findings.account_id})"
        if findings.account_name and findings.account_name != findings.account_id
        else findings.account_id
    )

    parts: list[str] = []

    # ════════════════════════════════════════════════════════════════════════
    # Service header (always at the top, above the app shell)
    # ════════════════════════════════════════════════════════════════════════
    # Account-relationship label. Three states:
    #   - Management account → "Organizations management account"
    #   - Member account     → "Member account of <org-id>"
    #   - Standalone         → "Standalone account (not part of an organization)"
    if findings.is_management_account:
        relationship_label = "Organizations management account"
        relationship_class = "header-pill header-pill-mgmt"
    elif findings.parent_organization_id:
        relationship_label = (
            f"Member account of organization "
            f"<code>{escape(findings.parent_organization_id)}</code>"
        )
        relationship_class = "header-pill header-pill-member"
    else:
        relationship_label = "Standalone account (not part of an organization)"
        relationship_class = "header-pill header-pill-standalone"

    breadcrumb_bits: list[str] = ["Bedrock Attribution Audit", "Account-level audit"]
    parts.append(
        '  <div class="service-header">\n'
        '    <div class="layout">\n'
        f'      <div class="breadcrumb">{" / ".join(escape(b) for b in breadcrumb_bits)}</div>\n'
        f'      <h1>{escape(title_label)} &nbsp; {_badge(findings.readiness)}</h1>\n'
        f'      <div class="header-relationship"><span class="{relationship_class}">{relationship_label}</span></div>\n'
        '      <div class="meta">'
        f"Audit: <code>{escape(findings.audit_started_at)}</code> → "
        f"<code>{escape(findings.audit_completed_at or 'in-progress')}</code>"
        f" · Regions scanned: <strong>{len(findings.regions_scanned)}</strong>"
        + (
            f" · Active in: {', '.join(f'<code>{escape(r)}</code>' for r in findings.bedrock_regions_with_activity)}"
            if findings.bedrock_regions_with_activity
            else ""
        )
        + (
            f" · Payer account: <code>{escape(findings.parent_management_account_id)}</code>"
            if findings.parent_management_account_id and not findings.is_management_account
            else ""
        )
        + "</div>\n"
        "    </div>\n"
        "  </div>"
    )

    # ════════════════════════════════════════════════════════════════════════
    # App shell — sidebar + main pane
    # ════════════════════════════════════════════════════════════════════════
    parts.append('  <div class="app-shell">')

    # ─── Sidebar nav with section counts ───
    n_principals = findings.tag_coverage.total_principals
    n_agents = len(findings.agents)
    n_kbs = len(findings.knowledge_bases)
    n_profiles = len(findings.application_inference_profiles)
    n_custom = len(findings.custom_models)
    n_guardrails = len(findings.guardrails)
    n_pt = len(findings.provisioned_throughputs)
    n_actions = len(findings.action_items)
    n_taxonomy = len(findings.tag_suggestions)
    n_resources = n_agents + n_kbs + n_profiles + n_custom + n_guardrails + n_pt
    n_history_changes = len(findings.deltas_vs_previous)

    def _navlink(href: str, label: str, count: int | None = None) -> str:
        cnt_html = f'<span class="nav-count">{count}</span>' if count is not None else ""
        return f'        <a href="#{href}">{escape(label)}{cnt_html}</a>'

    sidebar_html = [
        '    <aside class="sidebar">',
        '      <nav>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Overview</div>',
        _navlink("home", "Home"),
        _navlink("readiness", "Readiness verdict"),
    ]
    if findings.previous_run:
        sidebar_html.append(_navlink("history", "Compared to last run", n_history_changes))
    sidebar_html += [
        '        </div>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Cost attribution</div>',
        _navlink("spend", "Spend"),
        _navlink("principals", "IAM principals", n_principals),
        '        </div>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Resources</div>',
        _navlink("resources", "Bedrock resources", n_resources),
        _navlink("cost-infra", "Cost-attribution infrastructure"),
        _navlink("cloudtrail", "CloudTrail coverage"),
        '        </div>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Next steps</div>',
        _navlink("actions", "Action items", n_actions),
        _navlink("setup", "Next steps"),
        _navlink("taxonomy", "Tagging taxonomy", n_taxonomy),
    ]
    if findings.recommendations:
        sidebar_html.append(_navlink("recommendations", "Recommendations", len(findings.recommendations)))
    sidebar_html += [
        '        </div>',
        '      </nav>',
        '    </aside>',
    ]
    parts.append("\n".join(sidebar_html))

    # ─── Main pane ───
    parts.append('    <div class="main-pane">')

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #home — dashboard with snippet cards
    # ════════════════════════════════════════════════════════════════════════
    home_parts = [
        '      <section class="section" data-route="home">',
        '        <div class="section-header">',
        f'          <h1>Overview</h1>',
        '          <div class="description">'
        f"Audit dashboard for account {escape(findings.account_id)}. "
        "Click any snippet card or sidebar link to jump to a detailed view."
        '</div>',
        '        </div>',
    ]

    # KPI strip
    home_parts.append(
        '        <div class="kpi-strip">\n'
        '          <div class="kpi-item">'
        f'<div class="kpi-label">Audit #</div>'
        f'<div class="kpi-value">{findings.audit_history_count}</div>'
        '</div>\n'
        '          <div class="kpi-item">'
        f'<div class="kpi-label">Readiness</div>'
        f'<div class="kpi-value">{_badge(findings.readiness)}</div>'
        '</div>\n'
        '          <div class="kpi-item">'
        f'<div class="kpi-label">Spend (90d)</div>'
        f'<div class="kpi-value">${findings.total_bedrock_spend_90d_usd:,.2f}</div>'
        '</div>\n'
        '          <div class="kpi-item">'
        f'<div class="kpi-label">Bedrock principals</div>'
        f'<div class="kpi-value">{n_principals}</div>'
        '</div>\n'
        '          <div class="kpi-item">'
        f'<div class="kpi-label">Runtime resources</div>'
        f'<div class="kpi-value">{n_resources}</div>'
        '</div>\n'
        '        </div>'
    )

    # Snippet cards
    snippets: list[str] = []

    # Spend snippet
    cw_total_inv = sum(u.invocations for u in findings.model_usage_30d)
    snippets.append(
        '          <div class="snippet-card" data-target="spend">\n'
        '            <h3>Spend snapshot</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <div><strong>${findings.total_bedrock_spend_30d_usd:,.2f}</strong> "
        "in last 30 days</div>\n"
        f"              <div><strong>${findings.total_bedrock_spend_90d_usd:,.2f}</strong> "
        "in last 90 days</div>\n"
        f"              <div style='margin-top: var(--awsui-space-xs); color: var(--awsui-color-text-body-secondary);'>"
        f"CloudWatch cross-check: <strong>{cw_total_inv:,}</strong> invocations</div>\n"
        '            </div>\n'
        '            <a class="see-all" href="#spend">See spend breakdown →</a>\n'
        '          </div>'
    )

    # Action items snippet (top 3)
    if findings.action_items:
        top_actions = "".join(
            f"              <li><strong>P{a.get('priority', '?')}</strong> · "
            f"{escape((a.get('action') or '')[:80])}{'…' if len(a.get('action') or '') > 80 else ''}</li>\n"
            for a in findings.action_items[:3]
        )
        snippets.append(
            '          <div class="snippet-card" data-target="actions">\n'
            '            <h3>Top action items</h3>\n'
            '            <div class="snippet-body">\n'
            f"              <ol>\n{top_actions}              </ol>\n"
            '            </div>\n'
            f'            <a class="see-all" href="#actions">See all {len(findings.action_items)} action item(s) →</a>\n'
            '          </div>'
        )

    # Principals snippet
    cov = findings.tag_coverage
    best_pct = max(cov.pct_with_team, cov.pct_with_cost_center, cov.pct_with_environment, cov.pct_with_project) if n_principals > 0 else 0.0
    snippets.append(
        '          <div class="snippet-card" data-target="principals">\n'
        '            <h3>IAM principals</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <div><strong>{n_principals}</strong> Bedrock-capable principals</div>\n"
        f"              <div>Best tag coverage: <strong>{best_pct:.0f}%</strong> "
        "(any single dimension)</div>\n"
        '            </div>\n'
        '            <a class="see-all" href="#principals">See principals + tag coverage →</a>\n'
        '          </div>'
    )

    # Resources snippet
    snippets.append(
        '          <div class="snippet-card" data-target="resources">\n'
        '            <h3>Runtime resources</h3>\n'
        '            <div class="snippet-body">\n'
        '              <ul>\n'
        f"                <li><strong>{n_agents}</strong> Bedrock Agents</li>\n"
        f"                <li><strong>{n_kbs}</strong> Knowledge Bases</li>\n"
        f"                <li><strong>{n_profiles}</strong> Application inference profiles</li>\n"
        f"                <li><strong>{n_custom}</strong> Custom models · "
        f"<strong>{n_guardrails}</strong> Guardrails · "
        f"<strong>{n_pt}</strong> Provisioned Throughput</li>\n"
        '              </ul>\n'
        '            </div>\n'
        '            <a class="see-all" href="#resources">See all resources →</a>\n'
        '          </div>'
    )

    # Taxonomy snippet
    if findings.tag_suggestions:
        agg = findings.suggested_tag_dimensions or {}
        dims_summary = ", ".join(f"<code>{escape(k)}</code> ({len(v)})" for k, v in agg.items())
        high_conf = sum(1 for s in findings.tag_suggestions if s.get("confidence") == "high")
        med_conf = sum(1 for s in findings.tag_suggestions if s.get("confidence") == "medium")
        snippets.append(
            '          <div class="snippet-card" data-target="taxonomy">\n'
            '            <h3>Suggested tagging taxonomy</h3>\n'
            '            <div class="snippet-body">\n'
            f"              <div>Suggestions for <strong>{n_taxonomy}</strong> principals "
            f"(<strong>{high_conf}</strong> high confidence, <strong>{med_conf}</strong> medium)</div>\n"
            + (f'              <div style="margin-top: var(--awsui-space-xs);">Dimensions found: {dims_summary}</div>\n' if dims_summary else "")
            + '            </div>\n'
            '            <a class="see-all" href="#taxonomy">Review tag suggestions →</a>\n'
            '          </div>'
        )

    # History snippet
    if findings.previous_run:
        prev_started = findings.previous_run.get("audit_started_at", "")
        snippets.append(
            '          <div class="snippet-card" data-target="history">\n'
            '            <h3>Compared to last run</h3>\n'
            '            <div class="snippet-body">\n'
            f"              <div>Audit <strong>#{findings.audit_history_count}</strong></div>\n"
            f"              <div>Last run: <code>{escape(prev_started)}</code></div>\n"
            f"              <div><strong>{n_history_changes}</strong> metric(s) changed since</div>\n"
            '            </div>\n'
            '            <a class="see-all" href="#history">See change details →</a>\n'
            '          </div>'
        )

    # Setup script snippet
    snippets.append(
        '          <div class="snippet-card" data-target="setup">\n'
        '            <h3>Generated setup script</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <code>setup-tier1-{escape(findings.account_id)}.sh</code> is in your "
        "output directory.\n"
        '              <div style="margin-top: var(--awsui-space-xs); color: var(--awsui-color-text-body-secondary);">'
        "Reviewable shell script with the AWS CLI commands to enable Tier 1.</div>\n"
        '            </div>\n'
        '            <a class="see-all" href="#setup">See the script details →</a>\n'
        '          </div>'
    )

    home_parts.append('        <div class="snippet-grid">\n' + "\n".join(snippets) + '\n        </div>')
    home_parts.append('      </section>')
    parts.append("\n".join(home_parts))

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #readiness — Tier 1 readiness verdict
    # ════════════════════════════════════════════════════════════════════════
    parts.append(
        '      <section class="section" data-route="readiness">\n'
        '        <div class="section-header">\n'
        f'          <h1>Tier 1 readiness {_badge(findings.readiness)}</h1>\n'
        f'          <div class="description">{escape(findings.readiness_reasoning)}</div>\n'
        '        </div>\n'
        '      </section>'
    )

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #history — compared to last run
    # ════════════════════════════════════════════════════════════════════════
    if findings.previous_run and findings.deltas_vs_previous:
        prev_started = findings.previous_run.get("audit_started_at", "")
        sentiment_to_class = {"good": "status-success", "bad": "status-error", "neutral": "status-info"}
        arrow = {"up": "↑", "down": "↓", "same": "—"}
        delta_rows: list[str] = []
        for d in findings.deltas_vs_previous:
            cls = sentiment_to_class.get(d["sentiment"], "status-info")
            arr = arrow.get(d["direction"], "—")
            delta_rows.append(
                "              <tr>"
                f"<td>{escape(d['label'])}</td>"
                f"<td>{escape(d['previous'])}</td>"
                f"<td>"
                f'<span class="status-indicator {cls}">'
                f'<span class="status-indicator-icon">{arr}</span> {escape(d["current"])}'
                f"</span>"
                "</td>"
                "</tr>"
            )
        parts.append(
            '      <section class="section" data-route="history">\n'
            '        <div class="section-header">\n'
            '          <h1>Compared to last run</h1>\n'
            '          <div class="description">'
            f"This is audit <strong>#{findings.audit_history_count}</strong> for this account. "
            f"Last run: <code>{escape(prev_started)}</code>. "
            f"{len(findings.deltas_vs_previous)} metric(s) changed."
            "</div>\n"
            '        </div>\n'
            '        <div class="table-wrapper"><table>\n'
            "          <thead><tr>"
            "<th>Metric</th><th>Previous</th><th>Now</th>"
            "</tr></thead>\n"
            f"          <tbody>\n{chr(10).join(delta_rows)}\n          </tbody>\n"
            "        </table></div>\n"
            "      </section>"
        )

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #spend — full spend section
    # ════════════════════════════════════════════════════════════════════════
    if findings.spend_attribution_status == "by-principal":
        attribution_badge = (
            '<span class="status-indicator status-success">'
            '<span class="status-indicator-icon">✓</span> Per-principal data available'
            '</span>'
        )
        attribution_note = (
            "Tier 1 IAM Principal Cost Tracking is enabled. The next CUR refresh will include "
            "<code>line_item_iam_principal</code> data, allowing per-team and per-user spend "
            "attribution in Cost Explorer."
        )
    else:
        attribution_badge = (
            '<span class="status-indicator status-warning">'
            '<span class="status-indicator-icon">!</span> Account-level only'
            '</span>'
        )
        attribution_note = (
            "Per-principal spend attribution is <strong>not yet available</strong>. "
            "Cost Explorer shows account-level spend only. Enable "
            "<a href=\"https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html\">"
            "Bedrock IAM Principal Cost Tracking</a> at the management account level and "
            "create a fresh CUR 2.0 export with caller identity included."
        )

    spend_html = [
        '      <section class="section" data-route="spend">',
        '        <div class="section-header">',
        f'          <h1>Spend &nbsp; {attribution_badge}</h1>',
        f'          <div class="description">{attribution_note}</div>',
        '        </div>',
        '        <div class="kpi-strip">',
        f'          <div class="kpi-item"><div class="kpi-label">Last 30 days</div>'
        f'<div class="kpi-value">${findings.total_bedrock_spend_30d_usd:,.2f}</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">Last 90 days</div>'
        f'<div class="kpi-value">${findings.total_bedrock_spend_90d_usd:,.2f}</div></div>',
        '        </div>',
    ]
    if findings.spend_by_model:
        agg: dict[str, dict[str, float]] = {}
        for row in findings.spend_by_model:
            slot = "input" if row.is_input else "output"
            d = agg.setdefault(row.model_id, {"input": 0.0, "output": 0.0})
            d[slot] += row.cost_usd
        spend_html.append('        <h2 style="margin-top: var(--awsui-space-l);">By model — Cost Explorer (90d)</h2>')
        spend_html.append('        <div class="table-wrapper"><table class="sortable">')
        spend_html.append('          <thead><tr><th>Model / line item</th><th class="num">Input cost</th><th class="num">Output cost</th><th class="num">Total</th></tr></thead><tbody>')
        for model, costs in sorted(agg.items(), key=lambda kv: -sum(kv[1].values())):
            total = costs["input"] + costs["output"]
            spend_html.append(
                f'            <tr><td><code>{escape(model)}</code></td>'
                f'<td class="num">${costs["input"]:,.2f}</td>'
                f'<td class="num">${costs["output"]:,.2f}</td>'
                f'<td class="num"><strong>${total:,.2f}</strong></td></tr>'
            )
        spend_html.append('          </tbody></table></div>')

    if findings.model_usage_30d:
        spend_html.append('        <h2 style="margin-top: var(--awsui-space-l);">By model — CloudWatch (30d, independent signal)</h2>')
        spend_html.append(
            '        <p class="note" style="color: var(--awsui-color-text-body-secondary); '
            'font-size: var(--awsui-font-size-body-s); margin-bottom: var(--awsui-space-s);">'
            "Invocation counts and token volumes from <code>AWS/Bedrock</code> CloudWatch metrics. "
            "Cross-check against the Cost Explorer table above — the math should line up at "
            "published model rates.</p>"
        )
        spend_html.append('        <div class="table-wrapper"><table class="sortable">')
        spend_html.append(
            '          <thead><tr><th>Model</th><th>Region</th>'
            '<th class="num">Invocations</th>'
            '<th class="num">Input tokens</th>'
            '<th class="num">Output tokens</th>'
            '<th class="num">Throttles</th></tr></thead><tbody>'
        )
        for u in sorted(findings.model_usage_30d, key=lambda m: -m.invocations):
            spend_html.append(
                "            <tr>"
                f"<td><code>{escape(u.model_id)}</code></td>"
                f"<td>{escape(u.region)}</td>"
                f'<td class="num">{u.invocations:,}</td>'
                f'<td class="num">{u.input_tokens:,}</td>'
                f'<td class="num">{u.output_tokens:,}</td>'
                f'<td class="num">{u.throttles:,}</td>'
                "</tr>"
            )
        spend_html.append('          </tbody></table></div>')
    spend_html.append('      </section>')
    parts.append("\n".join(spend_html))

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #principals — Bedrock-capable IAM principals + tag coverage
    # ════════════════════════════════════════════════════════════════════════
    p_html = [
        '      <section class="section" data-route="principals">',
        '        <div class="section-header">',
        '          <h1>Bedrock-capable IAM principals</h1>',
        '          <div class="description">'
        "Roles and users in this account whose IAM policies grant <code>bedrock:*</code> "
        "runtime permissions. Pre-Tier-1, this is our best heuristic for who could be "
        "calling Bedrock."
        "</div>",
        '        </div>',
        '        <div class="kpi-strip">',
        f'          <div class="kpi-item"><div class="kpi-label">Total principals</div>'
        f'<div class="kpi-value">{n_principals}</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">team tag</div>'
        f'<div class="kpi-value">{cov.pct_with_team:.0f}%</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">cost-center tag</div>'
        f'<div class="kpi-value">{cov.pct_with_cost_center:.0f}%</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">environment tag</div>'
        f'<div class="kpi-value">{cov.pct_with_environment:.0f}%</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">project tag</div>'
        f'<div class="kpi-value">{cov.pct_with_project:.0f}%</div></div>',
        '        </div>',
    ]
    if findings.candidate_principals:
        p_html.append('        <h2 style="margin-top: var(--awsui-space-l);">All principals</h2>')
        p_html.append('        <div class="table-wrapper"><table class="sortable">')
        p_html.append('          <thead><tr><th>ARN</th><th>Type</th><th>Identity Center</th><th>Tags</th></tr></thead><tbody>')
        for pr in findings.candidate_principals:
            tag_pills = (
                "".join(f'<span class="tag">{escape(k)}={escape(v)}</span>' for k, v in sorted(pr.tags.items()))
                or '<span style="color: var(--awsui-color-text-body-secondary);">—</span>'
            )
            ic = (
                '<span class="status-indicator status-info"><span class="status-indicator-icon">i</span> Yes</span>'
                if pr.is_identity_center_role else "—"
            )
            p_html.append(
                f"            <tr>"
                f"<td><code>{escape(pr.arn)}</code></td>"
                f"<td>{escape(pr.principal_type)}</td>"
                f"<td>{ic}</td>"
                f"<td>{tag_pills}</td>"
                "</tr>"
            )
        p_html.append('          </tbody></table></div>')
    else:
        p_html.append('        <p class="note">No Bedrock-capable IAM principals found in this account.</p>')
    p_html.append('      </section>')
    parts.append("\n".join(p_html))

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #resources — Bedrock runtime resources (agents, KBs, profiles, etc.)
    # ════════════════════════════════════════════════════════════════════════
    r_html = [
        '      <section class="section" data-route="resources">',
        '        <div class="section-header">',
        '          <h1>Bedrock runtime resources</h1>',
        '          <div class="description">'
        "Everything Bedrock-related deployed in this account: agents, knowledge bases, "
        "fine-tuned models, guardrails, and provisioned throughput allocations."
        "</div>",
        '        </div>',
        '        <div class="kpi-strip">',
        f'          <div class="kpi-item"><div class="kpi-label">Bedrock Agents</div>'
        f'<div class="kpi-value">{n_agents}</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">Knowledge Bases</div>'
        f'<div class="kpi-value">{n_kbs}</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">Inference profiles</div>'
        f'<div class="kpi-value">{n_profiles}</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">Custom models</div>'
        f'<div class="kpi-value">{n_custom}</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">Guardrails</div>'
        f'<div class="kpi-value">{n_guardrails}</div></div>',
        f'          <div class="kpi-item"><div class="kpi-label">Provisioned Throughput</div>'
        f'<div class="kpi-value">{n_pt}</div></div>',
        '        </div>',
    ]
    if findings.agents:
        r_html.append('        <h2 style="margin-top: var(--awsui-space-l);">Bedrock Agents</h2>')
        r_html.append('        <div class="table-wrapper"><table class="sortable">')
        r_html.append('          <thead><tr><th>Region</th><th>Name</th><th>Foundation model</th><th>Status</th><th>Execution role</th><th>Tags</th></tr></thead><tbody>')
        for a in findings.agents:
            tag_pills = "".join(f'<span class="tag">{escape(k)}={escape(v)}</span>' for k, v in sorted(a.tags.items())) or '—'
            r_html.append(
                f"            <tr><td>{escape(a.region)}</td>"
                f"<td><code>{escape(a.name)}</code></td>"
                f"<td><code>{escape(a.foundation_model)}</code></td>"
                f"<td>{escape(a.status)}</td>"
                f"<td><code>{escape(a.agent_resource_role_arn)}</code></td>"
                f"<td>{tag_pills}</td></tr>"
            )
        r_html.append('          </tbody></table></div>')
    if findings.knowledge_bases:
        r_html.append('        <h2 style="margin-top: var(--awsui-space-l);">Knowledge Bases</h2>')
        r_html.append('        <div class="table-wrapper"><table class="sortable">')
        r_html.append('          <thead><tr><th>Region</th><th>Name</th><th>ID</th><th>Status</th><th>Tags</th></tr></thead><tbody>')
        for k in findings.knowledge_bases:
            tag_pills = "".join(f'<span class="tag">{escape(tk)}={escape(tv)}</span>' for tk, tv in sorted(k.tags.items())) or '—'
            r_html.append(
                f"            <tr><td>{escape(k.region)}</td>"
                f"<td><code>{escape(k.name)}</code></td>"
                f"<td>{escape(k.kb_id)}</td>"
                f"<td>{escape(k.status)}</td>"
                f"<td>{tag_pills}</td></tr>"
            )
        r_html.append('          </tbody></table></div>')
    if findings.application_inference_profiles:
        r_html.append('        <h2 style="margin-top: var(--awsui-space-l);">Application inference profiles (Tier 2)</h2>')
        r_html.append('        <div class="table-wrapper"><table class="sortable">')
        r_html.append('          <thead><tr><th>Region</th><th>Name</th><th>Tags</th></tr></thead><tbody>')
        for pr in findings.application_inference_profiles:
            tag_pills = "".join(f'<span class="tag">{escape(k)}={escape(v)}</span>' for k, v in sorted(pr.tags.items())) or '—'
            r_html.append(f"            <tr><td>{escape(pr.region)}</td><td><code>{escape(pr.name)}</code></td><td>{tag_pills}</td></tr>")
        r_html.append('          </tbody></table></div>')
    if n_resources == 0:
        r_html.append(
            '        <p class="note" style="color: var(--awsui-color-text-body-secondary);">'
            "No runtime resources detected in this account. This account uses Bedrock through "
            "direct <code>InvokeModel</code> / <code>Converse</code> calls — the most common pattern. "
            "Agents and Knowledge Bases are higher-level abstractions you can layer on top later."
            "</p>"
        )
    r_html.append('      </section>')
    parts.append("\n".join(r_html))

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #cost-infra — cost-attribution infrastructure
    # ════════════════════════════════════════════════════════════════════════
    n_logging = sum(1 for c in findings.invocation_logging if c.enabled)
    cur_status = "Yes" if findings.iam_principal_cost_tracking_likely_enabled else "No"
    parts.append(
        '      <section class="section" data-route="cost-infra">\n'
        '        <div class="section-header">\n'
        '          <h1>Cost-attribution infrastructure</h1>\n'
        '          <div class="description">'
        "Existing infrastructure for breaking down Bedrock spend by team, principal, or workload."
        "</div>\n"
        '        </div>\n'
        '        <div class="kpi-strip">\n'
        f'          <div class="kpi-item"><div class="kpi-label">Application inference profiles (Tier 2)</div>'
        f'<div class="kpi-value">{n_profiles}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">Bedrock Projects</div>'
        f'<div class="kpi-value">{len(findings.projects)}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">Regions w/ invocation logging</div>'
        f'<div class="kpi-value">{n_logging}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">CUR 2.0 IAM principal data</div>'
        f'<div class="kpi-value">{cur_status}</div></div>\n'
        '        </div>\n'
        '      </section>'
    )

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #cloudtrail — CloudTrail data event coverage
    # ════════════════════════════════════════════════════════════════════════
    bedrock_de = [c.region for c in findings.cloudtrail_coverage if c.has_bedrock_data_events]
    if bedrock_de:
        ct_body = (
            '        <p>Bedrock data events are captured in CloudTrail for: '
            + ", ".join(f"<code>{escape(r)}</code>" for r in bedrock_de)
            + ". Per-call audit trail and per-principal attribution available.</p>"
        )
    else:
        ct_body = (
            '        <div class="alert alert-warning">\n'
            '          <span class="alert-icon">!</span>\n'
            '          <div class="alert-body">\n'
            '            <div class="alert-header">Bedrock data plane events are not captured in any inspected region.</div>\n'
            "            <code>InvokeModel</code> / <code>Converse</code> calls are CloudTrail data events "
            "that require explicit opt-in. Without this, who-called-what is invisible until "
            "Tier 1 IAM Principal Cost Tracking is enabled.\n"
            "          </div>\n"
            "        </div>\n"
        )
    parts.append(
        '      <section class="section" data-route="cloudtrail">\n'
        '        <div class="section-header">\n'
        '          <h1>CloudTrail data event coverage</h1>\n'
        '          <div class="description">'
        "Whether Bedrock data plane API calls are captured in CloudTrail."
        "</div>\n"
        '        </div>\n'
        f'{ct_body}\n'
        '      </section>'
    )

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #recommendations — narrative recommendations
    # ════════════════════════════════════════════════════════════════════════
    if findings.recommendations:
        recs = "".join(f"          <li>{escape(r)}</li>\n" for r in findings.recommendations)
        parts.append(
            '      <section class="section" data-route="recommendations">\n'
            '        <div class="section-header">\n'
            '          <h1>Recommendations</h1>\n'
            '        </div>\n'
            f'        <ol class="recommendations">\n{recs}        </ol>\n'
            '      </section>'
        )

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #actions — prioritized action items table
    # ════════════════════════════════════════════════════════════════════════
    if findings.action_items:
        priority_class = {1: "status-error", 2: "status-warning", 3: "status-info", 4: "status-info", 5: "status-neutral"}
        action_rows: list[str] = []
        for ai in findings.action_items:
            pri = ai.get("priority", 0)
            cls = priority_class.get(pri, "status-neutral")
            cat = ai.get("category", "")
            atext = ai.get("action", "")
            blocks = ai.get("blocks", "")
            effort = ai.get("effort_estimate_hours", "")
            notes = ai.get("notes", "")
            notes_html = f'<br><small style="color: var(--awsui-color-text-body-secondary);">{escape(notes)}</small>' if notes else ""
            action_rows.append(
                "            <tr>"
                f'<td><span class="status-indicator {cls}"><span class="status-indicator-icon">P{pri}</span></span></td>'
                f"<td><strong>{escape(cat)}</strong></td>"
                f"<td>{escape(atext)}{notes_html}</td>"
                f"<td>{escape(blocks)}</td>"
                f'<td class="num">{effort}h</td>'
                "</tr>"
            )
        parts.append(
            '      <section class="section" data-route="actions">\n'
            '        <div class="section-header">\n'
            '          <h1>Action items</h1>\n'
            '          <div class="description">'
            "Prioritized work list to move this account toward GREEN. "
            f"Full list with owner / due-date columns is in <code>{escape(findings.account_id)}-action-items.csv</code>."
            "</div>\n"
            '        </div>\n'
            '        <div class="table-wrapper"><table>\n'
            "          <thead><tr><th>Priority</th><th>Category</th><th>Action</th><th>Unblocks</th><th class=\"num\">Effort</th></tr></thead>\n"
            f"          <tbody>\n{chr(10).join(action_rows)}\n          </tbody>\n"
            "        </table></div>\n"
            '      </section>'
        )

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #setup — Next-steps playbook (uses setup_script_content if available)
    # ════════════════════════════════════════════════════════════════════════
    parts.append(_render_account_next_steps(findings, setup_script_content))

    # ════════════════════════════════════════════════════════════════════════
    # ROUTE: #taxonomy — suggested tagging taxonomy
    # ════════════════════════════════════════════════════════════════════════
    if findings.tag_suggestions:
        agg = findings.suggested_tag_dimensions or {}
        agg_rows: list[str] = []
        for dim, values in agg.items():
            value_pills = " ".join(f'<span class="tag">{escape(v)}={cnt}</span>' for v, cnt in values[:6])
            if len(values) > 6:
                value_pills += f' <span style="color: var(--awsui-color-text-body-secondary);">+{len(values)-6} more</span>'
            agg_rows.append(f"            <tr><td><code>{escape(dim)}</code></td><td>{value_pills}</td></tr>")

        confidence_class = {"high": "status-success", "medium": "status-warning", "low": "status-neutral"}
        sug_rows: list[str] = []
        for s in findings.tag_suggestions:
            tags = s.get("suggested_tags", {}) or {}
            tag_pills = " ".join(f'<span class="tag">{escape(k)}={escape(v)}</span>' for k, v in sorted(tags.items())) or "—"
            cls = confidence_class.get(s.get("confidence", "low"), "status-neutral")
            sug_rows.append(
                "            <tr>"
                f"<td><code>{escape(s.get('name',''))}</code></td>"
                f'<td><span class="status-indicator {cls}"><span class="status-indicator-icon">●</span> {escape(s.get("confidence","low"))}</span></td>'
                f"<td>{tag_pills}</td>"
                f"<td><small>{escape(s.get('reasoning',''))}</small></td>"
                "</tr>"
            )

        parts.append(
            '      <section class="section" data-route="taxonomy">\n'
            '        <div class="section-header">\n'
            '          <h1>Suggested tagging taxonomy</h1>\n'
            '          <div class="description">'
            "Heuristic suggestions based on the IAM role / user names we found. "
            "<strong>Advisory only.</strong> Review every suggestion and edit the values in "
            f"<code>setup-tier1-{escape(findings.account_id)}.sh</code> before applying."
            "</div>\n"
            '        </div>\n'
            + (
                '        <h2 style="margin-top: var(--awsui-space-l);">Suggested dimensions and values</h2>\n'
                '        <div class="table-wrapper"><table>\n'
                "          <thead><tr><th>Tag key</th><th>Suggested values (with count)</th></tr></thead>\n"
                f"          <tbody>\n{chr(10).join(agg_rows)}\n          </tbody>\n"
                "        </table></div>\n"
                if agg_rows else ""
            )
            + '        <h2 style="margin-top: var(--awsui-space-l);">Per-principal suggestions</h2>\n'
            '        <div class="table-wrapper"><table class="sortable">\n'
            "          <thead><tr><th>Principal</th><th>Confidence</th><th>Suggested tags</th><th>Reasoning</th></tr></thead>\n"
            f"          <tbody>\n{chr(10).join(sug_rows)}\n          </tbody>\n"
            "        </table></div>\n"
            '      </section>'
        )

    # ════════════════════════════════════════════════════════════════════════
    # Close the main pane and the app shell
    # ════════════════════════════════════════════════════════════════════════
    parts.append('    </div>')  # main-pane
    parts.append('  </div>')    # app-shell

    return _html_doc(f"Bedrock Attribution Audit — {title_label}", "\n".join(parts))


def render_org_html(findings: OrgFindings) -> str:
    """Render the org-level summary as a sidebar-navigated SPA.

    Same layout pattern as render_account_html — sidebar on the left,
    main pane on the right, one section visible at a time. Default route
    is #home (a dashboard of org-wide snippets). Other routes drill into
    per-account detail, cross-org principals (with account_id column),
    agents, knowledge bases, inference profiles, and skipped accounts.
    """
    parts: list[str] = []

    # ─── Service header ───
    breadcrumb_bits = ["Bedrock Attribution Audit", "Organization-level audit"]
    # Try to surface a human-readable name for the org. AWS Organizations
    # doesn't have a "name" field per se; the closest proxy is the
    # management (payer) account's name when org-audit pre-fetched it.
    mgmt_account_name = next(
        (a.account_name for a in findings.accounts
         if a.account_id == findings.management_account_id and a.account_name),
        None,
    )
    org_id = findings.organization_id or "unknown"
    org_title = (
        f"{escape(mgmt_account_name)} <span class=\"header-org-id\">"
        f"({escape(org_id)})</span>"
        if mgmt_account_name
        else f"Organization <code>{escape(org_id)}</code>"
    )
    parts.append(
        '  <div class="service-header">\n'
        '    <div class="layout">\n'
        f'      <div class="breadcrumb">{" / ".join(escape(b) for b in breadcrumb_bits)}</div>\n'
        f'      <h1>{org_title}</h1>\n'
        '      <div class="header-relationship">'
        '<span class="header-pill header-pill-org">Cross-organization sweep</span>'
        '</div>\n'
        '      <div class="meta">'
        f"Management account: <code>{escape(findings.management_account_id)}</code>"
        + (f" (<strong>{escape(mgmt_account_name)}</strong>)" if mgmt_account_name else "")
        + f" · Organization ID: <code>{escape(org_id)}</code>"
        f" · Audit: <code>{escape(findings.audit_started_at)}</code> → "
        f"<code>{escape(findings.audit_completed_at or 'in-progress')}</code>"
        f" · Accounts audited: <strong>{len(findings.accounts)}</strong>"
        + (f" · Skipped: <strong>{len(findings.accounts_skipped)}</strong>" if findings.accounts_skipped else "")
        + "</div>\n"
        "    </div>\n"
        "  </div>"
    )

    # Aggregate stats used by both sidebar and home dashboard
    n_accounts = len(findings.accounts)
    n_skipped = len(findings.accounts_skipped)
    total_principals = sum(a.tag_coverage.total_principals for a in findings.accounts)
    total_agents = sum(len(a.agents) for a in findings.accounts)
    total_kbs = sum(len(a.knowledge_bases) for a in findings.accounts)
    total_profiles = sum(len(a.application_inference_profiles) for a in findings.accounts)
    green_n = sum(1 for a in findings.accounts if a.readiness == Readiness.GREEN)
    yellow_n = sum(1 for a in findings.accounts if a.readiness == Readiness.YELLOW)
    red_n = sum(1 for a in findings.accounts if a.readiness == Readiness.RED)

    # ─── App shell ───
    parts.append('  <div class="app-shell">')

    # Sidebar
    def _navlink(href: str, label: str, count: int | None = None) -> str:
        cnt = f'<span class="nav-count">{count}</span>' if count is not None else ""
        return f'        <a href="#{href}">{escape(label)}{cnt}</a>'

    sidebar = [
        '    <aside class="sidebar">',
        '      <nav>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Overview</div>',
        _navlink("home", "Home"),
        _navlink("prioritization", "Prioritization"),
        '        </div>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Accounts</div>',
        _navlink("accounts", "Per-account roll-up", n_accounts),
    ]
    if n_skipped:
        sidebar.append(_navlink("skipped", "Skipped accounts", n_skipped))
    sidebar += [
        '        </div>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Cross-org inventory</div>',
        _navlink("principals", "Principals (by account)", total_principals),
        _navlink("agents", "Bedrock Agents", total_agents),
        _navlink("knowledge-bases", "Knowledge Bases", total_kbs),
        _navlink("profiles", "Inference profiles", total_profiles),
        '        </div>',
        '        <div class="sidebar-section">',
        '          <div class="sidebar-section-title">Next steps</div>',
        _navlink("next-steps", "Org-wide rollout"),
        '        </div>',
        '      </nav>',
        '    </aside>',
    ]
    parts.append("\n".join(sidebar))

    # ─── Main pane ───
    parts.append('    <div class="main-pane">')

    # ROUTE: home
    parts.append(_render_org_home(findings, n_accounts, n_skipped, total_principals,
                                   total_agents, total_kbs, total_profiles,
                                   green_n, yellow_n, red_n))

    # ROUTE: accounts
    parts.append(_render_org_accounts(findings))

    # ROUTE: principals (cross-org, account_id prominent)
    parts.append(_render_org_principals(findings))

    # ROUTE: agents
    parts.append(_render_org_agents(findings))

    # ROUTE: knowledge-bases
    parts.append(_render_org_kbs(findings))

    # ROUTE: profiles
    parts.append(_render_org_profiles(findings))

    # ROUTE: prioritization
    parts.append(_render_org_prioritization(findings, green_n, yellow_n, red_n))

    # ROUTE: skipped
    if findings.accounts_skipped:
        parts.append(_render_org_skipped(findings))

    # ROUTE: next-steps (org-wide rollout playbook)
    parts.append(_render_org_next_steps(findings, green_n, yellow_n, red_n))

    parts.append('    </div>')   # main-pane
    parts.append('  </div>')     # app-shell

    return _html_doc("Bedrock Attribution Audit — Organization summary", "\n".join(parts))


def _render_org_home(findings, n_accounts, n_skipped, total_principals,
                     total_agents, total_kbs, total_profiles,
                     green_n, yellow_n, red_n):
    """Org dashboard with KPI strip + snippet cards linking to detail routes."""
    sorted_accts = sorted(findings.accounts, key=lambda a: -a.total_bedrock_spend_90d_usd)
    top3 = sorted_accts[:3]

    snippets = []

    # Per-account roll-up snippet
    top_rows = "".join(
        f"              <li>{_badge(a.readiness)} <code>{escape(a.account_id)}</code> "
        f"{escape(a.account_name or '')} — ${a.total_bedrock_spend_90d_usd:,.2f} "
        f"({a.tag_coverage.total_principals} principals)</li>\n"
        for a in top3
    )
    snippets.append(
        '          <div class="snippet-card" data-target="accounts">\n'
        '            <h3>Per-account roll-up</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <div><strong>{n_accounts}</strong> account(s) audited"
        + (f", <strong>{n_skipped}</strong> skipped" if n_skipped else "")
        + "</div>\n"
        f"              <div style='margin-top: var(--awsui-space-xs);'>Top 3 by 90-day spend:</div>\n"
        f"              <ul>\n{top_rows}              </ul>\n"
        '            </div>\n'
        '            <a class="see-all" href="#accounts">See full per-account roll-up →</a>\n'
        '          </div>'
    )

    # Principals snippet
    snippets.append(
        '          <div class="snippet-card" data-target="principals">\n'
        '            <h3>Principals (by account)</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <div><strong>{total_principals}</strong> Bedrock-capable IAM principals across "
        f"<strong>{n_accounts}</strong> account(s)</div>\n"
        f"              <div style='margin-top: var(--awsui-space-xs); color: var(--awsui-color-text-body-secondary);'>"
        "Each row shows which account it lives in. Sortable by account, ARN, type, or tags.</div>\n"
        '            </div>\n'
        '            <a class="see-all" href="#principals">See principals → account mapping →</a>\n'
        '          </div>'
    )

    # Resources snippet
    snippets.append(
        '          <div class="snippet-card" data-target="agents">\n'
        '            <h3>Bedrock Agents</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <strong>{total_agents}</strong> agent(s) deployed across the organization.\n"
        '            </div>\n'
        '            <a class="see-all" href="#agents">See agents by account →</a>\n'
        '          </div>'
    )
    snippets.append(
        '          <div class="snippet-card" data-target="knowledge-bases">\n'
        '            <h3>Knowledge Bases</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <strong>{total_kbs}</strong> Knowledge Base(s) deployed across the organization.\n"
        '            </div>\n'
        '            <a class="see-all" href="#knowledge-bases">See KBs by account →</a>\n'
        '          </div>'
    )
    snippets.append(
        '          <div class="snippet-card" data-target="profiles">\n'
        '            <h3>Inference profiles (Tier 2)</h3>\n'
        '            <div class="snippet-body">\n'
        f"              <strong>{total_profiles}</strong> application inference profile(s) across "
        f"<strong>{n_accounts}</strong> account(s).\n"
        '            </div>\n'
        '            <a class="see-all" href="#profiles">See profiles by account →</a>\n'
        '          </div>'
    )

    # Prioritization snippet
    snippets.append(
        '          <div class="snippet-card" data-target="prioritization">\n'
        '            <h3>Tier 1 onboarding plan</h3>\n'
        '            <div class="snippet-body">\n'
        '              <ul>\n'
        f"                <li>{_badge(Readiness.GREEN)} <strong>{green_n}</strong> ready now</li>\n"
        f"                <li>{_badge(Readiness.YELLOW)} <strong>{yellow_n}</strong> need cleanup</li>\n"
        f"                <li>{_badge(Readiness.RED)} <strong>{red_n}</strong> need Tier 2 first</li>\n"
        '              </ul>\n'
        '            </div>\n'
        '            <a class="see-all" href="#prioritization">See full prioritization →</a>\n'
        '          </div>'
    )

    return (
        '      <section class="section" data-route="home">\n'
        '        <div class="section-header">\n'
        '          <h1>Organization overview</h1>\n'
        '          <div class="description">'
        f"Cross-org dashboard for management account "
        f"<code>{escape(findings.management_account_id)}</code>. "
        "Click any snippet card or sidebar link to drill in."
        "</div>\n"
        '        </div>\n'
        '        <div class="kpi-strip">\n'
        f'          <div class="kpi-item"><div class="kpi-label">Accounts audited</div>'
        f'<div class="kpi-value">{n_accounts}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">Total spend (90d)</div>'
        f'<div class="kpi-value">${findings.total_org_bedrock_spend_90d_usd:,.2f}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">Total principals</div>'
        f'<div class="kpi-value">{total_principals}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">Agents + KBs</div>'
        f'<div class="kpi-value">{total_agents + total_kbs}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">🟢 / 🟡 / 🔴</div>'
        f'<div class="kpi-value">{green_n} / {yellow_n} / {red_n}</div></div>\n'
        '        </div>\n'
        '        <div class="snippet-grid">\n' + "\n".join(snippets) + '\n        </div>\n'
        '      </section>'
    )


def _render_org_accounts(findings):
    """Per-account roll-up table — sortable, with hyperlinks to per-account HTMLs."""
    sorted_accts = sorted(findings.accounts, key=lambda a: -a.total_bedrock_spend_90d_usd)
    rows = []
    for a in sorted_accts:
        link = f'<a href="accounts/{escape(a.account_id)}.html"><code>{escape(a.account_id)}</code></a>'
        rows.append(
            "            <tr>"
            f"<td>{link}</td>"
            f"<td>{escape(a.account_name or '')}</td>"
            f"<td>{_badge(a.readiness)}</td>"
            f'<td class="num">${a.total_bedrock_spend_90d_usd:,.2f}</td>'
            f'<td class="num">{a.tag_coverage.total_principals}</td>'
            f'<td class="num">{len(a.application_inference_profiles)}</td>'
            f'<td class="num">{len(a.agents)}</td>'
            f'<td class="num">{len(a.knowledge_bases)}</td>'
            "</tr>"
        )
    return (
        '      <section class="section" data-route="accounts">\n'
        '        <div class="section-header">\n'
        '          <h1>Per-account roll-up</h1>\n'
        '          <div class="description">'
        "Click an account ID to open its dedicated per-account report. Click a column header to sort."
        "</div>\n"
        '        </div>\n'
        '        <div class="table-wrapper"><table class="sortable">\n'
        "          <thead><tr>"
        "<th>Account</th><th>Name</th><th>Readiness</th>"
        '<th class="num">90d spend</th>'
        '<th class="num"># principals</th>'
        '<th class="num">Profiles</th>'
        '<th class="num">Agents</th>'
        '<th class="num">KBs</th>'
        "</tr></thead>\n"
        "          <tbody>\n" + "\n".join(rows) + "\n          </tbody>\n"
        "        </table></div>\n"
        '      </section>'
    )


def _render_org_principals(findings):
    """Cross-org principals — flat sortable table with account_id column up front."""
    rows = []
    for a in findings.accounts:
        for pr in a.candidate_principals:
            tag_pills = (
                "".join(f'<span class="tag">{escape(k)}={escape(v)}</span>' for k, v in sorted(pr.tags.items()))
                or '<span style="color: var(--awsui-color-text-body-secondary);">—</span>'
            )
            ic = (
                '<span class="status-indicator status-info"><span class="status-indicator-icon">i</span> Yes</span>'
                if pr.is_identity_center_role else "—"
            )
            rows.append(
                "            <tr>"
                f"<td><code>{escape(a.account_id)}</code></td>"
                f"<td>{escape(a.account_name or '')}</td>"
                f"<td><code>{escape(pr.arn)}</code></td>"
                f"<td>{escape(pr.principal_type)}</td>"
                f"<td>{ic}</td>"
                f"<td>{tag_pills}</td>"
                "</tr>"
            )
    return (
        '      <section class="section" data-route="principals">\n'
        '        <div class="section-header">\n'
        '          <h1>Bedrock-capable principals — by account</h1>\n'
        '          <div class="description">'
        "Every IAM principal across the org that has <code>bedrock:*</code> permissions, "
        "with the account ID it belongs to in the first column. Sort by Account to group; "
        "sort by Tags to find untagged principals first."
        "</div>\n"
        '        </div>\n'
        '        <div class="table-wrapper"><table class="sortable">\n'
        "          <thead><tr>"
        "<th>Account</th><th>Account name</th><th>Principal ARN</th><th>Type</th>"
        "<th>Identity Center</th><th>Tags</th>"
        "</tr></thead>\n"
        "          <tbody>\n" + "\n".join(rows) + "\n          </tbody>\n"
        "        </table></div>\n"
        '      </section>'
    )


def _render_org_agents(findings):
    """Cross-org Bedrock Agents with account_id column."""
    rows = []
    for a in findings.accounts:
        for ag in a.agents:
            tags = "".join(f'<span class="tag">{escape(k)}={escape(v)}</span>' for k, v in sorted(ag.tags.items())) or '—'
            rows.append(
                "            <tr>"
                f"<td><code>{escape(a.account_id)}</code></td>"
                f"<td>{escape(a.account_name or '')}</td>"
                f"<td>{escape(ag.region)}</td>"
                f"<td><code>{escape(ag.name)}</code></td>"
                f"<td><code>{escape(ag.foundation_model)}</code></td>"
                f"<td>{escape(ag.status)}</td>"
                f"<td>{tags}</td>"
                "</tr>"
            )
    body = (
        '        <div class="table-wrapper"><table class="sortable">\n'
        "          <thead><tr>"
        "<th>Account</th><th>Account name</th><th>Region</th><th>Name</th>"
        "<th>Foundation model</th><th>Status</th><th>Tags</th>"
        "</tr></thead>\n"
        "          <tbody>\n" + "\n".join(rows) + "\n          </tbody>\n"
        "        </table></div>\n"
    ) if rows else (
        '        <p class="note" style="color: var(--awsui-color-text-body-secondary);">'
        "No Bedrock Agents detected across the organization."
        "</p>\n"
    )
    return (
        '      <section class="section" data-route="agents">\n'
        '        <div class="section-header">\n'
        '          <h1>Bedrock Agents — by account</h1>\n'
        '        </div>\n'
        f'{body}'
        '      </section>'
    )


def _render_org_kbs(findings):
    rows = []
    for a in findings.accounts:
        for k in a.knowledge_bases:
            tags = "".join(f'<span class="tag">{escape(tk)}={escape(tv)}</span>' for tk, tv in sorted(k.tags.items())) or '—'
            rows.append(
                "            <tr>"
                f"<td><code>{escape(a.account_id)}</code></td>"
                f"<td>{escape(a.account_name or '')}</td>"
                f"<td>{escape(k.region)}</td>"
                f"<td><code>{escape(k.name)}</code></td>"
                f"<td>{escape(k.kb_id)}</td>"
                f"<td>{escape(k.status)}</td>"
                f"<td>{tags}</td>"
                "</tr>"
            )
    body = (
        '        <div class="table-wrapper"><table class="sortable">\n'
        "          <thead><tr>"
        "<th>Account</th><th>Account name</th><th>Region</th><th>Name</th>"
        "<th>ID</th><th>Status</th><th>Tags</th>"
        "</tr></thead>\n"
        "          <tbody>\n" + "\n".join(rows) + "\n          </tbody>\n"
        "        </table></div>\n"
    ) if rows else (
        '        <p class="note" style="color: var(--awsui-color-text-body-secondary);">'
        "No Knowledge Bases detected across the organization."
        "</p>\n"
    )
    return (
        '      <section class="section" data-route="knowledge-bases">\n'
        '        <div class="section-header">\n'
        '          <h1>Knowledge Bases — by account</h1>\n'
        '        </div>\n'
        f'{body}'
        '      </section>'
    )


def _render_org_profiles(findings):
    rows = []
    for a in findings.accounts:
        for pr in a.application_inference_profiles:
            tags = "".join(f'<span class="tag">{escape(k)}={escape(v)}</span>' for k, v in sorted(pr.tags.items())) or '—'
            rows.append(
                "            <tr>"
                f"<td><code>{escape(a.account_id)}</code></td>"
                f"<td>{escape(a.account_name or '')}</td>"
                f"<td>{escape(pr.region)}</td>"
                f"<td><code>{escape(pr.name)}</code></td>"
                f"<td>{tags}</td>"
                "</tr>"
            )
    body = (
        '        <div class="table-wrapper"><table class="sortable">\n'
        "          <thead><tr>"
        "<th>Account</th><th>Account name</th><th>Region</th><th>Name</th><th>Tags</th>"
        "</tr></thead>\n"
        "          <tbody>\n" + "\n".join(rows) + "\n          </tbody>\n"
        "        </table></div>\n"
    ) if rows else (
        '        <p class="note" style="color: var(--awsui-color-text-body-secondary);">'
        "No application inference profiles detected across the organization. "
        "Creating per-team profiles is the Tier 2 attribution mechanism — "
        "see each per-account report's Action Items for setup guidance."
        "</p>\n"
    )
    return (
        '      <section class="section" data-route="profiles">\n'
        '        <div class="section-header">\n'
        '          <h1>Application inference profiles — by account</h1>\n'
        '        </div>\n'
        f'{body}'
        '      </section>'
    )


def _render_org_prioritization(findings, green_n, yellow_n, red_n):
    return (
        '      <section class="section" data-route="prioritization">\n'
        '        <div class="section-header">\n'
        '          <h1>Tier 1 onboarding prioritization</h1>\n'
        '          <div class="description">'
        "Order accounts will be onboarded based on their current readiness."
        "</div>\n'"
        '        </div>\n'
        '        <ul class="bullets">\n'
        f'          <li>{_badge(Readiness.GREEN)} <strong>{green_n}</strong> account(s) ready to enable Tier 1 immediately.</li>\n'
        f'          <li>{_badge(Readiness.YELLOW)} <strong>{yellow_n}</strong> account(s) need a tagging cleanup before Tier 1 delivers value.</li>\n'
        f'          <li>{_badge(Readiness.RED)} <strong>{red_n}</strong> account(s) should adopt Tier 2 (inference profiles) first.</li>\n'
        '        </ul>\n'
        '      </section>'
    )


def _render_org_skipped(findings):
    rows = "".join(
        "            <tr>"
        f'<td><code>{escape(s.get("account_id", "?"))}</code></td>'
        f'<td>{escape(s.get("name", ""))}</td>'
        f'<td>{escape(s.get("reason", ""))}</td>'
        "</tr>\n"
        for s in findings.accounts_skipped
    )
    return (
        '      <section class="section" data-route="skipped">\n'
        '        <div class="section-header">\n'
        '          <h1>Skipped accounts</h1>\n'
        '          <div class="description">'
        "Accounts in this organization that the audit could not reach — usually because "
        "the cross-account role doesn\u2019t exist in the target account or its trust policy "
        "doesn\u2019t allow the management account to assume."
        "</div>\n"
        '        </div>\n'
        '        <div class="table-wrapper"><table>\n'
        "          <thead><tr><th>Account</th><th>Name</th><th>Reason</th></tr></thead>\n"
        f"          <tbody>\n{rows}          </tbody>\n"
        "        </table></div>\n"
        '      </section>'
    )


def _render_org_next_steps(findings, green_n, yellow_n, red_n):
    """Org-level Next-steps playbook — high-level rollout strategy + links to
    each per-account playbook + org-wide commands that only run from the
    management account.
    """
    sorted_accts = sorted(
        findings.accounts,
        key=lambda a: (
            {"GREEN": 0, "YELLOW": 1, "RED": 2, "UNKNOWN": 3}.get(a.readiness.name, 3),
            -a.total_bedrock_spend_90d_usd,
        ),
    )

    # Per-account links table — one row per audited account, sorted with
    # "easiest wins" (GREEN, then YELLOW, then RED) up top so the user
    # gets the recommended rollout order at a glance.
    rows = []
    for a in sorted_accts:
        link = f'accounts/{escape(a.account_id)}.html#setup'
        readiness_html = _badge(a.readiness)
        n_p = a.tag_coverage.total_principals
        rows.append(
            "            <tr>"
            f"<td>{readiness_html}</td>"
            f'<td><a href="{link}"><code>{escape(a.account_id)}</code></a></td>'
            f"<td>{escape(a.account_name or '')}</td>"
            f'<td class="num">${a.total_bedrock_spend_90d_usd:,.2f}</td>'
            f'<td class="num">{n_p}</td>'
            f'<td><a href="{link}">Open playbook →</a></td>'
            "</tr>"
        )

    return (
        '      <section class="section" data-route="next-steps">\n'
        '        <div class="section-header">\n'
        '          <h1>Org-wide rollout</h1>\n'
        '          <div class="description">'
        "How to enable Tier 1 IAM Principal Cost Tracking across this organization. "
        "Each account has its own per-account playbook (linked below) — that\u2019s "
        "where the actual <code>aws iam tag-role</code> commands live, since they "
        "vary by account. The management-account-only commands (activate cost "
        "allocation tags, create the CUR 2.0 export) run once from the payer and "
        "cover the whole org."
        "</div>\n"
        "        </div>\n"
        '        <h2 class="step-heading"><span class="step-num">1</span> '
        "Recommended rollout order</h2>\n"
        '        <p>Start with the <strong>GREEN</strong> accounts to bank some '
        "quick wins, then move to <strong>YELLOW</strong> (need tag cleanup), then "
        "<strong>RED</strong> (need Tier 2 / inference profiles first). Click any "
        "account below to jump to its specific playbook.</p>\n"
        '        <div class="kpi-strip">\n'
        f'          <div class="kpi-item"><div class="kpi-label">{_badge(Readiness.GREEN)} Ready now</div>'
        f'<div class="kpi-value">{green_n}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">{_badge(Readiness.YELLOW)} Need cleanup</div>'
        f'<div class="kpi-value">{yellow_n}</div></div>\n'
        f'          <div class="kpi-item"><div class="kpi-label">{_badge(Readiness.RED)} Need Tier 2 first</div>'
        f'<div class="kpi-value">{red_n}</div></div>\n'
        '        </div>\n'
        '        <div class="table-wrapper"><table class="sortable">\n'
        "          <thead><tr>"
        "<th>Readiness</th>"
        "<th>Account</th>"
        "<th>Name</th>"
        '<th class="num">90d spend</th>'
        '<th class="num"># principals</th>'
        "<th>Per-account playbook</th>"
        "</tr></thead>\n"
        "          <tbody>\n" + "\n".join(rows) + "\n          </tbody>\n"
        "        </table></div>\n"
        '        <h2 class="step-heading"><span class="step-num">2</span> '
        "Org-wide commands (run once from the management account)</h2>\n"
        '        <p>After you\u2019ve tagged principals in the relevant member '
        "accounts (use each account\u2019s playbook for the per-account "
        "<code>aws iam tag-role</code> commands), run these two from the management "
        "account to activate the tags in Billing and create the CUR export:</p>\n"
        '        <h3 style="margin-top: var(--awsui-space-m);">Activate cost-allocation tags</h3>\n'
        '        <pre class="code-block"><code>for TAG_KEY in team cost-center environment project; do\n'
        '    aws ce update-cost-allocation-tags-status \\\n'
        '        --cost-allocation-tags-status TagKey="iamPrincipal/${TAG_KEY}",Status=Active \\\n'
        '        --profile $AWS_PROFILE\ndone</code></pre>\n'
        '        <h3 style="margin-top: var(--awsui-space-m);">Create the CUR 2.0 export</h3>\n'
        '        <p>This is the longer one — see the management account\u2019s '
        "per-account playbook (Step 5) for the full S3 bucket setup + "
        "<code>aws bcm-data-exports create-export</code> command. Run it once.</p>\n"
        '        <h2 class="step-heading"><span class="step-num">3</span> '
        "Verify across the org</h2>\n"
        '        <p>After roughly one billing cycle, open Cost Explorer in the '
        "management account, filter by the <code>iamPrincipal/team</code> tag (or "
        "whichever dimension you activated), and group by <code>linked-account</code>. "
        "You\u2019ll see Bedrock spend broken down per team <em>and</em> per linked "
        "account in the same view.</p>\n"
        '      </section>'
    )


def write_account_html(
    findings: AccountFindings,
    output_dir: Path,
    setup_script_content: str | None = None,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    p = output_dir / f"{findings.account_id}.html"
    p.write_text(render_account_html(findings, setup_script_content))
    return p


def write_org_html(findings: OrgFindings, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    p = output_dir / "org-summary.html"
    p.write_text(render_org_html(findings))
    return p

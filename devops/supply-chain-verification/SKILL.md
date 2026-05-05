---
name: supply-chain-verification
description: Automated verification pipeline for supply chain threat incidents - validates links, APIs, and claims with auto-fix and Matrix alerting
version: 1.0.0
metadata:
  hermes:
    tags: [verification, supply-chain, security, automation, qa]
    related_skills: [supply-chain-threat-intel]
---

# Supply Chain Verification Skill

## Overview

This skill provides automated verification for supply chain threat incidents in `incidents.yaml`. It validates link health, API data consistency, and factual claims before data can be committed. Designed for fully automated unattended operation - no human review required unless critical failures occur.

## Prerequisites

- Browser toolset (for link verification)
- Web toolset (for API queries)  
- Terminal toolset (for Node.js execution)
- Matrix sender (for alerts) - configured in `my-pretty-decent-skills/`
- Working directory must contain `public/incidents.yaml`

## Verification Pipeline

Run all three verification stages in parallel using `delegate_task`:

### Stage 1: Link Health (`verify-links.ts`)
- Fetches all `sources[*].url` URLs
- Validates HTTP status codes (200 OK required)
- Handles timeouts (10s), rate limits, and redirects
- **Auto-fix strategy**: For 404s, queries archive.org for cached copies
  - If found: updates URL to archive.org link
  - If not found: marks as critical failure

### Stage 2: API Validation (`verify-content.ts`)
- Queries NVD API → verify CVE ID exists and data matches
- Queries GitHub GraphQL → verify GHSA ID exists
- Queries package registries (PyPI, npm, crates.io, etc.) → verify package exists
- Sanity checks:
  - Date consistency (`discovered` ≤ `reported`)
  - CVSS score ranges (0-10.0)
  - Valid ecosystem names (whitelisted)
  - MALFORMED data

**Auto-fix strategy**: 
- Lowercase ecosystem names
- Normalize date formats (ISO 8601)
- Default missing optional fields

### Stage 3: Claims Verification (`fact-check.ts`)
- Extracts testable claims from `description` and `iocs`
- Cross-references with sources
- Validates:
  - Specific package names mentioned exist
  - Threat actor names match known attribution patterns
  - Exploit mechanics are technically plausible
  - Impact statistics within realistic ranges
- **Auto-fix strategy**: None for claims verification (data integrity)

## Critical Failure Thresholds

Verification **FAILS** (exit code 1, Matrix alert) when:
- 404/410/500 on PRIMARY source (sole source for a claim)
- Invalid CVE ID (doesn't exist in NVD)
- Invalid GHSA ID (doesn't exist in GitHub Advisory DB)
- Impossible dates (`reported` < `discovered`)
- Package doesn't exist in registry AND no evidence it was delisted as malicious

Verification **WARNS** but passes (exit code 0) when:
- 404s on secondary/corroboration sources
- Package not found in registry (may have been unpublished malicious version)
- Low confidence claims without sources
- Missing optional metadata fields

## Execution

### Local Verification (Manual)

```bash
# Run verification on incidents.yaml
cd /path/to/supply-chain-threat-tracker
node ~/.hermes/skills/devops/supply-chain-verification/scripts/verification-runner.js
```

### Automated Pre-commit Hook

```yaml
# package.json
"scripts": {
  "verify": "node ~/.hermes/skills/devops/supply-chain-verification/scripts/verification-runner.js"
}

# .lefthook.yml
pre-push:
  parallel: false
  commands:
    verify-data:
      run: npm run verify
```

### CI Pipeline Integration

```yaml
# .github/workflows/verify.yml
name: Verify Incident Data
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run verification
        run: npx @nipsys/supply-chain-verification
```

## Workflow

### Step 1: Parse and Load
Load `public/incidents.yaml` using the incidents data pipeline:
```javascript
const { incidents } = require('./data/incidents.js');
```

### Step 2: Parallel Verification (delegate_task)
Spawn three sub-agents:

```javascript
delegate_task({
  tasks: [
    {
      goal: "Verify all source links are accessible, attempt archive.org auto-fix for 404s",
      context: `Incidents: ${JSON.stringify(incidents.map(i => ({id: i.id, sources: i.sources})))}`,
      toolsets: ["browser", "web"]
    },
    {
      goal: "Validate CVE, GHSA, and package registry data consistency",
      context: `Incidents requiring validation: ${JSON.stringify(incidents.map(i => ({id: i.id, cve: i.cve, ghsa: i.ghsa, package: i.package, ecosystem: i.ecosystem})))}`,
      toolsets: ["web"]
    },
    {
      goal: "Extract claims from descriptions and verify against sources",
      context: `Incidents to fact-check: ${JSON.stringify(incidents.map(i => ({id: i.id, description: i.description, sources: i.sources})))}`,
      toolsets: ["web"]
    }
  ]
})
```

### Step 3: Aggregate Results
Combine results from all three stages:
```javascript
const verificationResults = {
  status: computed from all stages,
  incidents_verified: incidents.length,
  incidents_failed: critical_failures.length,
  incidents_warned: warnings.length,
  failures: [...],
  warnings: [...],
  auto_fixes_applied: auto_fix_count
};
```

### Step 4: Output JSON Report
Write `verification-results.json`:
```json
{
  "status": "PASS",
  "incidents_verified": 6,
  "incidents_failed": 0,
  "incidents_warned": 1,
  "failures": [],
  "warnings": [
    {
      "incident_id": "SC-2024-002",
      "type": "warning",
      "message": "Package 'ctx' not found in PyPI registry (may have been unpublished malicious version)",
      "severity": "low"
    }
  ],
  "auto_fixes_applied": 3,
  "timestamp": "2026-05-05T12:30:00Z"
}
```

### Step 5: Critical Failure → Matrix Alert

If `status === "FAIL"`:
```bash
python3 ~/.hermes/skills/social-media/matrix-media-sender/scripts/matrix_media_sender.py \
  --message "❌ SUPPLY CHAIN VERIFICATION FAILED

Incident: ${failure_id}
Critical Issues: ${failure_count}
${formatted_failures}

Deploy blocked. Auto-fix failed for ${auto_fix_failed_count} issues.
Review: ${github_url}"
```

### Step 6: Exit Codes
- `0`: PASSED – All incidents verified (with or without warnings)
- `1`: FAILED – Critical issues detected, Matrix alert sent

## Output Files

- `verification-results.json`: Machine-readable verification status
- `incidents-verified.yaml`: Auto-fixed version of incidents.yaml (if auto-fixes applied)

## Testing

```bash
# Test with valid data
node scripts/verification-runner.js

# Expected output: status "PASS", exit code 0

# Test with invalid data
# Edit incidents.yaml to add bad URL
node scripts/verification-runner.js

# Expected output: status "FAIL", Matrix alert sent, exit code 1
```

## Integration with Data Collection Workflow

When the `devops/supply-chain-threat-intel` skill completes incident research:

1. LLM agents output structured YAML to `incidents.yaml`
2. `verification-runner.js` automatically runs
3. If PASS: Data is ready to commit and push
4. If FAIL: Matrix alert → manual review required → re-run after fixes

## Matrix Configuration

Matrix alerts require the `social-media/matrix-media-sender` skill:
- Ensure Matrix credentials are configured
- Alert channel: your Matrix DM or dedicated room
- Format: structured failure details with GitHub URL for review

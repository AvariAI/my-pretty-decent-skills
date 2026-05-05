#!/usr/bin/env node

/**
 * verification-runner.js
 * 
 * Main orchestrator for supply chain incident verification.
 * Runs all three stages in parallel via delegate_task.
 * Outputs JSON report and sends Matrix alerts on critical failures.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.join(__dirname, 'scripts');

interface VerificationReport {
  status: 'PASS' | 'FAIL';
  incidents_verified: number;
  incidents_failed: number;
  incidents_warned: number;
  failures: Failure[];
  warnings: Warning[];
  auto_fixes_applied: number;
  timestamp: string;
}

interface Failure {
  incident_id: string;
  type: 'link' | 'content' | 'claims';
  issue: string;
  severity: 'critical';
}

interface Warning {
  incident_id: string;
  type: 'link' | 'content' | 'claims';
  issue: string;
  severity: 'low' | 'medium';
}

async function runVerifications(incidentsPath: string): Promise<VerificationReport> {
  console.log('Starting supply chain verification...');
  
  // Load incidents
  const incidents = loadIncidents(incidentsPath);
  console.log(`Loaded ${incidents.length} incidents`);

  // Construct temp JSON for sub-agents
  const tempInputPath = path.join(process.cwd(), 'incidents-input.json');
  fs.writeFileSync(tempInputPath, JSON.stringify(incidents, null, 2));

  // Run verification stages via delegate_task (simplified for standalone execution)
  const stages = ['link', 'content', 'claims'];
  const results: any[] = [];

  for (const stage of stages) {
    try {
      const scriptPath = path.join(SCRIPTS_DIR, `verify-${stage}.ts`);
      
      // Run via node (--loader for ESM)
      const output = execSync(
        `node --loader ts-node/esm ${scriptPath} ${incidentsPath}`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      
      const stageResult = JSON.parse(output);
      results.push(stageResult);
    } catch (err: any) {
      // Stage failed
      const result = {
        stage: `${stage}_verification`,
        error: err.message,
        exit_code: err.status
      };
      results.push(result);
    }
  }

  // Aggregate results
  const report = aggregateResults(results);
  
  // Clean up temp file
  if (fs.existsSync(tempInputPath)) {
    fs.unlinkSync(tempInputPath);
  }

  return report;
}

function loadIncidents(yamlPath: string): any[] {
  const yaml = require('js-yaml');
  const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
  const data = yaml.load(yamlContent) as any;
  return data.incidents || [];
}

function aggregateResults(results: any[]): VerificationReport {
  let criticalFailures: Failure[] = [];
  let warnings: Warning[] = [];
  let autoFixCount = 0;

  for (const result of results) {
    if (result.summary) {
      autoFixCount += result.summary.auto_fixes_applied || 0;
    }

    if (result.results) {
      for (const incidentResult of result.results) {
        if (incidentResult.link_checks) {
          const critical = incidentResult.link_checks.filter((l: any) => l.severity === 'critical');
          for (const link of critical) {
            criticalFailures.push({
              incident_id: incidentResult.incident_id,
              type: 'link',
              issue: `Link failed: ${link.url} (${link.error})`,
              severity: 'critical'
            });
          }
        }

        if (incidentResult.status === 'fail') {
          const failedCheck = incidentResult.checks?.find((c: any) => !c.valid);
          if (failedCheck) {
            criticalFailures.push({
              incident_id: incidentResult.incident_id,
              type: 'content',
              issue: `${failedCheck.type} failed: ${failedCheck.error || 'Invalid data'}`,
              severity: 'critical'
            });
          }
        }

        if (incidentResult.status === 'warn') {
          const warningCheck = incidentResult.checks?.find((c: any) => !c.valid && c.severity !== 'error');
          if (warningCheck) {
            warnings.push({
              incident_id: incidentResult.incident_id,
              type: 'content',
              issue: `${warningCheck.type}: ${warningCheck.error}`,
              severity: warningCheck.severity || 'medium'
            });
          }
        }
      }
    }
  }

  const uniqueIncidents = new Set([
    ...criticalFailures.map(f => f.incident_id),
    ...warnings.map(w => w.incident_id)
  ]);

  return {
    status: criticalFailures.length > 0 ? 'FAIL' : 'PASS',
    incidents_verified: uniqueIncidents.size,
    incidents_failed: criticalFailures.length,
    incidents_warned: warnings.length,
    failures: criticalFailures,
    warnings,
    auto_fixes_applied: autoFixCount,
    timestamp: new Date().toISOString()
  };
}

function sendMatrixAlert(report: VerificationReport, githubUrl: string) {
  if (report.status !== 'FAIL') {
    return;
  }

  try {
    const matrixScript = path.join(System.homedir(), '.hermes', 'skills', 'social-media', 'matrix-media-sender', 'scripts', 'matrix_media_sender.py');
    
    const failureDetails = report.failures.map(f => 
      `• ${f.incident_id}: ${f.type.toUpperCase()} - ${f.issue}`
    ).join('\n');

    const message = `❌ SUPPLY CHAIN VERIFICATION FAILED

Incidents Failed: ${report.incidents_failed}

${failureDetails}

Incidents Verified: ${report.incidents_verified}
Auto-fixes Applied: ${report.auto_fixes_applied}

Deploy blocked. Critical issues require manual review.
${githubUrl}`;

    execSync(`python3 "${matrixScript}" --message "${message.replace(/"/g, '\\"')}"`);
  } catch (err) {
    console.error('Failed to send Matrix alert:', err.message);
  }
}

async function main() {
  const yamlPath = process.argv[2] || path.join(process.cwd(), 'public', 'incidents.yaml');
  
  if (!fs.existsSync(yamlPath)) {
    console.error(`Error: incidents.yaml not found at ${yamlPath}`);
    process.exit(1);
  }

  const report = await runVerifications(yamlPath);

  // Output JSON report
  const reportPath = path.join(process.cwd(), 'verification-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Verification report written to ${reportPath}`);

  // Print summary
  console.log('\n=== Verification Summary ===');
  console.log(`Status: ${report.status}`);
  console.log(`Incidents Verified: ${report.incidents_verified}`);
  console.log(`Critical Failures: ${report.incidents_failed}`);
  console.log(`Warnings: ${report.incidents_warned}`);
  console.log(`Auto-fixes Applied: ${report.auto_fixes_applied}`);

  // Send Matrix alert if critical failures
  if (report.status === 'FAIL') {
    const githubUrl = 'https://github.com/AI-1409/supply-chain-threat-tracker';
    sendMatrixAlert(report, githubUrl);
  }

  // Exit with appropriate code
  process.exit(report.status === 'FAIL' ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

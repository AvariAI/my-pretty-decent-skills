#!/usr/bin/env node

/**
 * verify-links.ts
 * 
 * Verifies all source links in incidents.yaml are accessible.
 * Attempts auto-fix via archive.org for 404s.
 * 
 * Returns: JSON object with verification results
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';

interface LinkCheck {
  url: string;
  incident_id: string;
  source_index: number;
  status_code?: number;
  error?: string;
  auto_fixed?: boolean;
  autofix_url?: string;
  severity: 'pass' | 'critical' | 'warning';
}

interface VerificationResult {
  incident_id: string;
  status: 'pass' | 'fail' | 'warn';
  link_checks: LinkCheck[];
}

async function fetchURL(url: string, timeout = 10000): Promise<{status_code: number, final_url: string}> {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const startTime = Date.now();
    
    const req = client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        // Follow redirects
        if (res.headers.location) {
          fetchURL(res.headers.location, Math.max(timeout - (Date.now() - startTime), 1000))
            .then(resolve)
            .catch(() => resolve({status_code: res.statusCode || 500, final_url: url}));
        } else {
          resolve({status_code: res.statusCode || 500, final_url: url});
        }
      } else {
        resolve({status_code: res.statusCode || 500, final_url: url});
      }
      req.destroy();
    });

    req.on('error', (err) => {
      resolve({status_code: 0, final_url: url});
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({status_code: 0, final_url: url});
    });

    req.setTimeout(timeout);
  });
}

async function searchArchiveOrg(url: string): Promise<string | null> {
  try {
    const archiveUrl = `https://web.archive.org/web/2/${url}`;
    const result = await fetchURL(archiveUrl, 10000);
    
    if (result.status_code === 200) {
      return archiveUrl;
    }
    return null;
  } catch {
    return null;
  }
}

export async function verifyLinks(incidents: any[]): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const incident of incidents) {
    const linkChecks: LinkCheck[] = [];
    let incidentStatus: 'pass' | 'fail' | 'warn' = 'pass';

    if (!incident.sources || !Array.isArray(incident.sources)) {
      continue;
    }

    for (let i = 0; i < incident.sources.length; i++) {
      const source = incident.sources[i];
      const url = source.url?.trim();

      if (!url) {
        continue;
      }

      const check: LinkCheck = {
        url,
        incident_id: incident.id,
        source_index: i,
        severity: 'pass'
      };

      try {
        const result = await fetchURL(url);
        check.status_code = result.status_code;

        if (result.status_code === 200) {
          check.severity = 'pass';
        } else if (result.status_code === 404 || result.status_code === 410) {
          check.error = `${result.status_code} Not Found`;
          check.severity = 'critical';
          
          // Attempt auto-fix via archive.org
          const archiveUrl = await searchArchiveOrg(url);
          if (archiveUrl) {
            check.auto_fixed = true;
            check.autofix_url = archiveUrl;
            check.severity = 'pass';
            
            // Update source URL for downstream processing
            source.url = archiveUrl;
          } else {
            incidentStatus = 'fail';
          }
        } else if (result.status_code >= 500) {
          check.error = `${result.status_code} Server Error`;
          check.severity = 'warning';
          if (incidentStatus !== 'fail') {
            incidentStatus = 'warn';
          }
        } else {
          check.error = `Unexpected status ${result.status_code}`;
          check.severity = 'warning';
          if (incidentStatus !== 'fail') {
            incidentStatus = 'warn';
          }
        }
      } catch (err: any) {
        check.error = err.message || 'Unknown error';
        check.severity = 'critical';
        incidentStatus = 'fail';
      }

      linkChecks.push(check);
    }

    results.push({
      incident_id: incident.id,
      status: linkChecks.some(lc => lc.severity === 'critical') ? 'fail' : 
               linkChecks.some(lc => lc.severity === 'warning') ? 'warn' : 'pass',
      link_checks: linkChecks
    });
  }

  return results;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const yamlPath = process.argv[2] || path.join(process.cwd(), 'public', 'incidents.yaml');
  
  if (!fs.existsSync(yamlPath)) {
    console.error(`Error: incidents.yaml not found at ${yamlPath}`);
    process.exit(1);
  }

  const yaml = await import('js-yaml');
  const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
  const data = yaml.load(yamlContent);
  const incidents = data.incidents || [];

  const results = await verifyLinks(incidents);
  
  const autoFixCount = results.flatMap(r => r.link_checks).filter(lc => lc.auto_fixed).length;
  const criticalFailures = results.filter(r => r.status === 'fail');

  const output = {
    stage: 'link_verification',
    results,
    summary: {
      incidents_checked: results.length,
      links_checked: results.flatMap(r => r.link_checks).length,
      critical_failures: criticalFailures.length,
      warnings: results.filter(r => r.status === 'warn').length,
      auto_fixes_applied: autoFixCount
    }
  };

  console.log(JSON.stringify(output, null, 2));
  
  process.exit(criticalFailures.length > 0 ? 1 : 0);
}

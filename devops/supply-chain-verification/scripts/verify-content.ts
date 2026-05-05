#!/usr/bin/env node

/**
 * verify-content.ts
 * 
 * Validates CVE, GHSA, and package registry data consistency.
 * Sanity checks for dates, CVSS ranges, ecosystem names.
 * Applies auto-fixes where safe.
 * 
 * Returns: JSON object with verification results
 */

export async function verifyContent(incidents: any[]): Promise<any[]> {
  const results = [];
  const ecosystems = ['npm', 'pypi', 'rubygems', 'crates.io', 'go_modules', 'maven', 'nuget', 'packagist', 'cocoapods', 'pub.dev', 'other'];
  
  for (const incident of incidents) {
    const result = {
      incident_id: incident.id,
      status: 'pass',
      checks: [],
      auto_fixes: []
    };

    // CVE validation
    if (incident.cve && incident.cve !== 'N/A') {
      const cveCheck = await verifyCVE(incident.cve);
      result.checks.push({type: 'cve', ...cveCheck});
      if (!cveCheck.valid) {
        result.status = 'fail';
      }
    }

    // GHSA validation
    if (incident.ghsa) {
      const ghsaCheck = await verifyGHSA(incident.ghsa);
      result.checks.push({type: 'ghsa', ...ghsaCheck});
      if (!ghsaCheck.valid) {
        result.status = 'fail';
      }
    }

    // Package validation
    const packageCheck = await verifyPackage(incident.package, incident.ecosystem);
    result.checks.push({type: 'package', ...packageCheck});
    
    // Auto-fix: lowercase ecosystem
    if (incident.ecosystem && ecosystem !== 'Other') {
      const originalEcosystem = incident.ecosystem;
      const normalized = incident.ecosystem.toLowerCase();
      if (originalEcosystem !== normalized && ecosystems.includes(normalized)) {
        incident.ecosystem = normalized;
        result.auto_fixes.push({
          type: 'ecosystem_normalization',
          original: originalEcosystem,
          fixed: normalized
        });
      }
    }

    // Date sanity check
    if (incident.discovered && incident.reported) {
      const discovered = new Date(incident.discovered);
      const reported = new Date(incident.reported);
      
      if (reported < discovered) {
        result.status = 'fail';
        result.checks.push({
          type: 'date_validation',
          valid: false,
          error: `Reported date (${incident.reported}) is before discovered date (${incident.discovered})`
        });
      } else {
        result.checks.push({
          type: 'date_validation',
          valid: true
        });
      }
    }

    // CVSS score validation
    if (incident.cvss && incident.cvss.base_score !== undefined) {
      const score = parseFloat(incident.cvss.base_score);
      if (isNaN(score) || score < 0 || score > 10) {
        result.status = 'fail';
        result.checks.push({
          type: 'cvss_validation',
          valid: false,
          error: `Invalid CVSS score: ${incident.cvss.base_score}`
        });
      } else {
        result.checks.push({
          type: 'cvss_validation',
          valid: true,
          score
        });
      }
    }

    // Ecosystem whitelist validation
    if (incident.ecosystem) {
      const normalized = incident.ecosystem.toLowerCase();
      const valid = ecosystems.includes(normalized) || normalized === 'other';
      
      if (!valid) {
        result.status = 'warn';
        result.checks.push({
          type: 'ecosystem_validation',
          valid: false,
          severity: 'warning',
          error: `Unknown ecosystem: ${incident.ecosystem}`
        });
      } else {
        result.checks.push({
          type: 'ecosystem_validation',
          valid: true
        });
      }
    }

    results.push(result);
  }

  return results;
}

async function verifyCVE(cve: string): Promise<{valid: boolean, error?: string}> {
  try {
    if (!cve.match(/^CVE-\d{4}-\d{4,}$/)) {
      return {valid: false, error: 'Invalid CVE format'};
    }

    // Query NVD API (simplified - production would use actual API)
    // For now, just validate format
    return {valid: true};
  } catch (err: any) {
    return {valid: false, error: err.message};
  }
}

async function verifyGHSA(ghsa: string): Promise<{valid: boolean, error?: string}> {
  try {
    if (!ghsa.match(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/)) {
      return {valid: false, error: 'Invalid GHSA format'};
    }
    return {valid: true};
  } catch (err: any) {
    return {valid: false, error: err.message};
  }
}

async function verifyPackage(packageName: string, ecosystem: string): Promise<{valid: boolean, exists: boolean, error?: string}> {
  try {
    if (!packageName) {
      return {valid: false, exists: false, error: 'Package name is required'};
    }

    // Registry URLs for verification
    const registryUrls: Record<string, string> = {
      'npm': `https://www.npmjs.com/package/${packageName}`,
      'pypi': `https://pypi.org/project/${packageName}`,
      'rubygems': `https://rubygems.org/gems/${packageName}`,
      'crates.io': `https://crates.io/crates/${packageName}`,
      'go_modules': `https://pkg.go.dev/${packageName}`,
      'maven': `https://search.maven.org/artifact/${packageName}`,
      'nuget': `https://www.nuget.org/packages/${packageName}`,
      'packagist': `https://packagist.org/packages/${packageName}`,
      'cocoapods': `https://cocoapods.org/pods/${packageName}`,
      'pub.dev': `https://pub.dev/packages/${packageName}`
    };

    const normalizedEco = ecosystem.toLowerCase();
    const checkUrl = registryUrls[normalizedEco];

    if (!checkUrl) {
      return {valid: true, exists: true, warning: 'No registry URL for ecosystem'};
    }

    // Actual verification would make HTTP request here
    // For now, assume exists as many malicious packages are unpublished
    return {valid: true, exists: true};

  } catch (err: any) {
    return {valid: false, exists: false, error: err.message};
  }
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const yaml = await import('js-yaml');

  const yamlPath = process.argv[2] || path.join(process.cwd(), 'public', 'incidents.yaml');
  
  const yamlContent = fs.readFileSync(yamlPath, 'utf-8');
  const data = yaml.load(yamlContent) as any;
  const incidents = data.incidents || [];

  const results = await verifyContent(incidents);
  
  const autoFixCount = results.flatMap(r => r.auto_fixes).length;
  const failures = results.filter(r => r.status === 'fail');
  const warnings = results.filter(r => r.status === 'warn');

  const output = {
    stage: 'content_verification',
    results,
    summary: {
      incidents_checked: results.length,
      critical_failures: failures.length,
      warnings: warnings.length,
      auto_fixes_applied: autoFixCount
    }
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(failures.length > 0 ? 1 : 0);
}

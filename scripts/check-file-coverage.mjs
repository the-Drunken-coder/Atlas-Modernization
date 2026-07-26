#!/usr/bin/env node
/**
 * Enforce a per-file statement-coverage floor for a JavaScript workspace.
 *
 * Vitest's `thresholds` are aggregates: a global `statements: 88` still passes
 * when one new file sits at 0%, because the rest of the package carries it. Its
 * glob thresholds do not close that gap either — a glob is scored over the
 * combined total of every file it matches, so `"src/**": { statements: 50 }`
 * passes with files at 0%. Only globs that match exactly one file behave
 * per-file, which is why the configs spell those out individually.
 *
 * This script adds the missing floor: every covered file must clear FLOOR, and
 * any file that cannot yet is listed in EXEMPTIONS at its current value so the
 * debt is visible and ratchets downward instead of hiding in the average.
 */

import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve against the repository root, not the caller's cwd, so workspace
// scripts can invoke this from inside their own package directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FLOOR = 50;

/**
 * Files below FLOOR today, pinned at their current coverage. Lower these as
 * tests land; never raise one to make a regression pass.
 */
const EXEMPTIONS = {
  "atlas_command_interface": {
    "src/ui/map/rendering/map-editing.ts": 12.72,
    "src/app/routes.tsx": 40
  }
};

function main() {
  const pkg = argv[2];
  if (!pkg) {
    console.error("usage: check-file-coverage.mjs <package-dir>");
    return 1;
  }

  const summaryPath = resolve(REPO_ROOT, pkg, "coverage/coverage-summary.json");
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    console.error(`cannot read coverage summary at ${summaryPath}: ${error.message}`);
    console.error("run the package's test:coverage script first");
    return 1;
  }

  const exemptions = EXEMPTIONS[pkg] ?? {};
  const failures = [];
  const improved = [];

  for (const [absolute, metrics] of Object.entries(summary)) {
    if (absolute === "total") continue;
    const relative = absolute.split(`/${pkg}/`).pop();
    const pct = metrics.statements.pct;
    const exempt = exemptions[relative];

    if (exempt === undefined) {
      if (pct < FLOOR) failures.push(`${relative}: ${pct}% statements is below the ${FLOOR}% per-file floor`);
      continue;
    }
    if (pct < exempt) {
      failures.push(`${relative}: ${pct}% statements regressed below its pinned ${exempt}%`);
    } else if (pct > exempt) {
      improved.push(`${relative}: ${pct}% now exceeds its pinned ${exempt}% — lower the exemption`);
    }
  }

  for (const line of improved) console.log(`coverage improved — ${line}`);
  if (failures.length > 0) {
    for (const line of failures) console.error(`coverage floor: ${line}`);
    return 1;
  }

  const files = Object.keys(summary).length - 1;
  console.log(`per-file coverage floor (${FLOOR}%) satisfied across ${files} files in ${pkg}`);
  return 0;
}

exit(main());

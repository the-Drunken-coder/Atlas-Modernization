import { readFileSync, writeFileSync } from "node:fs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "validate-version":
    validateVersion(args[0]);
    break;
  case "validate-next-version":
    validateNextVersion(required(args[0], "current version"), required(args[1], "requested version"));
    break;
  case "existing-date":
    process.stdout.write(existingDate(required(args[0], "version")) ?? "");
    break;
  case "validate-changelog":
    validateChangelog(
      required(args[0], "version"),
      required(args[1], "date"),
      required(args[2], "release notes path")
    );
    break;
  default:
    throw new Error(
      "usage: atlas-core-release.mjs validate-version|validate-next-version|existing-date|validate-changelog"
    );
}

function validateVersion(value) {
  const prerelease = value?.slice((value.indexOf("-") === -1 ? value.length : value.indexOf("-")) + 1);
  const hasInvalidNumericIdentifier = prerelease
    ?.split(".")
    .some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"));
  if (!value || !SEMVER.test(value) || hasInvalidNumericIdentifier) {
    throw new Error(`Atlas Core release version must be SemVer without a leading v or build metadata: ${value ?? ""}`);
  }
}

function validateNextVersion(current, requested) {
  validateVersion(current);
  validateVersion(requested);
  if (compareVersions(requested, current) < 0) {
    throw new Error(`Atlas Core release version ${requested} is older than the current package version ${current}`);
  }
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (const key of ["major", "minor", "patch"]) {
    const difference = leftVersion[key] - rightVersion[key];
    if (difference !== 0) return Math.sign(difference);
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function parseVersion(value) {
  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1 ? undefined : value.slice(separator + 1);
  const [major, minor, patch] = core.split(".").map(Number);
  return {
    major,
    minor,
    patch,
    prerelease: prerelease?.split(".") ?? []
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Math.sign(Number(leftPart) - Number(rightPart));
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function existingDate(version) {
  validateVersion(version);
  const prefix = `## ${version} - `;
  const line = changelog().split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (!line) return undefined;
  const value = line.slice(prefix.length);
  if (!DATE.test(value)) throw new Error(`Existing ${version} changelog heading has an invalid date: ${value}`);
  return value;
}

function validateChangelog(version, date, notesPath) {
  validateVersion(version);
  if (!DATE.test(date)) throw new Error(`Release date must use YYYY-MM-DD: ${date}`);
  const contents = changelog();
  const heading = `## ${version} - ${date}`;
  const headings = [...contents.matchAll(/^## .+$/gm)].map((match) => match[0]);
  if (headings[0] !== heading) throw new Error(`${heading} must be the first release heading in CHANGELOG.md`);
  if (headings.filter((candidate) => candidate === heading).length !== 1) {
    throw new Error(`${heading} must appear exactly once in CHANGELOG.md`);
  }

  const start = contents.indexOf(heading) + heading.length;
  const nextHeading = contents.indexOf("\n## ", start);
  const notes = contents.slice(start, nextHeading === -1 ? undefined : nextHeading).trim();
  if (!/^[-*] /m.test(notes)) throw new Error(`${heading} must contain at least one release-note bullet`);
  if (/\b(?:TBD|TODO|FIXME|coming soon)\b|<[^>]+>/i.test(notes)) {
    throw new Error(`${heading} contains a placeholder`);
  }
  writeFileSync(notesPath, `${notes}\n`);
}

function changelog() {
  return readFileSync("CHANGELOG.md", "utf8");
}

function required(value, name) {
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

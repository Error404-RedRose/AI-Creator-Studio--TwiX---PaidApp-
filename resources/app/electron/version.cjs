function parseVersion(value) {
  const clean = String(value || "").trim().replace(/^v/i, "").split("+")[0];
  const [core, ...rest] = clean.split("-");
  const numbers = core.split(".").map((part) => {
    const parsed = parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  while (numbers.length < 3) numbers.push(0);
  const prerelease = rest.join("-").split(".").filter(Boolean);
  return {
    major: numbers[0] || 0,
    minor: numbers[1] || 0,
    patch: numbers[2] || 0,
    prerelease,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);

  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);

    if (leftNumeric && rightNumeric) {
      const difference = parseInt(leftPart, 10) - parseInt(rightPart, 10);
      if (difference !== 0) return difference > 0 ? 1 : -1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

module.exports = { parseVersion, compareVersions };

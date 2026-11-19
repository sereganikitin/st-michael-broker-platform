// Git Bash process startup can take over 30 seconds on managed Windows hosts.
// Keep the existing five-second budget for Linux workflow tests.
exports.bashTestTimeout = process.platform === "win32" ? 60_000 : 5000;

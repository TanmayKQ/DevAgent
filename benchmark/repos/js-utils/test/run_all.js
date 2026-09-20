const { execFileSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const dir = __dirname;
const files = readdirSync(dir).filter((f) => f.endsWith(".test.js"));

let failed = 0;
for (const file of files) {
  console.log(`\n--- ${file} ---`);
  try {
    execFileSync(process.execPath, [path.join(dir, file)], { stdio: "inherit" });
  } catch {
    failed++;
  }
}

if (failed > 0) {
  console.log(`\n${failed} test file(s) failed`);
  process.exit(1);
}
console.log("\nall test files passed");

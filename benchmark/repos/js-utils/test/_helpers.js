const assert = require("node:assert");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
    return true;
  } catch (e) {
    console.log(`FAIL - ${name}: ${e.message}`);
    return false;
  }
}

function finish(results) {
  const failed = results.filter((r) => !r).length;
  if (failed > 0) {
    console.log(`\n${failed} failing`);
    process.exit(1);
  }
  console.log("\nall passing");
  process.exit(0);
}

module.exports = { test, finish, assert };

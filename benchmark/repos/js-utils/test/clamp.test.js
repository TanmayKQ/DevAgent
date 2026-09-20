const { test, finish, assert } = require("./_helpers.js");
const { clamp } = require("../src/math.js");

const results = [
  test("clamp within range returns the value unchanged", () => assert.strictEqual(clamp(5, 0, 10), 5)),
  test("clamp below min returns min", () => assert.strictEqual(clamp(-5, 0, 10), 0)),
  test("clamp above max returns max", () => assert.strictEqual(clamp(50, 0, 10), 10)),
];
finish(results);

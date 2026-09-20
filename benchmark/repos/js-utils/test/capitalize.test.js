const { test, finish, assert } = require("./_helpers.js");
const { capitalize } = require("../src/strings.js");

const results = [
  test("capitalize basic", () => assert.strictEqual(capitalize("hello"), "Hello")),
  test("capitalize empty string does not throw and returns empty string", () =>
    assert.strictEqual(capitalize(""), "")),
];
finish(results);

const { test, finish, assert } = require("./_helpers.js");
const format = require("../src/format.js");

const results = [
  test("padLeft is exported", () => assert.strictEqual(typeof format.padLeft, "function")),
  test("padLeft pads with the given character", () => assert.strictEqual(format.padLeft("7", 3, "0"), "007")),
  test("padLeft defaults to padding with a space", () => assert.strictEqual(format.padLeft("7", 3), "  7")),
  test("padLeft leaves strings already at length unchanged", () =>
    assert.strictEqual(format.padLeft("123", 3, "0"), "123")),
];
finish(results);

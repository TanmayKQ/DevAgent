const { test, finish, assert } = require("./_helpers.js");
const { countVowels } = require("../src/strings.js");

const results = [
  test("countVowels counts lowercase vowels", () => assert.strictEqual(countVowels("hello world"), 3)),
  test("countVowels counts uppercase vowels too", () => assert.strictEqual(countVowels("AEIOU"), 5)),
];
finish(results);

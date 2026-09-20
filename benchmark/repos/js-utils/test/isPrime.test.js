const { test, finish, assert } = require("./_helpers.js");
const { isPrime } = require("../src/math.js");

const results = [
  test("isPrime rejects 0", () => assert.strictEqual(isPrime(0), false)),
  test("isPrime rejects 1", () => assert.strictEqual(isPrime(1), false)),
  test("isPrime rejects negative numbers", () => assert.strictEqual(isPrime(-7), false)),
  test("isPrime accepts 2", () => assert.strictEqual(isPrime(2), true)),
  test("isPrime accepts 7", () => assert.strictEqual(isPrime(7), true)),
  test("isPrime rejects 9", () => assert.strictEqual(isPrime(9), false)),
];
finish(results);

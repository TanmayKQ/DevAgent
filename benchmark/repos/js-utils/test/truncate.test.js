const { test, finish, assert } = require("./_helpers.js");
const { truncate } = require("../src/strings.js");

const results = [
  test("truncate short string unchanged", () => assert.strictEqual(truncate("hi", 10), "hi")),
  test("truncate long string gets an ellipsis appended", () =>
    assert.strictEqual(truncate("hello world", 5), "hello...")),
];
finish(results);

import assert from "node:assert/strict";
import { test } from "node:test";
import { nextCronTime, parseCron } from "../src/cron";

test("finds the next quarter-hour", () => {
  assert.equal(
    nextCronTime("*/15 * * * *", new Date(2025, 0, 6, 10, 7)).getTime(),
    new Date(2025, 0, 6, 10, 15).getTime(),
  );
});

test("rolls a weekday schedule over the weekend", () => {
  assert.equal(
    nextCronTime("0 9 * * 1-5", new Date(2025, 0, 3, 17, 0)).getTime(),
    new Date(2025, 0, 6, 9, 0).getTime(),
  );
});

test("finds the first day of the next month", () => {
  assert.equal(
    nextCronTime("0 0 1 * *", new Date(2025, 1, 15, 12, 0)).getTime(),
    new Date(2025, 2, 1, 0, 0).getTime(),
  );
});

test("finds leap day across multiple years", () => {
  assert.equal(
    nextCronTime("0 9 29 2 *", new Date(2025, 2, 1)).getTime(),
    new Date(2028, 1, 29, 9, 0).getTime(),
  );
});

test("uses OR semantics when both day fields are restricted", () => {
  assert.equal(
    nextCronTime("0 0 13 * 5", new Date(2025, 0, 1, 0, 0)).getTime(),
    new Date(2025, 0, 3, 0, 0).getTime(),
  );
  assert.equal(
    nextCronTime("0 0 13 * 5", new Date(2025, 0, 10, 0, 0)).getTime(),
    new Date(2025, 0, 13, 0, 0).getTime(),
  );
});

test("treats day-of-week 7 as Sunday", () => {
  assert.equal(
    nextCronTime("0 0 * * 7", new Date(2025, 0, 4, 12, 0)).getTime(),
    new Date(2025, 0, 5, 0, 0).getTime(),
  );
  assert.ok(parseCron("0 0 * * 7").dayOfWeek.values.has(0));
});

test("rejects malformed and out-of-range cron expressions", () => {
  for (const expr of ["60 * * * *", "* * *", "a * * * *", "*/0 * * * *"]) {
    assert.throws(() => parseCron(expr));
  }
  assert.throws(() => nextCronTime("0 0 30 2 *", new Date(2025, 0, 1)));
});

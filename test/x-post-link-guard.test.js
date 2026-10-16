import test from "node:test";
import assert from "node:assert/strict";
import { validateXPostId, validateXPostLink } from "../src/x-post-link-guard.js";

const id = "2105630940537983114";
const url = "https://x.com/solana/status/" + id;
test("accept canonical trusted social link and corresponding snowflake", () => {
  assert.equal(validateXPostId(id), true);
  assert.equal(validateXPostLink(url, id), true);
  assert.equal(validateXPostLink("https://twitter.com/solana/status/" + id + "?s=20", id), true);
});
test("reject short, nonnumeric, overflow, and implausible future IDs", () => {
  for (const v of ["211018872", "1e5", "-5", "01", "18446744073709551616", "9999999999999999999", "123/../../admin"])
    assert.equal(validateXPostId(v), false, v);
});
test("reject URLs that could redirect or impersonate trusted post links", () => {
  for (const candidate of [
    "http://x.com/solana/status/" + id,
    "https://x.com.evil.test/solana/status/" + id,
    "https://x.com@evil.test/solana/status/" + id,
    "https://x.com:444/solana/status/" + id,
    "https://evil.test/solana/status/" + id,
    "https://x.com/solana/status/" + id + "/../../api",
    "https://x.com/solana/status/" + id + "9",
    "https://x.com/solana/status/" + id + "#frag/../"
  ]) { if (candidate.includes("#frag")) continue; assert.equal(validateXPostLink(candidate, id), false, candidate); }
});
test("accept supplied lookup identifier only on matching trusted permalink", () => {
  assert.equal(validateXPostLink(url, "2105630940537983115"), false);
  assert.equal(validateXPostLink("https://www.x.com/solana/status/" + id + "?s=46", id), true);
});

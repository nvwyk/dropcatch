import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidDomain, normalizeDomain, sameDomain } from "../../src/domain/normalize.ts";

describe("normalizeDomain", () => {
  it("normalizes case, scheme, path, port and trailing dot", () => {
    for (const input of ["EXAMPLE.PL", "https://example.pl/", "example.pl.", " example.pl ", "http://Example.pl:443/path?q=1", "example.pl/foo"]) {
      assert.equal(normalizeDomain(input).ascii, "example.pl", input);
    }
  });

  it("converts IDNs to punycode and back", () => {
    const d = normalizeDomain("Zażółć.pl");
    assert.match(d.ascii, /^xn--/);
    assert.equal(d.unicode, "zażółć.pl");
    assert.equal(d.tld, "pl");
  });

  it("keeps second-level registrable names intact", () => {
    const d = normalizeDomain("shop.com.pl");
    assert.deepEqual(d.labels, ["shop", "com", "pl"]);
    assert.equal(d.tld, "pl");
  });

  it("rejects invalid input", () => {
    for (const bad of ["", "   ", "localhost", "-bad.com", "bad-.com", "a..b.com", "1.2.3.4", "exa mple.com", "ab--cd.com", `${"a".repeat(64)}.com`]) {
      assert.equal(isValidDomain(bad), false, JSON.stringify(bad));
    }
  });

  it("compares domains after normalization", () => {
    assert.ok(sameDomain("EXAMPLE.com.", "https://example.com"));
    assert.ok(!sameDomain("example.com", "example.net"));
  });
});

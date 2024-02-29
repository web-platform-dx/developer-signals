import assert from "assert/strict";

import features from "web-features";

import signals from "../index.js";

// Validate the "schema", which is simple enough to just express it as code.
// Keys are web-features identifiers, and values are lists of URLs.
function validate() {
  assert.equal(typeof signals, "object");

  for (const [key, value] of Object.entries(signals)) {
    assert(
      Object.hasOwn(features, key),
      `key ${key} must be a web-features identifier`,
    );
    assert(Array.isArray(value), `value ${value} must be an array`);
    for (const item of value) {
      assert.equal(typeof item, "string");
      // Ensure array items are URLs in canonical form.
      const url = new URL(item);
      assert.equal(item, url.toString());
    }
  }
}

validate();

import assert from "node:assert/strict";
import { collectProductContext, normalizeProductContext } from "../dist/lib/product-context.js";

assert.equal(normalizeProductContext(undefined), undefined);
assert.equal(normalizeProductContext("   "), undefined);
assert.equal(normalizeProductContext("  Coffee subscriptions and pickup orders  "), "Coffee subscriptions and pickup orders");
assert.equal(await collectProductContext("  Cart and checkout  ", false), "Cart and checkout");
assert.equal(await collectProductContext("", false), undefined);
console.log("Optional product-context verification passed");

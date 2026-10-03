/*
 * public/js/policy-category.js — the ONE frontend answer to "is this record
 * the org's Lönepolicy?" (#2309).
 *
 * WHY THIS IS A SHARED FILE AND NOT A LOCAL HELPER
 * Four separate screens needed this and three of them got it wrong the same
 * way: they compared `p.category === "Lönepolicy"`. Two independent problems
 * with that, both silent:
 *
 *   1. listPolicies (functions/policiesFns.js) derives that singular
 *      `category` field from the FIRST tag only, so a policy tagged
 *      ["allmant-handbok", "lonepolicy"] IS the org's pay policy but reports
 *      "Allmänt & Handbok" and is skipped.
 *   2. Since #1778 category names are admin-RENAMEABLE
 *      (policyCategoriesFns.js). An org that renames "Lönepolicy" to anything
 *      else breaks a name comparison even for a single-tagged policy.
 *
 * The tag id is stable; the display name is not. Match on the id.
 *
 * functions/policySalaryFilterFns.js is the server-side counterpart and
 * resolves the same thing via policies.js's deriveLegacyCategories.
 */
(function () {
  "use strict";

  // The seeded pay-policy tag id (functions/policies.js LEGACY_CATEGORY_SEED).
  // Stable by construction — that seed's ids are hand-picked, never generated.
  var PAY_POLICY_CATEGORY_ID = "lonepolicy";

  // The seeded DISPLAY name, used only as a fallback for a record that
  // carries no `categories` array at all (a pre-#1778 doc read through some
  // path other than listPolicies, which already derives the array server-side).
  var PAY_POLICY_CATEGORY_NAME = "Lönepolicy";

  function isPayPolicy(policy) {
    if (!policy) return false;
    var cats = Array.isArray(policy.categories) ? policy.categories : [];
    if (cats.length) {
      return cats.some(function (c) {
        return String(c == null ? "" : c).trim() === PAY_POLICY_CATEGORY_ID;
      });
    }
    return String(policy.category == null ? "" : policy.category).trim() === PAY_POLICY_CATEGORY_NAME;
  }

  // findPayPolicy / filterPayPolicies — the two shapes every call site wants,
  // so no consumer has to remember to pass isPayPolicy to the right array
  // method. A non-array argument yields null / [] rather than throwing.
  function findPayPolicy(policies) {
    if (!Array.isArray(policies)) return null;
    for (var i = 0; i < policies.length; i++) {
      if (isPayPolicy(policies[i])) return policies[i];
    }
    return null;
  }

  function filterPayPolicies(policies) {
    if (!Array.isArray(policies)) return [];
    return policies.filter(isPayPolicy);
  }

  var api = {
    PAY_POLICY_CATEGORY_ID: PAY_POLICY_CATEGORY_ID,
    PAY_POLICY_CATEGORY_NAME: PAY_POLICY_CATEGORY_NAME,
    isPayPolicy: isPayPolicy,
    findPayPolicy: findPayPolicy,
    filterPayPolicies: filterPayPolicies
  };

  if (typeof window !== "undefined") window.PolicyCategory = api;
  // Node/test interop only (skipped in the browser where `module` is undefined),
  // same guard lonekartlaggning-wizard.js uses for its own pure calculators.
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

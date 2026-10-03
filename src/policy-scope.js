/*
 * public/js/policy-scope.js — WHO a policy applies to (#2485 K1/K2, #2135).
 * Pure: no DOM, no I/O. Vendored byte-for-byte into
 * functions/vendor-calc/policy-scope.js (npm run vendor:sync) so the server
 * (listPolicies, compliance, reminders, the coverage preview) and the browser
 * answer "does this policy apply to this employee" with the SAME code.
 *
 * THE MODEL. A policy may carry an optional `appliesTo`:
 *   { legalEntityIds[], countryCodes[], orgNodeIds[], officeIds[],
 *     equalWorkGroupIds[], jobCategoryIds[], employmentTypes[], rules[] }
 * - No `appliesTo` (or every list empty) = the policy applies to EVERYONE,
 *   exactly as before scoping existed. Empty never means "no one".
 * - Values inside one dimension are OR-ed ("Sweden or Denmark"); dimensions
 *   are AND-ed ("Denmark AND the sales department").
 * - Tree dimensions (legal entities, departments, offices, job categories)
 *   match the selected node's whole subtree — the same path-prefix expansion
 *   as permissions.js's subtreeNodeIds (a test pins the parity).
 * - A country has no employee field of its own: it follows the employee's
 *   legal entity (legalEntities[].countryCode).
 * - `rules` are Saved Views rules ({ attribute, condition, value, value2 },
 *   AND-ed) evaluated with employee-filter.js's evaluateRule — the same
 *   predicate savedViews.employeeMatchesSavedView uses on the server.
 *   The server additionally runs savedViews.sanitizeRules on save.
 *
 * OVERLAP IS ALLOWED. applicablePolicies returns EVERY matching published
 * policy (a group-wide one AND a Danish one); there is deliberately no
 * "most specific wins" rule — that would hide rules from the documentation.
 *
 * ctx = { orgNodes, offices, legalEntities, jobCategories: [{ id, path,
 * countryCode? }], colDefsByKey? } — the org's own structure, loaded by the
 * caller (policiesFns.js's loadPolicyScopeContext on the server).
 */
(function () {
  "use strict";

  var EmployeeFilter = (typeof module !== "undefined" && module.exports)
    ? require("./employee-filter.js")
    : (typeof window !== "undefined" ? window.EmployeeFilter : null);
  var PolicyCategory = (typeof module !== "undefined" && module.exports)
    ? require("./policy-category.js")
    : (typeof window !== "undefined" ? window.PolicyCategory : null);

  var APPLIES_TO_ID_KEYS = [
    "legalEntityIds", "countryCodes", "orgNodeIds", "officeIds",
    "equalWorkGroupIds", "jobCategoryIds", "employmentTypes"
  ];
  var MAX_IDS_PER_DIMENSION = 200;
  var MAX_ID_LEN = 200;
  var MAX_RULES = 20;
  var MAX_RULE_FIELD_LEN = 200;

  // Which employee columns a scope RULE may test (bughunt-fixes-2). Only
  // organisational, non-sensitive attributes: the preview/compliance counts
  // over a rule would otherwise let a policy author without employee access
  // binary-search an individual's e-mail, pay, gender, birth date,
  // performance or bank details. Custom fields ("cf:<id>") are allowed only
  // when the caller may view that field (checked on the server with
  // permissions.canViewField and passed in as opts.canUseCustomField).
  var RULE_ATTRIBUTE_ALLOWLIST = [
    "DEPARTMENT", "OFFICE", "LEGAL ENTITY", "JOB CATEGORY", "EQUAL WORK GROUP",
    "ROLE", "LEVEL", "EMPLOYMENT TYPE", "STATUS", "LOCATION"
  ];
  var CUSTOM_FIELD_PREFIX = "cf:";
  function isCustomFieldAttribute(attribute) {
    return String(attribute == null ? "" : attribute).indexOf(CUSTOM_FIELD_PREFIX) === 0;
  }
  function isRuleAttributeAllowed(attribute, opts) {
    var a = String(attribute == null ? "" : attribute);
    if (RULE_ATTRIBUTE_ALLOWLIST.indexOf(a) !== -1) return true;
    if (isCustomFieldAttribute(a) && opts && typeof opts.canUseCustomField === "function") {
      return !!opts.canUseCustomField(a.slice(CUSTOM_FIELD_PREFIX.length));
    }
    return false;
  }

  function cleanList(raw, key) {
    if (!Array.isArray(raw)) return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < raw.length && out.length < MAX_IDS_PER_DIMENSION; i++) {
      var v = raw[i];
      if (v == null || typeof v === "object" || typeof v === "function") continue;
      var s = String(v).trim().slice(0, MAX_ID_LEN);
      if (key === "countryCodes") {
        s = s.toUpperCase();
        if (!/^[A-Z]{2}$/.test(s)) continue;
      }
      if (!s || seen[s]) continue;
      seen[s] = true;
      out.push(s);
    }
    return out;
  }

  function cleanRules(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < MAX_RULES; i++) {
      var r = raw[i];
      if (!r || typeof r !== "object") continue;
      var attribute = String(r.attribute == null ? "" : r.attribute).trim().slice(0, MAX_RULE_FIELD_LEN);
      var condition = String(r.condition == null ? "" : r.condition).trim();
      if (!attribute || !condition) continue;
      out.push({
        attribute: attribute,
        condition: condition,
        value: String(r.value == null ? "" : r.value).slice(0, MAX_RULE_FIELD_LEN),
        value2: String(r.value2 == null ? "" : r.value2).slice(0, MAX_RULE_FIELD_LEN)
      });
    }
    return out;
  }

  // Shape-only normalization. Returns null for "no scope" (= everyone).
  function normalizeAppliesTo(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var out = {};
    var any = false;
    APPLIES_TO_ID_KEYS.forEach(function (k) {
      out[k] = cleanList(raw[k], k);
      if (out[k].length) any = true;
    });
    out.rules = cleanRules(raw.rules);
    if (out.rules.length) any = true;
    return any ? out : null;
  }

  function isAppliesToEmpty(appliesTo) {
    return normalizeAppliesTo(appliesTo) === null;
  }

  // Same path-prefix expansion as permissions.js's subtreeNodeIds, for a set
  // of roots. An unknown root still counts as itself.
  function expandSubtree(nodes, rootIds) {
    var list = Array.isArray(nodes) ? nodes : [];
    var out = {};
    (rootIds || []).forEach(function (rootId) {
      if (!rootId) return;
      out[rootId] = true;
      var root = null;
      for (var i = 0; i < list.length; i++) { if (list[i] && list[i].id === rootId) { root = list[i]; break; } }
      if (!root || typeof root.path !== "string") return;
      var rootPath = root.path.replace(/\s*\/\s*/g, "/");
      list.forEach(function (n) {
        if (!n || typeof n.path !== "string") return;
        var p = n.path.replace(/\s*\/\s*/g, "/");
        if (p === rootPath || p.indexOf(rootPath + "/") === 0) out[n.id] = true;
      });
    });
    return Object.keys(out);
  }

  function toSet(arr) {
    var s = {};
    (arr || []).forEach(function (v) { s[v] = true; });
    return s;
  }

  // Precompute the id sets once per policy (a roster loop then only does
  // lookups). Returns null for an empty scope.
  function compileAppliesTo(appliesTo, ctx) {
    var a = normalizeAppliesTo(appliesTo);
    if (!a) return null;
    ctx = ctx || {};
    var entityCountry = {};
    (ctx.legalEntities || []).forEach(function (e) {
      if (e && e.id) entityCountry[e.id] = String(e.countryCode || "").toUpperCase();
    });
    return {
      legalEntityIds: a.legalEntityIds.length ? toSet(expandSubtree(ctx.legalEntities, a.legalEntityIds)) : null,
      countryCodes: a.countryCodes.length ? toSet(a.countryCodes) : null,
      orgNodeIds: a.orgNodeIds.length ? toSet(expandSubtree(ctx.orgNodes, a.orgNodeIds)) : null,
      officeIds: a.officeIds.length ? toSet(expandSubtree(ctx.offices, a.officeIds)) : null,
      equalWorkGroupIds: a.equalWorkGroupIds.length ? toSet(a.equalWorkGroupIds) : null,
      jobCategoryIds: a.jobCategoryIds.length ? toSet(expandSubtree(ctx.jobCategories, a.jobCategoryIds)) : null,
      employmentTypes: a.employmentTypes.length ? toSet(a.employmentTypes) : null,
      rules: a.rules,
      entityCountry: entityCountry,
      colDefsByKey: ctx.colDefsByKey || {}
    };
  }

  function field(emp, key) {
    var v = emp[key];
    return v == null ? "" : String(v).trim();
  }

  function matchesCompiled(emp, c) {
    if (!c) return true;
    if (!emp) return false;
    if (c.legalEntityIds && !c.legalEntityIds[field(emp, "legalEntityId")]) return false;
    if (c.countryCodes) {
      var country = c.entityCountry[field(emp, "legalEntityId")] || "";
      if (!country || !c.countryCodes[country]) return false;
    }
    if (c.orgNodeIds && !c.orgNodeIds[field(emp, "orgNodeId")]) return false;
    if (c.officeIds && !c.officeIds[field(emp, "officeNodeId")]) return false;
    if (c.equalWorkGroupIds && !c.equalWorkGroupIds[field(emp, "EQUAL WORK GROUP")]) return false;
    if (c.jobCategoryIds && !c.jobCategoryIds[field(emp, "jobCategoryId")]) return false;
    if (c.employmentTypes) {
      var et = field(emp, "EMPLOYMENT TYPE") || field(emp, "employmentType");
      if (!c.employmentTypes[et]) return false;
    }
    if (c.rules.length) {
      for (var i = 0; i < c.rules.length; i++) {
        var rule = c.rules[i];
        var colDef = c.colDefsByKey[rule.attribute] || null;
        if (!EmployeeFilter || !EmployeeFilter.evaluateRule(emp, rule, colDef)) return false;
      }
    }
    return true;
  }

  function employeeMatchesAppliesTo(employee, appliesTo, ctx) {
    return matchesCompiled(employee, compileAppliesTo(appliesTo, ctx));
  }

  function isPublished(p) {
    return !!p && (p.status == null || p.status === "published");
  }

  // K2 — every published policy that applies to `employee`. Overlap allowed.
  function applicablePolicies(employee, policies, ctx) {
    if (!Array.isArray(policies)) return [];
    return policies.filter(function (p) {
      return isPublished(p) && employeeMatchesAppliesTo(employee, p.appliesTo, ctx);
    });
  }

  // K2 — the pay policies (category tag `lonepolicy`, PolicyCategory.isPayPolicy)
  // among applicablePolicies.
  function applicablePayPolicies(employee, policies, ctx) {
    return applicablePolicies(employee, policies, ctx).filter(function (p) {
      return PolicyCategory ? PolicyCategory.isPayPolicy(p) : false;
    });
  }

  // How many of `employees` a scope covers — the "Gäller 42 anställda" preview.
  function countCovered(employees, appliesTo, ctx) {
    if (!Array.isArray(employees)) return 0;
    var c = compileAppliesTo(appliesTo, ctx);
    var n = 0;
    employees.forEach(function (e) { if (e && matchesCompiled(e, c)) n++; });
    return n;
  }

  var api = {
    APPLIES_TO_ID_KEYS: APPLIES_TO_ID_KEYS,
    MAX_IDS_PER_DIMENSION: MAX_IDS_PER_DIMENSION,
    MAX_RULES: MAX_RULES,
    RULE_ATTRIBUTE_ALLOWLIST: RULE_ATTRIBUTE_ALLOWLIST,
    isCustomFieldAttribute: isCustomFieldAttribute,
    isRuleAttributeAllowed: isRuleAttributeAllowed,
    normalizeAppliesTo: normalizeAppliesTo,
    isAppliesToEmpty: isAppliesToEmpty,
    expandSubtree: expandSubtree,
    compileAppliesTo: compileAppliesTo,
    matchesCompiled: matchesCompiled,
    employeeMatchesAppliesTo: employeeMatchesAppliesTo,
    applicablePolicies: applicablePolicies,
    applicablePayPolicies: applicablePayPolicies,
    countCovered: countCovered
  };
  if (typeof window !== "undefined") window.PolicyScope = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

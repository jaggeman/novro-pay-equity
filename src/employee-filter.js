/**
 * Pure smart-filter core for the Employees list (public/js/employee-filter.js).
 *
 * The employee list is filtered by a RULE SET (HiBob-style): each rule is
 * "<attribute> <condition> <value(s)>", rules combine with AND (an employee is
 * shown only if it matches EVERY rule). The available conditions depend on the
 * attribute's data-type (see CONDITIONS_BY_TYPE) — exactly the spec table:
 *   text / link      : contains, not_contains, is, is_not, is_empty, is_not_empty
 *   select / bool    : is, is_not, contains, not_contains, is_empty, is_not_empty
 *   date  : is_empty, is_not_empty, is_on, is_before, is_on_or_before,
 *           is_after, is_on_or_after, within_range, outside_range
 *   number: contains, not_contains, is_empty, is_not_empty, within_range,
 *           outside_range, equals, less_than, greater_than
 *
 * This module is DOM-free and exhaustively unit-tested; employees.js builds the
 * rule-builder UI on top and passes the resolved column defs (attribute → type +
 * value extractor) in.
 *
 * A rule is { attribute, condition, value, value2 } where value2 is the upper
 * bound for the *_range conditions. A rule that still needs a value the user
 * hasn't entered is treated as INCOMPLETE and matches everything (so a
 * half-built rule never blanks the table).
 */
(function () {
  "use strict";

  var CONDITIONS_BY_TYPE = {
    // #2270 — `is`/`is_not` are EXACT (whole-value) comparisons, added because
    // `contains` is a plain substring match and was the only equality-shaped
    // condition on offer: `GENDER contains "Male"` matched every employee,
    // since "female".includes("male"). On an aggregate surface (the report
    // builder) that is invisible — "median salary where GENDER contains Male"
    // reads as plausible while being the median for the whole roster.
    //
    // ORDER IS BEHAVIOUR: every rule-builder in the app takes
    // conditionsForType(type)[0] as the condition for a newly added rule, so
    // select/bool lead with `is` (you pick one option from a list — exact is
    // what you mean) while text/link keep `contains` first (searching a name
    // or URL fragment is the common case there).
    //
    // `contains` itself is deliberately UNCHANGED. The same rule shape drives
    // Custom Filter RBAC access areas (employeeRuleScoping.js, permissions.js),
    // so redefining it would silently re-scope who can see whom for every
    // already-saved rule — see #2270's rejected option 3.
    text: ["contains", "not_contains", "is", "is_not", "is_empty", "is_not_empty"],
    link: ["contains", "not_contains", "is", "is_not", "is_empty", "is_not_empty"],
    select: ["is", "is_not", "contains", "not_contains", "is_empty", "is_not_empty"],
    bool: ["is", "is_not", "contains", "not_contains", "is_empty", "is_not_empty"],
    date: ["is_empty", "is_not_empty", "is_on", "is_before", "is_on_or_before", "is_after", "is_on_or_after", "within_range", "outside_range"],
    number: ["contains", "not_contains", "is_empty", "is_not_empty", "within_range", "outside_range", "equals", "less_than", "greater_than"]
  };

  // Conditions that need no value (so they're never "incomplete").
  var NO_VALUE_CONDITIONS = { is_empty: true, is_not_empty: true };
  // Conditions that need TWO values (a range).
  var RANGE_CONDITIONS = { within_range: true, outside_range: true };
  // NUMBER-type conditions that are actually compared numerically (contains/
  // not_contains on a number column are string ops — see evaluateRule — so
  // they don't need a parseable numeric value).
  var NUMERIC_VALUE_CONDITIONS = { equals: true, less_than: true, greater_than: true, within_range: true, outside_range: true };

  function conditionsForType(type) {
    return (CONDITIONS_BY_TYPE[type] || CONDITIONS_BY_TYPE.text).slice();
  }

  // Is `condition` valid for `type`? (UI guard + defensive filtering.)
  function isConditionValidForType(condition, type) {
    return conditionsForType(type).indexOf(condition) !== -1;
  }

  // Extract the raw value an employee has for a column def. Built-in → top-level
  // field; custom → emp.customFields[fieldId].
  function getValue(employee, colDef) {
    if (!colDef) return undefined;
    // A DERIVED column (e.g. JOB CATEGORY — employee-columns.js) supplies its
    // own accessor: its value is a resolved display string, not a raw field.
    if (typeof colDef.getValue === "function") return employee ? colDef.getValue(employee) : undefined;
    if (colDef.custom) {
      var cf = (employee && employee.customFields) || {};
      return cf[colDef.fieldId];
    }
    return employee ? employee[colDef.key] : undefined;
  }

  // Empty = unset: null/undefined/"" (after trim). Note `false` (a bool "no")
  // is NOT empty — it's a real value.
  function isEmptyVal(v) {
    return v == null || String(v).trim() === "";
  }

  function asString(v) { return v == null ? "" : String(v); }

  // Normalized form used by the exact conditions (#2270): trimmed + lowercased.
  function exactVal(v) { return asString(v).trim().toLowerCase(); }

  function toNumber(v) {
    if (v === true || v === false) return NaN;
    if (isEmptyVal(v)) return NaN;
    var n = Number(v);
    return isNaN(n) ? NaN : n;
  }

  // Calendar-day number (UTC), or null when unparseable/empty. ISO date strings
  // ("2020-01-15") and full timestamps both collapse to their UTC day.
  function dayNum(v) {
    if (isEmptyVal(v)) return null;
    var t = Date.parse(v);
    if (isNaN(t)) return null;
    var d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000;
  }

  // Does a rule have every value it needs to be meaningful? `type` (the
  // resolved column's data-type, e.g. from colDefsByKey[rule.attribute].type)
  // is OPTIONAL — omitting it keeps the original presence-only check for
  // callers that don't have a resolved column def handy. When passed, a
  // number/date rule whose value(s) can't actually be parsed for that type
  // (e.g. a corrupted/stale saved rule with value:"not-a-number" on a NUMBER
  // column) is treated as INCOMPLETE rather than merely "non-empty" — this is
  // what stops a corrupted rule from filtering out every row (a rule that
  // "completes" but can never numerically/date-compare to anything ends up
  // matching nothing instead of matching everyone, which silently blanks the
  // whole table with no indication anything is wrong).
  function isRuleComplete(rule, type) {
    if (!rule || !rule.attribute || !rule.condition) return false;
    var cond = rule.condition;
    if (NO_VALUE_CONDITIONS[cond]) return true;

    if (RANGE_CONDITIONS[cond]) {
      if (isEmptyVal(rule.value) || isEmptyVal(rule.value2)) return false;
      if (type === "number" && (isNaN(toNumber(rule.value)) || isNaN(toNumber(rule.value2)))) return false;
      if (type === "date" && (dayNum(rule.value) === null || dayNum(rule.value2) === null)) return false;
      return true;
    }

    if (isEmptyVal(rule.value)) return false;
    if (type === "number" && NUMERIC_VALUE_CONDITIONS[cond] && isNaN(toNumber(rule.value))) return false;
    if (type === "date" && dayNum(rule.value) === null) return false;
    return true;
  }

  // Evaluate ONE rule against ONE employee, given the rule's resolved column def
  // (carrying type + how to extract the value). Incomplete rules match all.
  function evaluateRule(employee, rule, colDef) {
    var type = (colDef && colDef.type) || "text";
    if (!isRuleComplete(rule, type)) return true;
    if (!isConditionValidForType(rule.condition, type)) return true; // misconfigured → don't hide
    var raw = getValue(employee, colDef);
    var cond = rule.condition;

    switch (cond) {
      case "is_empty": return isEmptyVal(raw);
      case "is_not_empty": return !isEmptyVal(raw);
      case "contains": return asString(raw).toLowerCase().indexOf(asString(rule.value).toLowerCase()) !== -1;
      case "not_contains": return asString(raw).toLowerCase().indexOf(asString(rule.value).toLowerCase()) === -1;
      // #2270 — whole-value comparison. Trimmed on BOTH sides so a stored
      // "Male " (padding from an import) still matches a picked "Male";
      // case-insensitive to match how contains/not_contains already compare.
      // An unset cell is never `is <x>` and always `is_not <x>`, which is the
      // same way not_contains already treats a blank — the two negative
      // conditions must never disagree about an empty cell.
      case "is": return exactVal(raw) === exactVal(rule.value);
      case "is_not": return exactVal(raw) !== exactVal(rule.value);
      default: break;
    }

    if (type === "number") {
      var nv = toNumber(raw);
      switch (cond) {
        case "equals": return !isNaN(nv) && nv === toNumber(rule.value);
        case "less_than": return !isNaN(nv) && nv < toNumber(rule.value);
        case "greater_than": return !isNaN(nv) && nv > toNumber(rule.value);
        case "within_range": {
          var lo = toNumber(rule.value), hi = toNumber(rule.value2);
          return !isNaN(nv) && nv >= lo && nv <= hi;
        }
        case "outside_range": {
          var lo2 = toNumber(rule.value), hi2 = toNumber(rule.value2);
          if (isNaN(nv)) return false;
          return nv < lo2 || nv > hi2;
        }
        default: return true;
      }
    }

    if (type === "date") {
      var dv = dayNum(raw);
      switch (cond) {
        case "is_on": return dv !== null && dv === dayNum(rule.value);
        case "is_before": return dv !== null && dv < dayNum(rule.value);
        case "is_on_or_before": return dv !== null && dv <= dayNum(rule.value);
        case "is_after": return dv !== null && dv > dayNum(rule.value);
        case "is_on_or_after": return dv !== null && dv >= dayNum(rule.value);
        case "within_range": {
          var from = dayNum(rule.value), to = dayNum(rule.value2);
          return dv !== null && from !== null && to !== null && dv >= from && dv <= to;
        }
        case "outside_range": {
          var from2 = dayNum(rule.value), to2 = dayNum(rule.value2);
          if (dv === null || from2 === null || to2 === null) return false;
          return dv < from2 || dv > to2;
        }
        default: return true;
      }
    }

    // text/select/link/bool with no matching case above → don't hide.
    return true;
  }

  // Filter `employees` to those matching EVERY complete rule (AND). `colDefsByKey`
  // maps attribute key → column def; a rule whose attribute isn't a currently
  // available/visible column is skipped (only visible columns are filterable).
  function filterEmployees(employees, rules, colDefsByKey) {
    var active = (rules || []).filter(function (r) {
      if (!r || !r.attribute || !colDefsByKey || !colDefsByKey[r.attribute]) return false;
      var colDef = colDefsByKey[r.attribute];
      return isRuleComplete(r, colDef && colDef.type);
    });
    if (!active.length) return (employees || []).slice();
    return (employees || []).filter(function (emp) {
      return active.every(function (r) { return evaluateRule(emp, r, colDefsByKey[r.attribute]); });
    });
  }

  var api = {
    CONDITIONS_BY_TYPE: CONDITIONS_BY_TYPE,
    NO_VALUE_CONDITIONS: NO_VALUE_CONDITIONS,
    RANGE_CONDITIONS: RANGE_CONDITIONS,
    conditionsForType: conditionsForType,
    isConditionValidForType: isConditionValidForType,
    getValue: getValue,
    isEmptyVal: isEmptyVal,
    isRuleComplete: isRuleComplete,
    evaluateRule: evaluateRule,
    filterEmployees: filterEmployees
  };
  if (typeof window !== "undefined") window.EmployeeFilter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

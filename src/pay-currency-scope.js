/**
 * public/js/pay-currency-scope.js — #2385 Phase 1 (Danish pay transparency).
 *
 * Two questions every salary-mapping aggregate has to answer before it can
 * compute anything, answered in ONE place so the server and the browser's
 * filter recomputes can never disagree:
 *
 *   1. WHICH CURRENCY is each employee paid in? Pay in DKK and pay in SEK
 *      cannot be averaged, medianed or summed as one number — doing so is
 *      silently wrong (a 30 000 DKK salary is not "lower pay" than a 40 000
 *      SEK one in any meaningful sense). applyPayCurrencyScope keeps ONE
 *      currency (the org default when anyone is paid in it, else the largest
 *      group) and reports the rest as excluded, so the page can say so
 *      plainly. We deliberately do NOT convert currencies: an exchange rate
 *      is a modelling choice a pay-gap report must not make silently, and a
 *      per-legal-employer report (#2385 Phase 2) is the real fix for an org
 *      that spans several countries.
 *
 *   2. WHICH COUNTRY is the population in? That decides the number/date
 *      locale and which law text applies (a Danish entity must never be told
 *      about the Swedish Diskrimineringslagen). A population entirely inside
 *      one country's legal entities is that country; one spanning several
 *      uses the org's default (its headquarters), then the country the org's
 *      default currency implies, then SE — the app's historical default.
 *
 * Resolution chain for an employee's currency (mirrors currency.js's
 * resolveEffectiveCurrency, which now also uses the legal-entity slot):
 *   employee.CURRENCY -> their legal entity's currency -> org defaultCurrency -> "SEK".
 *
 * `ctx` (the "pay context") is built server-side from the org's legal
 * entities (functions/payContext.js) and handed to the client inside
 * getEmployeeDataAndSettings' settings as `settings.payContext`:
 *   { defaultCurrency, hqCountryCode, entities: { [legalEntityId]: { currency, countryCode } } }
 * It carries no employee data at all.
 *
 * PURE and DUAL-MODE (module.exports + window.PayCurrencyScope), VENDORED into
 * functions/vendor-calc/ for deploy packaging (sync-calc-vendor.js) — this is
 * the canonical source.
 */
(function () {
  "use strict";

  var CURRENCY_RE = /^[A-Z]{1,8}$/;
  var COUNTRY_RE = /^[A-Z]{2}$/;

  // A country's number/date formatting locale. Unknown -> sv-SE (the app's
  // historical default), never a throw.
  var COUNTRY_LOCALES = { SE: "sv-SE", DK: "da-DK", NO: "nb-NO", FI: "fi-FI", PL: "pl-PL" };
  var COUNTRY_TIMEZONES = { SE: "Europe/Stockholm", DK: "Europe/Copenhagen", NO: "Europe/Oslo", FI: "Europe/Helsinki", PL: "Europe/Warsaw" };
  var DEFAULT_LOCALE = "sv-SE";

  // Currencies used by exactly one of the countries above — the only ones
  // that safely imply a country for an org with no legal entities. EUR is
  // shared by many countries, so it implies nothing.
  var COUNTRY_BY_CURRENCY = { SEK: "SE", DKK: "DK", NOK: "NO", PLN: "PL" };

  function normalizeCurrency(c) {
    var s = typeof c === "string" ? c.trim().toUpperCase() : "";
    return CURRENCY_RE.test(s) ? s : "";
  }
  function normalizeCountry(c) {
    var s = typeof c === "string" ? c.trim().toUpperCase() : "";
    return COUNTRY_RE.test(s) ? s : "";
  }

  function entityOf(emp, ctx) {
    var id = emp && emp.legalEntityId;
    var entities = ctx && ctx.entities;
    return (id && entities && Object.prototype.hasOwnProperty.call(entities, id)) ? entities[id] : null;
  }

  function resolveEmployeePayCurrency(emp, ctx) {
    var own = normalizeCurrency(emp && emp.CURRENCY);
    if (own) return own;
    var ent = entityOf(emp, ctx);
    var entCur = normalizeCurrency(ent && ent.currency);
    if (entCur) return entCur;
    return normalizeCurrency(ctx && ctx.defaultCurrency) || "SEK";
  }

  // The org's own default country: its headquarters, else the country its
  // default currency implies. null when neither says anything.
  function orgCountryCode(ctx) {
    var hq = normalizeCountry(ctx && ctx.hqCountryCode);
    if (hq) return hq;
    return COUNTRY_BY_CURRENCY[normalizeCurrency(ctx && ctx.defaultCurrency)] || null;
  }

  // An employee's country: their legal entity's, else the org default.
  function resolveEmployeeCountry(emp, ctx) {
    var ent = entityOf(emp, ctx);
    return normalizeCountry(ent && ent.countryCode) || orgCountryCode(ctx);
  }

  function resolvePayCountry(employees, ctx) {
    var seen = {};
    var keys = [];
    (employees || []).forEach(function (e) {
      var cc = resolveEmployeeCountry(e, ctx);
      if (cc && !seen[cc]) { seen[cc] = true; keys.push(cc); }
    });
    if (keys.length === 1) return keys[0];
    return orgCountryCode(ctx) || "SE";
  }

  function buildPayCurrencyScope(employees, ctx) {
    var counts = {};
    (employees || []).forEach(function (e) {
      var c = resolveEmployeePayCurrency(e, ctx);
      counts[c] = (counts[c] || 0) + 1;
    });
    var codes = Object.keys(counts).sort();
    var def = normalizeCurrency(ctx && ctx.defaultCurrency) || "SEK";
    var currency;
    if (!codes.length || counts[def]) {
      currency = def;
    } else {
      // Largest group; a tie resolves alphabetically (codes are pre-sorted),
      // so the choice is stable across calls.
      currency = codes.reduce(function (best, c) { return counts[c] > counts[best] ? c : best; }, codes[0]);
    }
    var currencies = codes.map(function (c) { return { currency: c, count: counts[c] }; });
    var excluded = currencies.filter(function (x) { return x.currency !== currency; });
    return {
      currency: currency,
      mixed: codes.length > 1,
      currencies: currencies,
      excluded: excluded,
      excludedCount: excluded.reduce(function (n, x) { return n + x.count; }, 0)
    };
  }

  // The employees paid in the scope's currency (new array; input untouched),
  // plus the scope itself with the included population's country. The scope
  // is safe to return to a client or freeze into a snapshot: currency codes,
  // counts and a country code — never an employee.
  function applyPayCurrencyScope(employees, ctx) {
    var scope = buildPayCurrencyScope(employees, ctx);
    var included = (employees || []).filter(function (e) { return resolveEmployeePayCurrency(e, ctx) === scope.currency; });
    scope.countryCode = resolvePayCountry(included, ctx);
    return { employees: included, scope: scope };
  }

  // Re-applies a scope the server already chose (the browser's filter
  // recompute path) so the client keeps exactly the same population.
  function filterToScopeCurrency(employees, scope, ctx) {
    if (!scope || !scope.currency) return employees || [];
    return (employees || []).filter(function (e) { return resolveEmployeePayCurrency(e, ctx) === scope.currency; });
  }

  function localeForCountry(cc) {
    return COUNTRY_LOCALES[normalizeCountry(cc)] || DEFAULT_LOCALE;
  }
  function timezoneForCountry(cc) {
    return COUNTRY_TIMEZONES[normalizeCountry(cc)] || COUNTRY_TIMEZONES.SE;
  }

  // The locale's decimal separator, for CSV cells. Every supported locale
  // uses a comma; the cell delimiter is ';', so either is safe unquoted.
  function decimalSeparatorForCountry(cc) {
    try {
      var parts = new Intl.NumberFormat(localeForCountry(cc)).formatToParts(1.5);
      for (var i = 0; i < parts.length; i++) if (parts[i].type === "decimal") return parts[i].value;
    } catch (e) { /* fall through */ }
    return ",";
  }

  // ---- Law text by country (#2385 item 5) --------------------------------
  // "se" keeps today's Swedish text (also the default for an unknown country,
  // so nothing changes for an org that never configured one), "dk" gets
  // Ligelønsloven wording where #2385 confirms it, "eu" a neutral
  // EU-directive text for every other country.
  function resolveLawVariant(countryCode) {
    var cc = normalizeCountry(countryCode);
    if (!cc || cc === "SE") return "se";
    return cc === "DK" ? "dk" : "eu";
  }

  // The i18n key for a law-dependent text. `variants` says which suffixed keys
  // exist ({ dk: true, eu: true }); a missing one falls back DK -> _eu -> base.
  function lawTextKey(baseKey, countryCode, variants) {
    var v = resolveLawVariant(countryCode);
    var has = variants || {};
    if (v === "dk" && has.dk) return baseKey + "_dk";
    if (v !== "se" && has.eu) return baseKey + "_eu";
    return baseKey;
  }

  // Resolves a law-dependent text. `fallbacks` = { se, dk?, eu? } English
  // texts; their presence is also what says which variants exist. `T(key)`
  // returns the translation or the key itself when there is none.
  function lawText(T, baseKey, countryCode, fallbacks) {
    var fb = fallbacks || {};
    var key = lawTextKey(baseKey, countryCode, { dk: fb.dk != null, eu: fb.eu != null });
    var fallback = key === baseKey ? fb.se : (key === baseKey + "_dk" ? fb.dk : fb.eu);
    var v = typeof T === "function" ? T(key) : null;
    return (!v || v === key) ? fallback : v;
  }

  // The "these employees were left out" line for an aggregate whose
  // population spanned several currencies (#2385 item 2); "" when nothing was
  // excluded. `T` as in lawText.
  var MIXED_WARNING_FALLBACK = "{n} employee(s) paid in another currency ({list}) are left out: pay in different currencies cannot be averaged together. These figures cover employees paid in {currency} only.";
  function mixedCurrencyWarning(scope, T) {
    if (!scope || !scope.mixed || !(scope.excludedCount > 0)) return "";
    var v = typeof T === "function" ? T("pay_currency_mixed_warning") : null;
    var tpl = (!v || v === "pay_currency_mixed_warning") ? MIXED_WARNING_FALLBACK : v;
    var list = (scope.excluded || []).map(function (x) { return x.currency + " (" + x.count + ")"; }).join(", ");
    return tpl.replace("{n}", String(scope.excludedCount)).replace("{list}", list).replace("{currency}", String(scope.currency || ""));
  }

  var PayCurrencyScope = {
    resolveLawVariant: resolveLawVariant,
    lawTextKey: lawTextKey,
    lawText: lawText,
    mixedCurrencyWarning: mixedCurrencyWarning,
    COUNTRY_LOCALES: COUNTRY_LOCALES,
    COUNTRY_BY_CURRENCY: COUNTRY_BY_CURRENCY,
    normalizeCurrency: normalizeCurrency,
    normalizeCountry: normalizeCountry,
    resolveEmployeePayCurrency: resolveEmployeePayCurrency,
    resolveEmployeeCountry: resolveEmployeeCountry,
    orgCountryCode: orgCountryCode,
    resolvePayCountry: resolvePayCountry,
    buildPayCurrencyScope: buildPayCurrencyScope,
    applyPayCurrencyScope: applyPayCurrencyScope,
    filterToScopeCurrency: filterToScopeCurrency,
    localeForCountry: localeForCountry,
    timezoneForCountry: timezoneForCountry,
    decimalSeparatorForCountry: decimalSeparatorForCountry
  };

  if (typeof window !== "undefined") window.PayCurrencyScope = PayCurrencyScope;
  if (typeof module !== "undefined" && module.exports) module.exports = PayCurrencyScope;
})();

// Resolve the canonical predicate in whichever environment we're in: the
// browser loads classification-table.js alongside this file, Node requires it
// directly (it needs no `window` at load, unlike shared-utils.js).
const isIncludedInAnalysisShared = (typeof module !== 'undefined' && module.exports)
  ? require('./pay-equity-basis.js').isIncludedInAnalysis
  : function (e) { return window.isIncludedInAnalysis(e); };

// #2242 — the FTE normalisation every comparison in this file rests on. The
// browser loads pay-equity-basis.js before this file; Node require()s it.
const __basisCalc = (typeof module !== 'undefined' && module.exports)
  ? require('./pay-equity-basis.js')
  // `window` itself (resolved per call), like the other cores: a hand-listed
  // wrapper goes stale the moment a second shared rule is needed (#2460/#2462).
  : window;

// `options.redact` (#2504) — only an explicit `false` turns the disclosure
// gates below off (every figure shown, groups of 1-2 included). The SERVER
// decides it (getDashboardAnalysis via canSeeUnredactedPayAnalysis); the
// default — no options, or anything else — stays redacted.
function createCalculator(employeeData, settings, options) {
  const unredacted = !!(options && options.redact === false);
  // #2242 — compare full-time equivalents, not raw pay. Applied once here so
  // every aggregate below (gender means, group means, womensPayPercentage) is
  // on one basis; the caller's own rows are untouched and still carry the
  // actual paid salary.
  employeeData = __basisCalc.withFteNormalizedSalary(employeeData);
  // Defensive filter for active employees
  // #2243 — was an inline copy of the include-in-analysis rule. It now reads
  // the ONE canonical predicate (classification-table.js's
  // isIncludedInAnalysis) so an absent value means INCLUDED here too; five
  // independent copies of this rule is how an employee could be counted by one
  // surface and silently dropped by another.
  const activeEmployees = (employeeData || []).filter(isIncludedInAnalysisShared);

  const totalEmployees = activeEmployees.length;
  
  // #2462 — gender through THE shared reader (trimmed, case-insensitive,
  // importer aliases), never an exact `=== 'Female'`: "female" or " FEMALE "
  // must count here exactly as EU reporting counts it.
  const women = activeEmployees.filter(__basisCalc.isFemaleEmployee);
  const men = activeEmployees.filter(__basisCalc.isMaleEmployee);
  
  const numberOfWomen = women.length;
  const numberOfMen = men.length;

  const shareWomen = totalEmployees > 0 ? Math.round((numberOfWomen / totalEmployees) * 100) : 0;
  const shareMen = totalEmployees > 0 ? Math.round((numberOfMen / totalEmployees) * 100) : 0;

  const average = (arr) => {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  };

  const womenSalaries = women.map(w => parseFloat(w['BASE SALARY'])).filter(s => !isNaN(s) && s > 0);
  const menSalaries = men.map(m => parseFloat(m['BASE SALARY'])).filter(s => !isNaN(s) && s > 0);
  // Same s > 0 filter as women/menSalaries above (and group-insights.js/
  // individual-analysis.js's equivalent pay-gap calcs) — a 0/invalid BASE
  // SALARY (e.g. a leave-period overlay row) must not drag the group average
  // down; this used to only filter NaN, silently including real zeros.
  const allSalaries = activeEmployees.map(e => parseFloat(e['BASE SALARY'])).filter(s => !isNaN(s) && s > 0);

  // #2460 — THE shared threshold rule (pay-equity-basis.js): absent -> the
  // floor of 3, a stored 1 or 2 -> clamped UP to the floor. This used to be
  // `settings.minTeamSize || 3`, which let a stored 1 or 2 straight through
  // and published a 1-2 person group's average — the individual's salary.
  const minTeamSize = __basisCalc.resolveMinTeamSize(settings);
  // #2504 — what the pay-DISCLOSURE gates below compare against: the org's
  // threshold, or one person in the unredacted mode. femaleDominatedGroups
  // further down keeps `minTeamSize` — a classification, not a disclosure.
  const disclosureThreshold = __basisCalc.resolveMinTeamSize(settings, undefined, options);

  // k-anonymity gate (#1390): a gender group smaller than minTeamSize must
  // never expose its own average/min-max salary — in a group of 1-2 people
  // that figure IS (or nearly is) an individual's salary. Mirrors
  // deiMerge.js's redactPay/resolveAnonymityThreshold pattern already used
  // by the DEI dashboard and EU pay transparency: "gender-split figures are
  // only safe once EACH gender independently clears the threshold." This is
  // a DIFFERENT, unrelated threshold from femaleDominatedThreshold below
  // (that one gates group DOMINANCE classification, not pay disclosure) —
  // they happen to share the same minTeamSize SETTING, not the same check.
  // Redacted the SAME way an already-empty group renders today (average([])
  // = 0, salaryRange([]) = {min:'N/A',max:'N/A'}) — no new sentinel value,
  // so every existing consumer (analysis-dashboard.js etc.) already handles
  // this "no data" shape correctly with zero UI changes.
  //
  // #2344 — every gate below counts the people the figure is actually
  // computed OVER (a usable salary > 0), never raw heads. The averages only
  // ever see womenSalaries/menSalaries/allSalaries, so "5 women" of whom 4
  // have a 0/blank salary is a population of ONE for disclosure purposes, and
  // gating on the headcount of 5 published that one woman's exact pay.
  // payEquitySnapshot.js's roleSalaryGenderCounts made the same fix for the
  // snapshot's role table.
  const numberOfWomenWithSalary = womenSalaries.length;
  const numberOfMenWithSalary = menSalaries.length;
  const numberWithSalary = allSalaries.length;
  const womenPayShown = numberOfWomenWithSalary >= disclosureThreshold;
  const menPayShown = numberOfMenWithSalary >= disclosureThreshold;
  const genderPaySafe = womenPayShown && menPayShown;

  // #2341 — the GROUP figures are gated too. Two ways they leak:
  //   1. the group itself is below the threshold (a single-employee node
  //      exposes min = max = avg = that person's salary);
  //   2. SUBTRACTION: whenever some shown gender averages can be subtracted
  //      from the group total, what is left over is the average of everyone
  //      NOT shown. 1 woman + 5 men with men shown -> her salary =
  //      6 x groupAvg - 5 x menAvg. The same arithmetic isolates a lone
  //      unknown-gender employee when both genders are shown. So the group
  //      figure is only safe when that residual is empty or itself clears the
  //      threshold. (Both genders hidden = nothing to subtract = residual is
  //      the whole group, which already cleared the threshold in 1.)
  // Redacted exactly like an empty group renders (average 0, range N/A), for
  // the same reason as the gender gate above: no new sentinel for consumers.
  const residualWithSalary = numberWithSalary
    - (womenPayShown ? numberOfWomenWithSalary : 0)
    - (menPayShown ? numberOfMenWithSalary : 0);
  const groupPaySafe = numberWithSalary >= disclosureThreshold
    && (residualWithSalary === 0 || residualWithSalary >= disclosureThreshold);
  // WHY the group figure is hidden, so the Overview can explain it without
  // re-deriving the rule above: "empty" = nobody with a salary (not an
  // anonymity case), "belowThreshold" = rule 1, "residual" = rule 2.
  let groupPayRedactedReason = null;
  if (!groupPaySafe) {
    if (numberWithSalary === 0) groupPayRedactedReason = 'empty';
    else if (numberWithSalary < disclosureThreshold) groupPayRedactedReason = 'belowThreshold';
    else groupPayRedactedReason = 'residual';
  }

  const averageSalaryWomen = womenPayShown ? average(womenSalaries) : 0;
  const averageSalaryMen = menPayShown ? average(menSalaries) : 0;
  const averageSalaryGroup = groupPaySafe ? average(allSalaries) : 0;

  // womensPayPercentage is a RATIO derived from both gender averages — if
  // either gender is below the threshold, showing this ratio at all would
  // let a caller back-derive the redacted small group's average from the
  // OTHER (larger, safe-to-show) gender's real average, so it's redacted
  // together with them rather than computed from the raw (unredacted)
  // averages below.
  let womensPayPercentage;
  if (!genderPaySafe) {
    womensPayPercentage = 'N/A';
  } else if (averageSalaryMen > 0) {
    // Bug hunt 7A #12 — one decimal: a whole-number rounding showed a 4.6 %
    // gap as "95 %" / "5" next to "not flagged" (flagging reads the unrounded
    // figures, #2345).
    womensPayPercentage = Math.round((averageSalaryWomen / averageSalaryMen) * 1000) / 10;
  } else {
    if (averageSalaryWomen > 0) {
      // Men earn 0, women earn > 0: Undefined gap
      womensPayPercentage = 'N/A';
    } else {
      // Both earn 0: Perfect equality
      womensPayPercentage = 100;
    }
  }

  // #2493 — 0-1 share, whichever scale settings/global stored it in.
  const femaleDominatedThreshold = __basisCalc.resolveSystemParameters(settings).femaleDominatedThreshold;

  // Bug hunt 7A #12 — THE female-dominated rule (pay-equity-basis.js
  // countFemaleDominance / isFemaleDominated): headcount WITH a salary in the
  // group, the same people the pay figures are computed over.
  const groupRows = {};
  activeEmployees.forEach(e => {
    const groupName = e['EQUAL WORK GROUP'];
    if (!groupName) return;
    (groupRows[groupName] = groupRows[groupName] || []).push(e);
  });

  let femaleDominatedGroupsCount = 0;
  for (const groupName in groupRows) {
    const group = __basisCalc.countFemaleDominance(groupRows[groupName]);
    if (group.total >= minTeamSize && __basisCalc.isFemaleDominated(group.women, group.total, femaleDominatedThreshold)) {
      femaleDominatedGroupsCount++;
    }
  }

  const salaryRange = (salaries) => {
      if (salaries.length === 0) return { min: 'N/A', max: 'N/A' };
      return { min: Math.min(...salaries), max: Math.max(...salaries) };
  }

  return {
    totalEmployees,
    totalRoles: new Set(activeEmployees.map(e => e['ROLE'])).size,
    totalEqualWorkGroups: new Set(activeEmployees.map(e => e['EQUAL WORK GROUP'])).size,
    // #1723: distinct LEVEL count — was missing entirely; metric-equivalent-levels
    // used to just re-display totalEqualWorkGroups instead of its own value.
    totalLevels: new Set(activeEmployees.map(e => e['LEVEL'])).size,
    femaleDominatedGroups: femaleDominatedGroupsCount,
    shareWomen,
    shareMen,
    womensPayPercentage,
    numberOfWomen,
    numberOfMen,
    numberOfUnknownGender: totalEmployees - numberOfWomen - numberOfMen,
    // #2344 — the populations the salary figures are computed over, so a
    // downstream gate (deiMerge.js's redactPay) can count the same thing.
    numberOfWomenWithSalary,
    numberOfMenWithSalary,
    numberWithSalary,
    averageSalaryWomen,
    averageSalaryMen,
    averageSalaryGroup,
    // #2341 — lets a consumer tell "redacted" from a real figure without
    // re-deriving the rule (averageSalaryGroup is 0 either way).
    groupPayRedacted: !groupPaySafe,
    groupPayRedactedReason,
    // The disclosure threshold every *Redacted flag above was gated on.
    anonymityThreshold: disclosureThreshold,
    // #2504 — true only when the caller's figures were computed with the
    // disclosure gates off (see `options.redact` above).
    unredacted,
    // Same purpose per gender: a population that exists but is below the
    // threshold. An EMPTY population is not "redacted" — there's nothing to hide.
    womenPayRedacted: numberOfWomenWithSalary > 0 && !womenPayShown,
    menPayRedacted: numberOfMenWithSalary > 0 && !menPayShown,
    // Bug hunt 7B (P1) — a range's min/max ARE two individuals' exact
    // salaries, so they are only returned in the explicit unredacted mode
    // (options.redact === false, granted by canSeeUnredactedPayAnalysis).
    // Every other caller (REST, AI dashboard widget, a redacted Overview)
    // gets the {min:'N/A',max:'N/A'} sentinel, even above the floor.
    salaryRangeWomen: salaryRange(unredacted && womenPayShown ? womenSalaries : []),
    salaryRangeMen: salaryRange(unredacted && menPayShown ? menSalaries : []),
    salaryRangeGroup: salaryRange(unredacted && groupPaySafe ? allSalaries : [])
  };
}

// Node/test interop only. In the browser `module` is undefined so this is skipped
// and createCalculator remains a plain global loaded via <script>.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createCalculator };
}

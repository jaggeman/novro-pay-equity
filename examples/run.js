"use strict";

const employees = require("./synthetic-company.json");
const Novro = require("../src");

const overview = Novro.analyzePayEquity(employees, {
  minTeamSize: 3,
  payBasis: "baseSalaryAndAllowances",
  payGapThreshold: 5
});

const revision = Novro.salaryRevision.computeRevisionSimulation(employees, [
  { valueType: "percentage", value: 3, scope: "All", gender: "All" }
]);

const quartiles = Novro.euReporting.buildPayQuartiles(employees, { minTeamSize: 3 });

console.log(JSON.stringify({
  overview: {
    totalEmployees: overview.totalEmployees,
    womensPayPercentage: overview.womensPayPercentage,
    averageSalaryWomen: overview.averageSalaryWomen,
    averageSalaryMen: overview.averageSalaryMen,
    anonymityThreshold: overview.anonymityThreshold
  },
  revision: {
    affectedCount: revision.affectedCount,
    annualSalaryIncrease: revision.budget.annual
  },
  euPayQuartiles: quartiles
}, null, 2));

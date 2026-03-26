/**
 * Capacity Planning — Investment ROI Calculator
 *
 * Evaluates investment scenarios with payback period, NPV, ROI %,
 * break-even utilization, and cost per additional unit.
 */

import type { ROIInput, ROIResult } from './models.js';
import { DEFAULT_DISCOUNT_RATE, DEFAULT_ANALYSIS_MONTHS } from './models.js';

/**
 * Calculate ROI for a capacity investment scenario.
 */
export function calculateROI(input: ROIInput): ROIResult {
  const discountRate = input.discount_rate ?? DEFAULT_DISCOUNT_RATE;
  const months = input.analysis_months ?? DEFAULT_ANALYSIS_MONTHS;
  const monthlyOpCost = input.monthly_operating_cost ?? 0;
  const revenuePerUnit = input.revenue_per_unit ?? 0;
  const unitsPerHour = input.units_per_hour ?? 1;

  // Additional capacity in units per month
  // Assume ~22 working days, 8 hours per day as baseline
  const additionalUnitsPerMonth = input.capacity_gain_hours * unitsPerHour;

  // Revenue from additional units
  const additionalRevenuePerMonth = additionalUnitsPerMonth * revenuePerUnit;

  // Monthly net benefit
  const monthlyNetBenefit = additionalRevenuePerMonth - monthlyOpCost;

  // Payback period (months)
  const paybackMonths = monthlyNetBenefit > 0
    ? input.investment_cost / monthlyNetBenefit
    : Infinity;

  // NPV calculation
  const monthlyDiscount = discountRate / 12;
  let npv = -input.investment_cost;
  for (let m = 1; m <= months; m++) {
    npv += monthlyNetBenefit / Math.pow(1 + monthlyDiscount, m);
  }

  // ROI %
  const totalBenefit = monthlyNetBenefit * months;
  const roiPct = input.investment_cost > 0
    ? ((totalBenefit - input.investment_cost) / input.investment_cost) * 100
    : 0;

  // IRR (Internal Rate of Return) — Newton's method approximation
  const irrPct = computeIRR(input.investment_cost, monthlyNetBenefit, months);

  // Break-even utilization: what % of capacity must be used to cover costs
  const totalMonthlyCost = monthlyOpCost + (input.investment_cost / months);
  const maxRevenuePerMonth = input.capacity_gain_hours * unitsPerHour * revenuePerUnit;
  const breakEvenUtilizationPct = maxRevenuePerMonth > 0
    ? (totalMonthlyCost / maxRevenuePerMonth) * 100
    : 100;

  // Cost per additional unit
  const totalCost = input.investment_cost + monthlyOpCost * months;
  const totalUnits = additionalUnitsPerMonth * months;
  const costPerAdditionalUnit = totalUnits > 0 ? totalCost / totalUnits : Infinity;

  // Recommendation
  const recommendation = generateROIRecommendation(
    paybackMonths,
    npv,
    roiPct,
    breakEvenUtilizationPct,
  );

  return {
    scenario_name: input.scenario_name,
    investment_cost: input.investment_cost,
    monthly_operating_cost: monthlyOpCost,
    capacity_gain_hours: input.capacity_gain_hours,
    additional_units_per_month: round2(additionalUnitsPerMonth),
    additional_revenue_per_month: round2(additionalRevenuePerMonth),
    monthly_net_benefit: round2(monthlyNetBenefit),
    payback_months: round2(paybackMonths),
    npv: round2(npv),
    roi_pct: round2(roiPct),
    irr_pct: irrPct !== null ? round2(irrPct) : null,
    break_even_utilization_pct: round2(Math.min(100, breakEvenUtilizationPct)),
    cost_per_additional_unit: round2(costPerAdditionalUnit),
    recommendation,
  };
}

/**
 * Compare multiple ROI scenarios and rank by NPV.
 */
export function compareROIs(inputs: ROIInput[]): ROIResult[] {
  return inputs
    .map((i) => calculateROI(i))
    .sort((a, b) => b.npv - a.npv);
}

// ── IRR Computation ──────────────────────────────────────────

function computeIRR(
  investment: number,
  monthlyCashFlow: number,
  months: number,
): number | null {
  if (monthlyCashFlow <= 0 || investment <= 0) return null;

  // Newton's method to find rate where NPV = 0
  let rate = 0.01; // initial guess: 1% monthly
  for (let iter = 0; iter < 100; iter++) {
    let npv = -investment;
    let dnpv = 0; // derivative

    for (let m = 1; m <= months; m++) {
      const pv = monthlyCashFlow / Math.pow(1 + rate, m);
      npv += pv;
      dnpv -= m * monthlyCashFlow / Math.pow(1 + rate, m + 1);
    }

    if (Math.abs(npv) < 0.01) {
      return rate * 12 * 100; // Convert monthly rate to annual %
    }

    if (Math.abs(dnpv) < 1e-10) break;
    rate -= npv / dnpv;

    if (rate <= -1 || rate > 10) break; // Guard against divergence
  }

  return null;
}

// ── Recommendation Generation ────────────────────────────────

function generateROIRecommendation(
  payback: number,
  npv: number,
  roi: number,
  breakEven: number,
): string {
  const parts: string[] = [];

  if (payback <= 6) {
    parts.push('Excellent payback period (≤6 months).');
  } else if (payback <= 12) {
    parts.push('Good payback period (≤12 months).');
  } else if (payback <= 24) {
    parts.push('Moderate payback period (≤24 months).');
  } else if (payback === Infinity) {
    parts.push('Investment does not pay back within analysis horizon.');
  } else {
    parts.push(`Long payback period (${Math.round(payback)} months).`);
  }

  if (npv > 0) {
    parts.push(`Positive NPV ($${Math.round(npv).toLocaleString()}) — value-creating investment.`);
  } else {
    parts.push(`Negative NPV ($${Math.round(npv).toLocaleString()}) — consider alternatives.`);
  }

  if (breakEven < 50) {
    parts.push('Low break-even threshold — robust even at low utilization.');
  } else if (breakEven > 80) {
    parts.push('High break-even threshold — requires high utilization to justify.');
  }

  return parts.join(' ');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

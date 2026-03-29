# Finance & Accounting Domain Pack

Financial analysis tools for investment evaluation and budget management.

## Tools

- `calculate_npv` — Net Present Value with IRR and payback period analysis
- `budget_variance` — Compare actual vs budgeted spend with overrun detection

## Skills

- `financial_analyst` — Expert financial analyst persona

## Templates

- `budget-template.csv` — Example budget data with 14 line items across 5 departments

## Getting Started

1. This pack is pre-installed as an example
2. Verify: `/pack info finance`
3. Test NPV: "Calculate NPV with 8% discount rate, $200,000 investment, cash flows of 50000, 60000, 70000, 80000, 90000"
4. Test budget: Send the budget template CSV and ask "Analyze the budget variance"

## Customizing

- Edit `pack.yaml` to add financial terminology or adjust intent patterns
- Add new tools in `tools/` (e.g., `forecast-revenue.md`, `roi-calculator.md`)
- Modify the analyst skill in `skills/financial-analyst.md`

See `docs/customization-guide.md` for the complete guide.

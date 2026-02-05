# Code Consistency Checklist

Run these checks before committing:

## 1. Data Flow Verification

### API → Storage → UI

- [ ] Fields in `StockData` interface match what API returns
- [ ] Fields in `Stock` type match what storage saves
- [ ] UI components access fields that exist in `Stock` type
- [ ] All `updateStock()` calls include all new fields

## 2. Documentation vs Implementation

### Quality Score Example:

- Tooltip says: "Based on EPS, profit margin, operating margin, ROE, and P/E ratio"
- Check:
  - [ ] `calculateQualityScore()` uses all 5 metrics
  - [ ] API fetches all 5 metrics
  - [ ] Storage saves all 5 metrics
  - [ ] UI displays all 5 metrics

## 3. TypeScript Type Safety

Run: `npm run build` or `tsc --noEmit`

- [ ] No TypeScript errors
- [ ] No unused variables
- [ ] All types match across files

## 4. Local Testing

- [ ] Dev server running: `npm run dev`
- [ ] Feature works in browser
- [ ] Console shows no errors
- [ ] All edge cases handled (null, undefined, missing data)

## 5. Common Gotchas

- [ ] Check which API file is actually imported (`stockApi.ts` vs `stockApiEdge.ts`)
- [ ] Verify conditional rendering logic (&&, ||, ternary)
- [ ] Check for stale data in localStorage (may need to refresh stocks)
- [ ] Verify tooltip/help text matches actual implementation

## Quick Commands

```bash
# Type check
cd app && npm run build

# Search for inconsistencies
grep -r "Based on" app/src  # Find documentation claims
grep -r "calculateQuality" app/src  # Find implementation

# Check which API is used
grep "import.*stockApi" app/src/App.tsx
```

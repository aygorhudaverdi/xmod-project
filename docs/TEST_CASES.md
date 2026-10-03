# Test cases: expected losses and Table II (E-series)

Manual and automated test cases for **Expected Losses (E) and the Table II primary threshold lookup**.
Each case lists where it is automated and, where one exists, the **on-screen route** a tester can follow by hand.
X-Mod Lab is a practice project built from the California Experience Rating Plan effective Sept 1, 2025.
**It is not an official WCIRB tool.**

On-screen routes:
- **Calculator:** *Calculator* tab → enter payroll → *Calculate X-Mod*.
- **Reference:** *Reference tables* tab → *Total expected losses ($)* box. The threshold shows below the box, and the
  matching Table II row is highlighted and scrolled into view.
- **Calculator → Reference:** after *Calculate X-Mod*, click the **Primary Threshold** figure. The *Reference tables*
  tab opens on the band the calculation used.

| ID | Case | Input | Expected | On-screen route | Automated in |
|---|---|---|---|---|---|
| E-01 | Reference risk | Class 0005, payroll $1,000,000 | E = 20,200.00, PT 8,500, mod 0.77 | Calculator; then Calculator → Reference highlights 19,924–22,270 | `tests/unit/xmod.test.ts` › `matches the hand-computed reference risk`; `tests/ui/calculator.spec.ts` › `US-01 calculates the reference risk` |
| E-02 | Per-capita class is not divided by 100 | Class 7707, 100 units | E = 12,650.00, PT 6,500 | Calculator (*Per-capita class 7707* sample) | `tests/unit/xmod.test.ts` › `per-capita classes are not divided by 100`; `tests/ui/worksheet.spec.ts` › `sample "Per-capita class 7707"` |
| E-03 | Several classes add up | 0005 $500,000 + 3634 $500,000 | E = 10,100 + 6,000 = 16,100.00 | Calculator | `tests/unit/xmod.test.ts` › `sums multiple classes` |
| E-04 | Eligibility threshold boundary | 3634 at $900,000 / $899,999 | E = 10,800 → eligible; one dollar of payroll less → not eligible | Calculator | `tests/unit/xmod.test.ts` › `eligibility threshold boundary`; `tests/api/xmod.api.spec.ts` › `US-05 eligibility` |
| E-05 | First band edge | E = 7,248 / 7,249 | PT 4,500 / 5,000; the highlight moves to the next row | **Reference** (type 7248, then 7249) | `tests/api/table2.api.spec.ts` › `E-05 …`; `tests/ui/reference.spec.ts` › `E-05 typing 7248 then 7249 moves the highlight` |
| E-06 | Reference risk's band edge | E = 19,923 / 19,924 | PT 8,000 / 8,500 | **Reference** | `tests/api/table2.api.spec.ts` › `E-06 …`; `tests/unit/xmod.test.ts` › `Table II: E=%i -> PT %i` |
| E-07 | $9,500 → $10,000 edge | E = 27,391 / 27,392 | PT 9,500 / 10,000 | **Reference** | `tests/api/table2.api.spec.ts` › `E-07 …`; `tests/unit/xmod.test.ts` › `Table II: E=%i -> PT %i` |
| E-08 | Last band, "and over" | E = 3,293,539 / 3,293,540 | PT 74,000 / 75,000; the last row reads "and over" | **Reference** | `tests/api/table2.api.spec.ts` › `E-08 …`; `tests/ui/reference.spec.ts` › `at 375 px the table scrolls inside its container` |
| E-09 | E is rounded to whole dollars before the lookup (assumption) | E = 47,636.59 | Rounded 47,637 → band 46,360–50,076 → PT 13,000 | **Reference** (type 47636.59) | `tests/api/table2.api.spec.ts` › `E-09 …`; `tests/ui/reference.spec.ts` › `E-09 typing 47636.59 highlights …` |
| E-10 | Invalid expected losses | -1, "abc", missing | API: 422 `BAD_EXPECTED` in the standard error shape. Screen: inline message under the box, no highlight, no dialog | **Reference** (type abc or -1) | `tests/api/table2.api.spec.ts` › `E-10 …`; `tests/ui/reference.spec.ts` › `E-10 invalid input shows an inline message …` |

**E-05..E-10** previously ran only against the API and engine. The *Reference tables* tab gives each of them a
manual route, so a tester can repeat them without tools. The Calculator → Reference link adds a check across the
two tabs: the band highlighted is always the one the calculation used (`tests/ui/reference.spec.ts` ›
`the Calculator's Primary Threshold link opens the tab on the band it used`; `tests/api/table2.api.spec.ts` ›
`lookup agrees with the threshold the calculator uses`).

## Notes for manual testing
- The lookup box accepts `$` and thousands separators (`$1,000` works). Anything else non-numeric shows the inline message.
- Rounding is half-up: 7,248.49 → 4,500 and 7,248.50 → 5,000 (automated in `tests/api/table2.api.spec.ts`).
- Lookups are debounced by about 200 ms. Type, pause, and the highlight follows.
- The Calculator → Reference link highlights the band of the engine's own threshold rather than looking it up again
  from the rounded E on screen. That avoids a double-rounding difference at a band edge when E has fractional cents.

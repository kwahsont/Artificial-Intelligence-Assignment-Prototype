# 🍛 UTP Cafeteria Batch Advisor

**An AI batch-cooking advisor that helps UTP cafeteria vendors cut food waste and kitchen energy use.**

TEB2023 Artificial Intelligence · Group 13 · Universiti Teknologi PETRONAS · *AI Solutions for Sustainable Energy and Industry*
Supports **SDG 12** (Responsible Consumption & Production) and **SDG 7** (Affordable & Clean Energy).

> ⚠️ **Simulated prototype.** Predictions are estimates derived from a survey of 56 UTP students (Nov 2026), not from real sales records. The vendor always makes the final decision.

---

## The problem

Cafeteria vendors at UTP decide how much to cook from routine and guesswork. When fewer students turn up (heavy rain, exam weeks, public holidays), the surplus is thrown away at closing. The gas used to cook it is wasted too, and food warmers and exhaust hoods keep running through quiet afternoons.

## The solution

The vendor picks a **date** and a **time of day** on a slider, and enters their **usual batch size**. The slider shows coloured meal-period bands (☕ breakfast 7:00–10:30 · 🍛 lunch 11:00–15:00 · 🫖 tea 15:00–17:00 · 🌙 dinner 17:00–21:00 · 🌃 supper 21:00–23:00) and a weather icon for every hour. In **live mode** the dashboard fills in the rest automatically:

- **Hourly weather:** the live [Open-Meteo](https://open-meteo.com/) forecast for UTP, for the exact hour you pick, up to 16 days ahead. Heavy rain means at least 1 mm in that hour or a rain chance of at least 75%. Haze means PM2.5 of at least 35 µg/m³ (air-quality forecast, about 5 days ahead).
- **Auto-refresh:** the forecast is fetched again every 10 minutes (or on demand with ↻ Refresh). The slider follows the clock until you drag it. If a refresh changes the weather for an hour, a "Forecast changed" alert says what changed and how the risk moved.
- **24-hour chart:** forecast rain per hour (bars) plotted against expected demand at each hour (line, coloured by risk tier).
- **Academic calendar:** UTP lecture weeks, blended-learning and no-class weeks, study break, exams, semester break and public holidays, from [`docs/data/academic_calendar.js`](docs/data/academic_calendar.js).
- **Public holidays, pulled automatically:** [`src/update_holidays.py`](src/update_holidays.py) pulls Malaysian federal + Perak state public holidays (including replacement days and the Sultan of Perak's birthday) from the open-source [`holidays`](https://github.com/vacanza/holidays) library into [`docs/data/public_holidays.js`](docs/data/public_holidays.js). A GitHub Action ([`.github/workflows/update-holidays.yml`](.github/workflows/update-holidays.yml)) reruns it every Monday and commits any change. The dashboard merges this list with the holidays printed in the UTP calendar.
- **Detected automatically:** the left panel shows the day, calendar period and forecast it detected for the chosen hour, each with its effect on footfall. The manual calendar and weather buttons are folded away under **What-if overrides**.
- **Automatic forecast & calendar analysis:** for the chosen day, each meal's rain/haze hours, rain total and chance, PM2.5, and expected demand range with the worst-hour risk tier. Below that, "What's coming up": the next calendar change (e.g. study break in 9 days), the next public holiday, rain and haze over the next 7 days, the riskiest lunch or dinner of the week, and the forecast horizon.
- **Date picker:** a week strip (‹ week › with 7 day buttons showing the date, hourly weather and a coloured academic-calendar marker) plus a 📅 month calendar grouped into week rows labelled with the UTP lecture week (W8, W9…) or Study / Exam / Break. The day of the week comes from the date.

Lunch and dinner use the survey directly. Within lunch, the survey's lunch-time answers (Q5) show how busy each half-hour is. Breakfast, tea and supper weren't surveyed, so they use dinner-style rules and are labelled that way.

Any live value can be overridden by hand under What-if overrides, or live mode can be switched off to test what-if scenarios. The dashboard returns:

| Output | Example (Friday lunch, heavy rain, usual batch 120) |
|---|---|
| Surplus-waste risk tier + AI confidence | **High** risk · 100% confidence |
| Expected demand vs a normal weekday | 33% |
| Recommended portions (range) | **40** (36 – 44) |
| Cooking & energy plan | 24 portions first → small top-ups → switch off unused warmers after 2:30 PM |
| Estimated savings | 80 portions · 28 kg food · ≈ 35 kWh |
| Explanation | Survey factors applied + the decision-tree path |
| Next 7 days | Live forecast + calendar risk tier for each upcoming day, at the selected time |

The dashboard has five tabs: **Daily advisor**, **Survey insights** (all survey charts), **Model & method** (accuracy, confusion matrix, feature importance, fuzzy rule base, test scenarios, assumptions, limitations), **Engine console** (live trace + training replay) and **📖 Guide**, which explains every part of the dashboard (what it tells you, how to read it, and a "Show me →" button that jumps to it), with a glossary and a 2-minute demo script. Every card also has a small **?** button that opens its section of the guide. A ☀️/🌙 switch in the header toggles **light and dark mode**, and the choice is remembered in your browser.

### Live calculation (animated)

A "machine" card on the Daily advisor tab (with a compact copy on the Engine console tab) shows the calculation as it happens:

- **Four dials**: rain (mm/h), PM2.5, day demand and time of day. Each needle swings to the current value, and the coloured arcs mark the fuzzy sets (e.g. Dry / Light / Heavy) with the current zone named underneath.
- **Data pipes**: dots travel from the dials into the engines, and burst whenever an input changes.
- **Engines**: the decision tree's yes/no questions light up one by one, ending in a tier badge. The fuzzy output shape morphs, and its centroid line slides to the new score.
- **Formula strip** with rolling numbers: *usual batch × expected demand = portions to cook*, then food (kg) and energy (kWh) saved.
- **Cooking pot**: fills to the recommended share of the usual batch, which is marked by a dashed line.
- **▶ Auto-play the day**: sweeps from 7 AM to 11 PM at one hour per second (0.5×, 1× or 2× speed) using the live hourly forecast. Dragging the time slider takes back control.

The panel respects the system "reduce motion" setting: numbers update without animation.

## How it works

```
Student survey (n=56) ─► Demand multipliers ─► Simulated service history ─► Decision tree ─┐
                                     └──────────► Mamdani fuzzy rules (27) ─────────────────────┤
   16 questions            Likert → probability     252 scenarios × 20 days       Low/Med/High  │
                                                                                                ├─► Vendor advice
Live inputs: Open-Meteo weather + air quality, UTP academic calendar, Perak holidays ───────────┘   batch, plan, energy
```

1. **Survey → multipliers** (`src/analyze_survey.py`). Likert answers are scored 0 / 0.25 / 0.5 / 0.75 / 1. Each condition is compared with a normal-weekday baseline: days per week at the cafeteria (capped at 5) ÷ 5 = 0.72.

   | Condition | Multiplier |
   |---|---|
   | Exam week | ×0.82 |
   | Friday | ×0.74 |
   | Hazy day | ×0.66 |
   | Weekend | ×0.65 |
   | Short class breaks (lunch) | ×0.59 |
   | **Heavy rain** | **×0.45** |
   | **Public holiday / break** | **×0.23** |

2. **Simulated dataset** (`src/build_dataset.py`). All 252 combinations of day type, calendar, weather, short breaks and meal are run for 20 simulated days each, with ±5% day-to-day noise. That gives 5,040 rows. Each day is labelled Low (≥ 80% of normal demand), Medium (55–80%) or High (< 55%) surplus-waste risk.
3. **Decision tree** (`src/train_model.py`). A scikit-learn `DecisionTreeClassifier` (depth 8) is trained on 75% of the rows and tested on the other 25%. The tree is exported to JSON, and the dashboard walks the same tree in the browser. The browser therefore gives exactly the same prediction as Python, and it can show the decision path.

4. **Mamdani fuzzy inference system** (`src/fuzzy_model.py`). This is a second AI technique (Lecture 8: Fuzzy Logic). The decision tree uses yes/no inputs, so 1.0 mm of rain counts as "heavy" but 0.9 mm counts as "clear". The fuzzy system instead reasons with the live **numbers**:
   - **Inputs:** day demand % (day + calendar + class breaks), rain mm/h and PM2.5 µg/m³, each with three fuzzy sets (e.g. rain *Dry / Light / Heavy*).
   - **27 IF–THEN rules** derived from the survey, e.g. *IF day demand is High AND rain is Heavy AND air is Good THEN risk is High*. Light rain and moderate air are assumed to sit halfway between "none" and the surveyed heavy-rain and haze effects.
   - **Pipeline:** fuzzification → rule evaluation (AND = min) → implication (clip) → aggregation (max) → **centroid** defuzzification. The output is a waste-risk score from 0 to 100, which gives expected demand and then a smooth batch size.
   - **Results:** the same risk tier as the crisp survey rule in **90.5%** of the 252 scenarios, with an average demand difference of 3.2 percentage points. The differences come where fuzzy logic gives a softer answer near a boundary.
   - **Why Mamdani and not Sugeno:** the rules come from human (survey) knowledge rather than large historical data, and Mamdani's readable rules and graphical output are easier for vendors to trust. Sugeno/ANFIS is proposed as future work once real sales data exists.

   On the dashboard, the **Fuzzy logic view** card animates live: membership curves with the current values, the rules firing and their strengths, and the aggregated output with its centroid. A toggle chooses whether the batch size comes from **fuzzy logic** (the default) or the **survey formula**. The headline risk tier still comes from the decision tree.

### Engine console (see what the AI is doing)

Open the **Engine console** tab for a "backend view" of the AI. It shows what is being traced right now and has its own time slider, so you can drag through the day and watch both engines react. Every run from the other tabs is logged here too:

- **Live trace:** every time you change the date, time, weather or batch, the console logs each step of the prediction:
  1. **API:** the forecast values for that hour.
  2. **CAL:** the academic-calendar lookup.
  3. **RULE:** the crisp weather rule.
  4. **ENCODE:** the 8-number feature vector.
  5. **TREE:** each decision-tree node visited, with its samples and Gini impurity, then the leaf's class probabilities.
  6. **FUZZY:** fuzzification, each rule's firing strength (min), aggregation and the centroid.
  7. **ADVICE:** the final batch calculation.
  8. **TIME:** how long each engine took.

  Forecast refreshes and changes are logged too.
- **Pipeline view:** six stages (data sources → calendar → feature encoding → decision tree → fuzzy engine → advice) light up in order on every run.
- **▶ Replay training:** regrows the CART decision tree (Gini impurity, max depth 8, min 5 samples per leaf) **in the browser**, on the same 3,780 training days and the same 75/25 split as Python. It streams every split with its impurity gain, then scores the 1,260 test days: **93.8%, identical to the scikit-learn model**.

The dashboard keeps using the exported scikit-learn model. The replay shows *how* that model was learned.

### Results

- **Test accuracy:** 93.8% on held-out simulated days.
- **Agreement with the survey rule:** 100% across all 252 scenarios.
- **Most important factors:** heavy rain, public holiday, exam week.

| Test scenario | Demand | AI risk | Confidence |
|---|---|---|---|
| Normal Monday | 100% | Low | 100% |
| Normal Friday | 74% | Medium | 100% |
| Rainy Tuesday | 45% | High | 100% |
| Exam-week Wednesday | 82% | Low | 58% |
| Public holiday | 23% | High | 100% |
| Rainy Friday | 33% | High | 100% |
| Hazy exam-week Monday (dinner) | 54% | High | 53% |
| Tuesday with short class breaks | 59% | Medium | 82% |

The low-confidence cases sit close to a tier boundary. The dashboard shows that uncertainty to the vendor instead of hiding it.

<p align="center">
  <img src="outputs/figures/01_demand_multipliers.png" width="48%">
  <img src="outputs/figures/03_likelihood_by_condition.png" width="48%">
</p>

## Run it

**Just view the dashboard.** Open `docs/index.html` in a browser. It needs internet access for live weather, the charts and the fonts. If you're offline, set the weather by hand.

**Academic calendar.** `docs/data/academic_calendar.js` holds the official **UTP Academic Calendars 2026 and 2027** for Foundation, Undergraduate and MSc taught courses: every semester from Jan 2026 to Sept 2027, orientation weeks, blended-learning and "no physical class on campus" weeks, and public holidays. When UTP publishes a new calendar, add its periods to this file.

**Refresh public holidays by hand** (the GitHub Action does this weekly):

```bash
python src/update_holidays.py
```

**Rebuild the data and model:**

```bash
pip install -r requirements.txt
```

```bash
python src/run_all.py
```

This regenerates `data/survey_responses.csv`, `data/scenario_dataset.csv`, everything in `outputs/`, and `docs/data/dashboard_data.js`. To change an assumption (thresholds, demand floor, noise, tree depth), edit `src/config.py` and re-run.

## Project structure

```
data/
  raw/survey_export.csv         Microsoft Forms export (anonymous)
  survey_responses.csv          cleaned survey
  scenario_dataset.csv          simulated training data (5,040 rows)
src/
  config.py                     paths, scoring rules, thresholds, model settings
  analyze_survey.py             step 1: survey -> multipliers + report charts
  build_dataset.py              step 2: multipliers -> simulated labelled dataset
  fuzzy_model.py                step 3: Mamdani fuzzy inference system (rules, figures, export)
  train_model.py                step 4: decision tree, evaluation, dashboard export
  run_all.py                    runs all four steps
  update_holidays.py            pulls Perak public holidays into the dashboard
outputs/
  figures/                      PNG charts for the report (01-11, 09-11 = fuzzy logic)
  fuzzy_rules.csv               the 27 fuzzy rules with survey evidence
  fuzzy_comparison.csv          fuzzy vs crisp results on all 252 scenarios
  survey_summary.json           all survey counts, percentages and multipliers
  model_metrics.json            accuracy, confusion matrix, feature importance
  decision_tree_rules.txt       full tree as readable if/else rules
  test_scenarios.csv            test scenario results
docs/                           the dashboard (static HTML/CSS/JS)
  index.html, css/, js/app.js
  data/dashboard_data.js        trained model + survey summary (generated)
  data/academic_calendar.js     UTP semester periods + holidays printed in the UTP calendar (edit by hand)
  data/public_holidays.js       Perak public holidays (generated by src/update_holidays.py, refreshed weekly)
```

## Limitations

- **Small, skewed sample.** 56 students, mostly Year 2 and Village 5 residents. All cafeterias use the pooled data.
- **Stated, not observed, behaviour.** Students reported what they *would* do.
- **No sales or leftover records.** The training labels are simulated from survey weights, so the tree learns survey-derived rules.
- **Independence assumption.** Combined conditions are multiplied together. Demand is floored at 20%.
- **Illustrative energy and cost figures.** Food per portion, cooking kWh, warmer power and the grid CO₂ factor are assumptions. They can be edited on the *AI model & method* tab.
- **Forecast uncertainty.** Rain timing in the tropics is hard to forecast, and weather beyond 16 days (haze beyond about 5) falls back to *Clear*.
- **Cannot foresee sudden events,** such as campus programmes or outages.

**Next step:** log real cooked, sold and leftover numbers with one or two vendors for 2–4 weeks, then retrain on that data.

## Ethics

- The survey was anonymous and voluntary, and no names or identifiable data were collected.
- Every output is labelled as an estimate, and the vendor makes the final decision.

## Team: Group 13

Aqil bin Abdul Samad · Ahmad Ammir Harees bin Ahmad Azimi · Dzikra Ahmad Rizaldi Nurfadillah · Aimar Zufayri bin Zulfadli

Lecturer: Dr. Farahida Hanim binti Mausor

### Data sources & references

- Weather and air-quality forecasts: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0).
- Universiti Teknologi PETRONAS. *Academic Calendar 2026* and *Academic Calendar 2027: Foundation, Undergraduate, and MSc Taught Course.*

- Achariam, N. (2026, June). *Malaysians throw away 6,000 tonnes of edible food daily.* New Straits Times.
- Ali, N. E. H., et al. (2022). Assessment of food waste and its causes in Universiti Teknologi Mara Perak Branch, Seri Iskandar Campus, Malaysia. *IJARBSS, 12*(8).
- Daud, R. M., Rahman, H. A., & Naim, F. (2022). Improving food security through quantification of food waste: A small study at university's cafeterias. *IJARBSS, 12*(14), 157–176.

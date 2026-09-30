# How CostTrace measures cost, and when to trust it less

CostTrace connects two kinds of evidence: **what your cloud bill shows** and **what you deployed, and
when**. This document explains exactly how it combines them, what the numbers mean, and where the
method is weak. Every figure CostTrace prints can be traced back to the rules below.

**The one-sentence version:** CostTrace compares billed cost before and after each deploy, on the
resources that deploy touched or the service it belongs to, and reports the difference with a
± range. That is **correlation in time, not proof of cause**. CostTrace says "coincides with",
never "caused".

---

## 1. Inputs

| Input | What CostTrace reads | Notes |
|---|---|---|
| **Billing data** | [FOCUS](https://focus.finops.org) rows exported by your cloud (AWS, Azure, Google Cloud, OCI) | Used columns: charge period, `EffectiveCost` (default) or `BilledCost` / `ListCost`, charge category, provider, service, resource ID and name, region, tags, usage and pricing quantities and units, commitment discount ID. Everything else is ignored. |
| **Tags on resources** | `costtrace_sha`, `costtrace_service` (and `costtrace_pr`, `costtrace_repo`) | Applied by your deploys (`costtrace tags` prints them). Clouds only put tags into billing exports once they're activated as cost allocation tags, and only for charges after that. |
| **A deploy log** | One entry per deploy: commit SHA, deploy time, and optionally PR, service, title and pre-merge estimate | Supplied by you or your CI. |

**Defaults that matter:**
- **Cost column:** `EffectiveCost`, which includes your own discounts and commitments.
- **Charges:** only `Usage` charges. Taxes, credits and one-off purchases are left out, so commitment purchases aren't counted twice alongside their amortized usage.
- **Currency:** one currency per report. Mixed currencies are rejected rather than converted.

## 2. Per-change measurement (`costtrace report`)

For each deploy, CostTrace compares **the 7 days before** the deploy day with **the 7 days after** it
(`--window`). The deploy day itself is excluded from both, because it's part before and part after.
Costs are compared as daily averages and shown per month (× 365 / 12).

Resources are classified as follows:

| Kind | Rule | Counted as |
|---|---|---|
| **Added** | Carries this deploy's `costtrace_sha` after the deploy, and didn't bill before it | Its full cost after the deploy |
| **Changed** | Carries this deploy's SHA after the deploy, and billed before it | The difference between before and after |
| **Removed** | Tagged with the deploy's `costtrace_service`, and **stopped billing** on the deploy day or the day before | Minus its cost before the deploy (a saving). Inferred from timing, and reported as such |
| **Affected** | Tagged with the deploy's service, *not* re-tagged by it, but its cost moved | The difference, and **listed only if significant** (below). This is how application-code changes with no infrastructure diff are caught |

**When measurement stops early:**
- A resource is measured only until a *later* deploy re-tags it.
- For affected resources, the before and after windows are cut off at the neighbouring deploys *of the same service*, so back-to-back deploys don't claim each other's effects.

**The ± range.** For each resource, CostTrace computes the standard error of the before/after difference from its day-to-day variation. The reported range is **±2 standard errors (≈95%)** of the total, assuming each resource's daily noise is independent.

**"Significant" (for affected resources).** A shift is listed only if it's **both**:
- beyond **3 standard errors** (a service has many resources, so a 95% bar would flag some noise by chance), and
- at least **5%** of the resource's previous cost and at least 1 unit of currency a month.

Smaller shifts still count in the total, but aren't presented as findings.

**Estimate vs. actual.** A change is `over` or `under` its estimate only when the difference exceeds the **largest** of:
- 50% of the estimate (a factor of 1.5),
- 10 units of currency a month,
- the ± range.

Otherwise it's `within`.

**Status.** A result is:
- `pending` until there's billing data after the deploy day,
- `partial` until the full window is available,
- `complete` after that.

## 3. Explaining a period (`costtrace explain`)

`explain` compares two periods: by default a period against the equally long period just before it, or a calendar month against the previous month. For each resource and pricing unit:

| Part | Meaning | Formula |
|---|---|---|
| **Period length** | The periods have different lengths (e.g. 30 vs. 31 days) | baseline cost × (current days ÷ baseline days − 1) |
| **Usage** | More or less of the same thing, at the old unit rate | (current quantity − scaled baseline quantity) × old unit rate |
| **Rate** | A different unit rate for the same thing: prices, discounts, instance sizes, models | (new unit rate − old unit rate) × current quantity |
| **New / removed** | The resource billed in only one of the periods | Its whole cost |
| **Not splittable** | Rows without usage quantities | The difference, unsplit |

The parts **add up exactly** to the change.

**Also flagged:**
- Resources that **started or stopped billing** mid-period. "Stopped" is reported only if billing data continues after that day, so export lag isn't mistaken for a deletion.
- A **commitment discount** (Reserved Instance, Savings Plan, CUD) that stopped or started applying.

**Materiality.** A service's change is "material" only if, beyond the period-length effect, it's at least **5%** of its baseline cost (scaled to the current period) and at least 1 unit of currency. Only material changes are linked to deploys. The rest are reported together as "held steady apart from period length and normal variation".

**How deploys are linked** (only deploys within the two compared periods count):
- **Correlated with / deployed:** the resources carry the deploy's `costtrace_sha` in the current period.
- **Coincides with / same service:** the resources are tagged with the service the deploy went to. When several deploys hit that service, they're listed together with one amount, because they share the same resources and their dollars must not be added up.
- **No corresponding deploy detected:** neither applies. This often means an expired commitment, a price change, traffic, or a resource no tagged pipeline manages.

## 4. What CostTrace cannot see, and how to read results in each case

| Situation | Effect on results | What CostTrace does | What you can do |
|---|---|---|---|
| **Billing lag.** Exports update hours to a day or more after usage | The newest days are missing or incomplete | Marks results `pending` or `partial`; `explain` notes incomplete periods | Re-run after a day or two; don't judge a deploy on day one |
| **Traffic changes and seasonality** | A deploy on the day traffic rises gets the traffic's cost as well | Nothing automatic yet. Service-level "affected" impact includes organic growth, and the notes say so | Compare with request volume; prefer windows without launches or holidays; use `--window` |
| **Overlapping deploys**, several in one window | Their effects mix | Re-tags cut measurement short; service windows stop at neighbouring deploys; same-day deploys to one service are flagged as inseparable | Deploy cost-sensitive changes separately; read the overlap notes |
| **Shared resources**, several services on one database or cluster | Cost can't be split between services by the bill alone | The resource gets whatever single service tag it carries | Tag shared resources with the service that owns the cost; Kubernetes-level allocation is a possible future source |
| **Untagged resources** | Can't be linked to a deploy or a service | Ignored by `report`, which reads only rows with CostTrace tags; rows with no resource ID are shown as unattributable. In `explain` they're included and reported as "no corresponding deploy detected" | Apply tags from your IaC defaults; activate them as cost allocation tags |
| **Tags activated late** | Earlier billing rows have no tags | Correlation starts from when tags appear | Activate tags before measuring; allow a day for them to show up |
| **Autoscaling and bursty workloads** | Noisy daily costs widen the ± range | A wider ± range; small shifts aren't listed as significant | Use longer windows; treat wide ranges as "inconclusive" |
| **Commitments and amortization** | Coverage shifts can move rates without any deploy | `EffectiveCost` includes amortized commitments; `explain` flags lost or gained commitments | Look for "commitment discount no longer applied" before blaming a deploy |
| **Multi-day or monthly charges** | Some rows span many days | Spread evenly across the days they cover | Nothing needed, but the day-level shape is approximate |
| **Shared costs with no resource** (support, some networking) | Can't be attributed | Reported separately as unattributable | Nothing needed |

## 5. What would make a result more trustworthy

A correlation is **stronger** when:
- the resource carries the deploy's own SHA (the deploy created or changed it),
- the cost moved right after the deploy, and the ± range is narrow,
- no other deploys to the same service fall within the window,
- the size and direction match what the diff does (e.g. more queries → more database I/O).

It's **weaker** when:
- the link is only "same service", with several deploys overlapping,
- traffic or pricing changed at the same time,
- the change is close to the ± range,
- the data is `partial`.

Showing this confidence level explicitly, with the evidence behind it, is on the roadmap.

## 6. Checking it yourself

- Every number comes from rows in your own export: `--format json` shows the per-resource figures behind each total.
- The sample dataset (`examples/sample`) and the tests (`packages/*/test`) spell out the expected behaviour case by case: added, changed, removed, affected, calendar effects, commitments, overlaps and billing lag.
- Found a case where the method misleads? Please [open an issue](https://github.com/costtrace/costtrace/issues). Methodology problems are treated as bugs.

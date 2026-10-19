# Stage 2: AI Data-Handling Transparency Audit

Date: 2026-10-19. Read-only audit. No application code, configuration, `.gitignore`, `.env`, credential or existing report was changed or opened. No Gemini request, provider probe or account access was made. This is the only file created.

**Labels.** `[CODE]` read in this repository (file named). `[SDK]` read in the installed `@google/genai` 1.52.0 package source (static reading). `[GOOGLE]` stated by a Google page cited in section 4. `[UNKNOWN]` not established. This report makes no compliance, confidentiality, deletion or data-residency claim.

---

## 1. What can leave the application

### 1.1 The only outbound AI path `[CODE]`

When `GEMINI_API_KEY` is set, `createGeminiAnalyzeFn()` (`src/geminiAgent.ts`) calls `client.models.generateContent()` through `@google/genai`. It sends:

| Part of the request | Content |
|---|---|
| `model` | `GEMINI_MODEL` or `gemini-3.6-flash` |
| `systemInstruction` | `AGENT_SYSTEM_PROMPT` (`src/agentContract.ts`): fixed text, no user data |
| `contents` | A fixed instruction plus `JSON.stringify(context.datasets, null, 2)`: **the four datasets, in full** |
| `config` | `responseMimeType`, `responseSchema`, abort signal, timeout |
| Header | The API key (`x-goog-api-key`, set by the SDK) `[SDK]` |

Nothing else is sent. The response is parsed, validated and used only for the narrative fields.

### 1.2 The four datasets: exact fields

For submitted evidence they are built by `normalizeAssessmentInput()` (`api/inputNormalizer.ts`, lines 304-376). For the built-in REQ-BEN-001 fixture they are the files in `data/` sent verbatim (synthetic data).

| Dataset | Fields that reach Gemini (submitted evidence) |
|---|---|
| `requirement` | `requirementId` (a hash of all inputs, `REQ-USR-...`), `title` (release name, else the first sentence of the scope), **`description` = user story + release scope, verbatim**, `criticality`, `affectedAreas` (slugs of the criteria's areas), `securitySensitive`, **acceptance criteria** (`id`, `area`, `critical`, **`text` verbatim**), plus wrapper text: `schemaVersion`, `synthetic: true`, a `disclaimer` stating the context is "Not real production data", `servedByTool` |
| `existingTests` | per test: `testId` (T1, T2, ...), **`title` verbatim**, `area`, `testType`, `coverageType` (inferred from the title by keywords), `status` (`active` only for `passed`, otherwise `quarantined`), `covers`; per criterion: mapped and active test ids and `covered`; `areas` |
| `knownDefects` | per defect: `defectId` (D1, ...), `severity`, `status`, `area`, `security`, `relatedAcceptanceCriteria`, **`description` verbatim (free text)** |
| `riskRules` | A fixed policy generated from the area names (risk level per area, critical areas, the gate rules text, COV and SEC conditions, the 0.8 threshold). No user free text beyond area slugs |

### 1.3 What is not sent to Gemini `[CODE]`

- **Business rules text.** It is kept in the local context and is not part of the datasets.
- **Supporting documents.** Names, sizes, types, and the first 400 characters of a text note stay in the browser or the local context. The browser's payload carries only `name`, `size`, `type` for them (`web/workspace.js`, `getPayload()`), and these are not in the datasets.
- **PDF, DOCX and XLSX contents.** They are never parsed, only attached as metadata.
- **User-entered test and defect labels** (for example "TC-101"), the original status text, and uploaded filenames.

### 1.4 How uploaded files reach the prompt `[CODE]`

CSV, JSON and TXT files are parsed in the browser (`web/upload.js`) into form rows: test cases, defects or notes. Whatever text those rows contain becomes test titles or defect descriptions and **is sent verbatim**. Row content is not screened for personal data, secrets or confidential text.

### 1.5 Other places the data goes

| Place | Finding |
|---|---|
| The application server | The browser posts the payload to the same origin (`POST /api/assess/custom`). Held in memory in `runRegistry` until taken. `web/app.js` makes no cross-origin request. `[CODE]` |
| Disk | Each run writes `.pipeline-run/custom-<id>.state.json` (all four datasets and the findings) and a findings file, removed in a `finally` block (`api/customAssessmentRunner.ts:227`). A killed process can leave them. The CLI default state file is `.pipeline-run/state.json`. `.pipeline-run/` is gitignored. `[CODE]` |
| Vercel path | Uses a temp state file removed in `finally` (`api/_vercelShared.ts`). `[CODE]` |
| Database, cache, analytics, telemetry | None found. No third-party service is called by app code. `[CODE]` |
| Logs | The server logs only startup and port errors. Prompts and responses are not logged or persisted by the app. A provider error message is stored in the trace entry `detail` and shown in the report. Whether those messages can contain sensitive text is `[UNKNOWN]`. `[CODE]` |
| Report and PDF | The report holds the AI's narrative and the user's own data. The PDF is generated in the browser and does not leave it. `[CODE]` |

### 1.6 The rules-based fallback `[CODE]`

`api/evidenceAnalyzer.ts` is pure local code. A search of `api/`, `src/` and `web/` found no network call in it or in the validator, adapter or gate. It makes **no external request**. It is used when no key is set, or when the live call or its validation fails. The report labels the mode honestly ("QA analysis mode: Rules based").

### 1.7 Credentials `[CODE]` `[SDK]`

- The key comes from `process.env.GEMINI_API_KEY`. Node does not load `.env` by itself, and the start scripts do not pass `--env-file`, so the key must be exported or passed explicitly.
- Child pipeline processes inherit the full environment.
- The app never logs the key. The SDK puts it in a request header.
- Render holds it as a dashboard secret (`render.yaml`, `sync: false`).
- `.env` and `.env.example` are gitignored.

### 1.8 Provider routing can be changed by the environment `[SDK]`

The installed SDK reads these variables itself: `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL` and `GOOGLE_VERTEX_BASE_URL`. The app does not pin the product or endpoint, so the environment, not the code, can decide which Google product and endpoint receive the data. Which terms apply therefore depends on deployment configuration, and the API key alone does not prove it.

### 1.9 Correction to the earlier probe finding

I said earlier that the SDK honoured no base-URL override. That came from searching the browser build (`dist/index.mjs`). The Node build the app actually loads (`dist/node/index.mjs`) does read `GOOGLE_GEMINI_BASE_URL` (line 21308, `getBaseUrl()`). The probe set `GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9` and finished in about 49 ms. **By static code reading, the probe's request most probably went to `127.0.0.1:9` (connection refused), not to Google.** That is likely, not proven: I did not access provider usage records or logs from the time, and I did not repeat the probe.

### 1.10 User-facing statements that conflict with live mode `[CODE]`

- `web/workspace.js:692` (Evidence screen): "Runs locally against your submitted evidence only. No application is executed and no external service is called." This is **false whenever a key is set**, because the evidence is sent to Gemini.
- The analysis mode is shown only after a run, not before the user submits evidence.
- The synthetic-data disclaimer text that is sent inside every dataset says the context is not real production data. That would be wrong for real evidence.

---

## 2. Google terms: verified facts and unknowns

Sources are in section 4. "Unpaid" and "Paid" are Google's own terms for the Gemini Developer API.

### 2.1 Verified

| Topic | What the sources say |
|---|---|
| Free (Unpaid) tier use of content | Google "may use" submitted content and generated responses to "provide, improve, and develop" its products and ML technologies. Human reviewers "may read, annotate, and process" API input and output. The terms say not to submit "sensitive, confidential, or personal information" to the Unpaid Services. [T] The pricing page repeats that free-tier content is used to improve Google's products, and shows `gemini-3.6-flash` as free of charge. [P] |
| Paid tier use of content | Google does not use prompts or responses to improve its products. [T] [P] |
| Logging and retention (Developer API) | Logs are available only for billing-enabled projects. Default maximum retention is 55 days, configurable to 7, 14, 28 or 55 days, after which logs are marked for deletion. Logs are not used for product improvement by default. Datasets you choose to share may be reviewed by humans and used to improve models. [L] |
| Abuse-monitoring logs | The terms say paid-tier prompts and responses are logged "for a limited period of time" to detect violations of the Prohibited Use Policy. The logs page says these are separate from project logs and gives no period. [T] [L] |
| Location | Paid-tier data "may be stored transiently or cached in any country in which Google or its agents maintain facilities." No region list and no residency guarantee for the Developer API. [T] |
| Restrictions that matter | Users must be 18+. In the EEA, Switzerland and UK only Paid Services may be used when making API clients available to users there. The services may not be used in clinical practice. [T] |
| Vertex AI (now titled "Gemini Enterprise Agent Platform") | Google says it will not train or fine-tune models on customer data without permission or instruction. Prompt logging for abuse monitoring applies to Google models under the Cloud Platform Terms, with a zero-retention exception that must be requested. Caching is on by default (in-memory, deleted within 24 hours, project-scoped; a durable tier, also within 24 hours) and can be disabled. Regional endpoints keep cached data within the selected location. The global endpoint may serve from any region. [V] |

### 2.2 Not established `[UNKNOWN]`

1. **Which tier and product the intended deployment uses.** The key does not show it. Whether this project's key is on an unpaid or paid project, and whether the environment routes to Vertex (section 1.8), is not visible from the code.
2. **Abuse-monitoring retention period** for the Developer API. Not stated on the pages I read.
3. **Whether the Developer API has regional processing or residency options.** The terms say data may be stored in any country. **No UAE data-residency guarantee was found for either product.**
4. **How to disable logging or delete individual logs** for the Developer API. The logs page describes automatic deletion only.
5. **Whether the Developer API follows the Vertex page's retention and caching terms.** That page does not say.
6. **Whether any contractual terms beyond these public pages apply** (for example a customer agreement). I did not look at any account.
7. **What a provider error message can contain.** It is stored in the report.
8. **Whether the model name `gemini-3.6-flash` is the right choice.** Google's models page (updated 2026-10-13) lists it as a stable, previous-generation Flash model, with `gemini-3.8-flash` newer. I make no claim that either suits this use.

---

## 3. Risks and safeguards

### 3.1 Mandatory before any live evaluation (Stage 3) or real evidence

| # | Risk | Safeguard |
|---|---|---|
| M1 | The Evidence screen says no external service is called, which is untrue in live mode | Replace it with an accurate statement and disclose external AI processing before submission, including that mode shows only after a run |
| M2 | The paid-versus-unpaid tier and product are unknown, and the free tier may use content for product improvement and human review | Decide and document the tier and product before any use. Use a paid-tier project (or Vertex under an agreement) for anything but synthetic data, and confirm it by account evidence, not by the key |
| M3 | Free-text fields (story, scope, criteria, test titles, defect descriptions) and uploaded CSV/JSON/TXT rows go out verbatim with no screening | For the live evaluation use only synthetic or properly anonymised fixtures. State that no personal data, credentials or confidential customer information may be entered until approved |
| M4 | The environment can silently change the Google product or endpoint | Pin the intended product and endpoint explicitly in configuration, or document and check the required environment variables at startup |
| M5 | The dataset wrapper tells the model the data is "synthetic" and "Not real production data" | Make this accurate for the data actually used, or remove it from non-synthetic runs |

### 3.2 Optional improvements

- Show the analysis mode and "evidence will be sent to Google" before the Analyze button, not only after the run.
- A setting to switch live AI off (offline only) per deployment.
- Minimise the payload: omit areas and fields the analysis does not need.
- Redact or truncate provider error text before storing it in the report.
- Start the server with an explicit `--env-file` instruction in the documentation, and keep `.env.example` tracked (it is currently gitignored).
- Review the 55-day log retention for the paid tier and set the shortest period that fits.

---

## 4. Sources (fetched 2026-10-19)

| ID | Source | Date shown | Supports |
|---|---|---|---|
| T | Gemini API Additional Terms of Service, https://ai.google.dev/gemini-api/terms | Effective 2026-03-23; last updated 2026-04-28 | Unpaid versus paid data use, human review, logging, location, age, EEA/UK, clinical use |
| L | Gemini API "Data logging and sharing", https://ai.google.dev/gemini-api/docs/logs-policy | Last updated 2026-10-14 | 55-day default log retention, sharing, product improvement |
| P | Gemini Developer API pricing, https://ai.google.dev/gemini-api/docs/pricing | none shown | Free tier covers `gemini-3.6-flash`; free-tier content used to improve products |
| V | Vertex AI / Gemini Enterprise Agent Platform data governance and zero data retention, https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance | Last updated 2026-10-15 | Training use, logging, caching, region behaviour |
| M | Gemini models, https://ai.google.dev/gemini-api/docs/models | Last updated 2026-10-13 | Model IDs and status |

I read these pages directly; one search result summary (log retention) agreed with page L. I did not review any separate contract, trust centre or regional-availability page.

---

## 5. Criteria for authorising Stage 3 (live evaluation)

All must hold:

1. **Data:** the evaluation uses only synthetic or properly anonymised fixtures (M3), reviewed before sending.
2. **Tier and product:** a written decision names the exact tier and product, with evidence from the account (M2), and the provider terms for that choice have been reviewed by whoever owns the risk.
3. **Routing:** the endpoint and product are pinned or checked (M4).
4. **Disclosure:** the UI statement in M1 is corrected, and users are told when external AI processing will occur.
5. **Credentials:** a dedicated key, kept out of the repository and logs, with a budget or quota limit set by the owner.
6. **Scope:** a fixed test plan and a stop condition agreed beforehand, covering the number of calls and the fixtures.
7. **Explicit authorisation from you** for the first live call. None has been validated so far.

Recommendation: **not authorised yet.** M1 to M5 are open, and items 2 and 5 depend on facts I cannot see.

## 6. Small ordered plan (not started)

1. Fix the false "no external service" statement and disclose live AI processing (M1).
2. Record the tier and product decision, and the synthetic-data rule, in the documentation (M2, M3).
3. Pin or check the Google product and endpoint at startup (M4).
4. Make the dataset disclaimer truthful for the data used (M5).
5. Prepare the synthetic fixtures and the evaluation plan for Stage 3.
6. Optional: show the mode before submission, add an offline-only switch, redact provider errors, and track `.env.example`.

Items 1 to 4 change code or documentation and need your approval.

---

## 7. Remediation status (added 2026-10-19; sections 1 to 6 above are the original audit and are kept unchanged for traceability)

Items M1, M4 and M5 and the error-handling point were implemented. They are code and wording changes, not account verification. No Gemini request was made while doing this.

### 7.1 Verified application behaviour after the change `[CODE]`, tested offline

| Finding | Change | Where |
|---|---|---|
| M1: the Evidence screen claimed no external service is called | Replaced by a notice on the Evidence screen, above the evidence cards and therefore before the Analyze button. It states, for the case where Gemini analysis is enabled, what is sent (user story and release scope, acceptance-criteria text, test titles, defect descriptions, ids, statuses, criticality, area names; text from CSV, JSON and TXT uploads), that PDF, DOCX and XLSX contents are not read, that the offline rules-based analysis runs on the server and makes no request to the AI provider, and that secrets, credentials, personal data and confidential production or customer evidence must not be submitted until data-handling requirements have been reviewed and approved. The bottom note no longer claims local-only processing | `web/workspace.js` (`externalAiNotice()`, the foot-note), tests `tests/e2e/dataDisclosure.spec.ts` |
| M5: datasets told the model the evidence was synthetic and "Not real production data" | For submitted evidence the `synthetic` flag is removed from the requirement, test and defect datasets and from the generated policy document, and the disclaimer now says the application does not check whether the evidence is synthetic, anonymised or real. The bundled REQ-BEN-001 fixture keeps its flag because it is synthetic | `api/inputNormalizer.ts`, `api/policy.ts` |
| M4: the environment could change the Google product or endpoint | `assertDeveloperApiRouting()` runs before the client is created and **fails closed** (the call rejects, nothing is sent) if any of these variables is set and non-empty: `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_VERTEX_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GEMINI_NEXT_GEN_API_BASE_URL`. The list was read from the installed SDK source (1.52.0). The error names the variables, never their values. The client is also created with `vertexai: false`, and the key must come from `GEMINI_API_KEY`: the SDK is not allowed to fall back to `GOOGLE_API_KEY` | `src/geminiAgent.ts` |
| Provider errors reached reports | `sanitizeProviderError()` redacts API keys, bearer tokens, authorization and key headers, the exact configured key values and URL query strings, reduces a JSON error body to its HTTP status and short message (dropping `details`), and limits the length to 200 characters. It is applied where the analysis error enters the pipeline trace (the report and PDF data), the in-process pipeline's trace and fail-safe reason, and the CLI's fatal-error print | `src/providerError.ts`, `src/pipelineCli.ts`, `src/releaseAssessment.ts`, `src/geminiAgent.ts` |

What happens when the guard refuses: the analysis step fails, the trace records the sanitised, actionable message, and the existing behaviour applies. In the web application, submitted evidence falls back to the offline rules-based analysis and the built-in fixture falls back to its recorded findings, and the report says which mode ran. A direct pipeline run with no fallback (the CLI, or tests) fails safe to NO_GO / FAIL_SAFE. The deterministic gate decides in every case, and the decision for the same evidence is unchanged.

### 7.2 Intended provider configuration

The Gemini Developer API at the SDK's default endpoint, using a key from `GEMINI_API_KEY`, with none of the routing variables above set. Any other configuration (Vertex AI / Gemini Enterprise Agent Platform, a proxy or custom endpoint, a project or location) is **not** approved and is refused by the guard until it is explicitly reviewed and approved.

### 7.3 What the code check does not establish

- The guard checks routing only. It does **not** show which Google account tier or data-use terms apply, whether the project has billing, or what Google retains.
- A client-side notice cannot know whether a given deployment has Gemini enabled: it states both cases and the report states the mode that ran. Showing the actual mode before submission would need a new field in an API response, which was out of scope and needs approval.
- The routing list comes from the installed SDK version. Re-check it when the SDK is upgraded.
- Sanitising removes known credential shapes and bulky details; it cannot recognise arbitrary sensitive text in a free-form provider message, and it does not scrub the evidence the user submits.

### 7.4 Provider terms verified by the audit (section 2, unchanged)

Unpaid tier: content may be used to improve Google's products and may be reviewed by humans. Paid tier: content is not used for product improvement; logs are kept for abuse detection and, for project logs, 55 days by default. Data may be stored or cached in any country where Google operates. Vertex AI has separate terms.

### 7.5 Still unresolved `[UNKNOWN]`

1. **Which tier and product this deployment's key uses.** Nothing in the code or this remediation shows it.
2. **Abuse-monitoring retention period** for the Developer API.
3. **Data region or residency guarantees.** None found for the Developer API, and **no UAE residency guarantee was found for either product.**
4. **How to disable logging or delete individual logs** for the Developer API.
5. Whether any contractual terms beyond the public pages apply.
6. What a provider error message may contain beyond the shapes the sanitiser handles.

### 7.6 Restriction that still applies

Do not use secrets, credentials, personal data or confidential production or customer evidence with live Gemini analysis until the tier, terms, retention and residency questions above are answered and the data-handling requirements are reviewed and approved by whoever owns that risk. This section makes no claim of legal compliance, confidentiality, deletion or data residency.


### 7.7 Follow-up review of the disclosure (added 2026-10-19; sections 1 to 7.6 are unchanged for traceability)

The disclosure was checked against the code, not against this document. Where they differ, this subsection applies. No provider request was made. Provider and account facts remain as in 7.4 and 7.5.

**What reaches the model, checked by running the real normaliser with marker strings** (`tests/webUnits.test.mjs`, "Evidence notice claims match what the normaliser really sends"):

| Submitted | Reaches the model? |
|---|---|
| Release name (sent as the requirement `title`), user story, release scope, acceptance-criteria text, test titles, defect descriptions | Yes |
| Business rules | No |
| Text from TXT files (kept as a short note on a supporting document) | No |
| Names, sizes and types of uploaded files | No (they are hashed into the requirement id only) |
| CSV and JSON rows | Yes, once they are entered as criteria, tests or defects |
| PDF, DOCX and XLSX contents | Never read |

**Corrections to earlier statements**
- Section 1.4 implied, and the M1 row of 7.1 stated, that text from TXT uploads is sent. Section 1.3 was right: TXT note text is not sent. Only CSV and JSON rows reach the model. The notice now says so.
- The notice omitted the release name, which is sent. It is now listed, together with severities and the test-to-criterion mapping.
- The notice said that when the live call fails the offline analysis "makes no request to the AI provider". That is wrong for a failed attempt: the evidence may already have been sent. It now separates "not enabled" (no request) from "enabled but failed or unusable" (a request may have been made).
- The Technical Details line said "no live model call" for every rules-based report. That was wrong after a failed attempt. It now says an offline analysis ran and that the report cannot show whether a live attempt came first.
- The mode label named a specific model ("Gemini 3.6 Flash"). The browser does not know which model ran (`GEMINI_MODEL` can change it), so the label now says "Gemini".

**Limitation found, not fixed here**
- After a failed live attempt the application reruns the analysis offline. In an offline simulation using the routing guard (no client, no network), the final report's pipeline trace held only the fallback run's entries, all marked OK, and `mode` was just `rules-based`. The report therefore cannot distinguish "Gemini was not enabled" from "Gemini was tried and failed". The interface now says so instead of guessing.
- Fixing it needs a new field in the assessment response (for example whether a live attempt was made), in `api/customAssessmentRunner.ts` and `api/_vercelShared.ts`. That is an API change outside the disclosure follow-up and needs separate approval. Until then, treat any deployment with `GEMINI_API_KEY` set as having possibly sent the evidence, whatever the report mode says.

**Wording the notice deliberately avoids:** it makes no statement about data residency, legal compliance, retention, deletion, or that the provider does not use or keep the data. It says that what the provider keeps or uses depends on the account's terms, which the application cannot show or verify. An end-to-end test (`tests/e2e/dataDisclosure.spec.ts`) fails if such words appear.

**Still true:** 7.5 (unresolved provider facts) and 7.6 (do not use secrets, credentials, personal data or confidential evidence with live Gemini analysis until those questions are answered and approved).

# scout-system-automation

> **End‑to‑end recruiting workflow — Auto‑Upload Apps Script → GCS → Cloud Run PDF parser → Google Sheet → Matching & Scout GAS**

---

## 0  Quick‑Look Architecture

```text
           ┌────────┐ ①Upload PDF   ┌──────────────────────┐
           │Recruiter│─────────────▶│Shared Drive “jobs-inbox│
           └────────┘               └─────────┬────────────┘
                             (A) Apps Script   │ copy
                                               ▼
           ┌──────────────────────────────────────────────┐
           │   GCS bucket  gs://scout-system-pdf-intake-* │
           └───────────────▲──────────────────────────────┘
                           │ (B) Cloud Events
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Cloud Run : **pdf_ingest**                                     │
│ • downloads PDF                                               │
│ • extracts fields via Gemini 1.5 Flash                        │
│ • upserts row in Sheet 〈Job_Database〉                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────── Google Sheet ───────────────┐
│ Sheet1: 〈Job_Database〉                    │◀─ (C) Sheets API
│ Sheet2: 〈Candidate_Pipeline〉              │
│ Sheet3: 〈Interview_Notes〉 …              │
└────────────────────────────────────────────┘
          ▲              ▲
          │ GAS (D)      │ GAS (E)
          │              │
┌────────────────────────────┐  ┌────────────────────────────┐
│ Apps Script **uploader**    │  │ Apps Script **matching**   │
│ • polls Drive → copies PDF │  │ • runBatchScoutMatching()   │
│   to intake bucket         │  │ • runAdvancedMatching()     │
└────────────────────────────┘  └────────────────────────────┘

(A) Drive‑bound Apps Script copies each new PDF → GCS  
(B) Object‑finalize event triggers Cloud Run **pdf_ingest**  
(C) **pdf_ingest** updates Job_Database Sheet  
(D)(E) Sheet‑bound GAS calls Cloud Run **match_api** to rank jobs & draft outreach via Gemini
```

---

## 1  Repository Layout

| Path / Dir               | Purpose / Target Runtime                            |
| ------------------------ | --------------------------------------------------- |
| **`gas/uploader/`**      | Drive‑bound GAS (auto‑upload)                       |
| **`gas/matching/`**      | Sheet‑bound GAS (マッチング＆スカウト)                        |
| **`match_api/`**         | Flask service → Cloud Run `match-service`           |
| **`pdf_ingest/`**        | FastFunction → Cloud Run `pdf-ingest`               |
| **`.github/workflows/`** | Reusable + Thin trigger workflows (GAS deploy & CI) |
| `scripts/`               | Helper scripts (refresh‑token, local dev)           |
| `README.md`              | (this file)                                         |

> **GAS ソース**は `gas/<project>` にまとめ、`clasp push` + GitHub Actions で自動同期。

---

## 2  GitHub Actions (CI / CD)

### 2.1 Reusable Workflow

`gas-deploy.yml` (workflow\_call) builds Node 20, installs `@google/clasp`, writes `~/.clasprc.json` from repo Secrets, then `clasp push --force` inside the project dir.

### 2.2 Thin Triggers

`gas-uploader.yml` / `gas-matching.yml` call the reusable workflow and **inherit secrets**.

```yaml
jobs:
  call-deploy:
    uses: ./.github/workflows/gas-deploy.yml
    secrets: inherit         # pass CLASP_* secrets
    with:
      dir: gas/matching      # project‑specific path
```

### 2.3 Cloud Run auto‑deploy (Python services)

*Push → Cloud Build → Docker build → Run deploy* (see Cloud Build triggers).

---

## 3  Cloud / SaaS Resources

| Type            | Name / ID                               | Notes                  |
| --------------- | --------------------------------------- | ---------------------- |
| **Project**     | `scout-system-automation`               | GCP root project       |
| **Bucket**      | `scout-system-pdf-intake-*`             | PDF intake             |
| **Bucket**      | `scout-system-config`                   | prompts / misc cfg     |
| **Cloud Run**   | `pdf-ingest`                            | 512 MiB, timeout 300 s |
| **Cloud Run**   | `match-service`                         | Flask, 512 MiB         |
| **Apps Script** | *uploader*                              | Drive‑bound            |
| **Apps Script** | *マッチング＆スカウト*                            | Sheet‑bound            |
| **Sheet**       | *Job\_Database* / *Candidate\_Pipeline* | Master DB              |
| **Eventarc**    | GCS finalize → pdf\_ingest              | Trigger                |
| **SA**          | `pdf-processor-bot@`                    | Cloud Run + GCS roles  |

---

## 4  Local Dev Cycle (Python services)

```bash
# edit
vim match_api/main.py

# run tests
pytest

# local serve
uvicorn match_api.main:app --reload

# commit & deploy
git add match_api/*
git commit -m "feat(match): better scoring"
git push origin main   # Cloud Build auto‑deploys
```

Manual fallback:

```bash
gcloud run deploy match-service \
  --source=match_api \
  --region=asia-northeast1 \
  --memory=512Mi --timeout=300
```

---

## 5  Secrets & Config

| Secret / Key          | Used in              | Where to set                               |
| --------------------- | -------------------- | ------------------------------------------ |
| `CLASP_CLIENT_ID`     | GAS deploy workflows | GitHub → Settings → Actions → Secrets      |
| `CLASP_CLIENT_SECRET` | GAS deploy workflows | same                                       |
| `CLASP_REFRESH_TOKEN` | GAS deploy workflows | same (Apps Script API toggle **ON** token) |
| `PROMPT_GCS_PATH`     | `pdf_ingest`         | Cloud Run env var                          |
| `SPREADSHEET_ID`      | `match_api` & GAS    | Cloud Run env var / Script Properties      |

---

## 6  Smoke Test

1. **Upload** `sample.pdf` → Drive `jobs-inbox`
2. Row appears in **Job\_Database** Sheet via pdf\_ingest
3. Spreadsheet → メニュー `スカウト補助 → 未処理候補者を一括処理`
4. Gemini から Subject / body / job picks が生成される

---

## 7  Ops / Monitoring

* **Cloud Run logs** — pdf\_ingest `INFO|ERROR` markers
* **Cloud Build** — Docker build / deploy status
* **GAS** — Stackdriver; `console.log()` outputs
* **Alerting** — Log‑based: severity≥ERROR / build FAILURE
* **Rollback** — Cloud Run keeps latest 100 revisions, GAS keeps versions

---

## 8  Troubleshooting Cheatsheet

| Symptom                            | Cause / Fix                               |
| ---------------------------------- | ----------------------------------------- |
| `Revision failed to start`         | Wrong `$PORT` / Procfile → check gunicorn |
| `403 storage.objects.create` (GAS) | SA lacks *Storage Object Creator* role    |
| Duplicate rows in Sheet            | key normalisation bug                     |
| Gemini timeout                     | Increase Cloud Run timeout or add retries |

---

## 9  Contributing Workflow

1. **Branch** off `main` (`feat/`, `fix/`, `chore/` prefix).
2. Follow **Conventional Commits** (`feat(match): add top‑k filter`).
3. Open **PR** — GitHub Actions runs lint + tests + GAS dry‑run.
4. Keep docs & this README in sync with changes.

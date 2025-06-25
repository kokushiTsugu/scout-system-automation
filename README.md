# Scout System Automation

> **Purpose** – Automate *every* step of our scouting pipeline  
> **①** PDF job-post intake → **②** clean master DB on Google Sheets → **③** AI-driven matching & personalised outreach.

---

## 1  High-Level Architecture

```text
           ┌────────┐ ①Upload PDF   ┌──────────────────────┐
           │Recruiter│─────────────▶│Shared Drive “jobs-inbox│
           └────────┘               └─────────┬────────────┘
                             (A) Apps Script   │ copy
                                               ▼
           ┌──────────────────────────────────────────────┐
           │   GCS bucket  gs://scout-system-pdf-intake-* │
           └───────────────▲──────────────────────────────┘
                           │ (B) Cloud Events
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│   Cloud Run : **pdf_ingest**                                   │
│   • downloads PDF                                              │
│   • extracts fields via Gemini 1.5 Flash                       │
│   • upserts row in Sheet 〈Job_Database〉                       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────── Google Sheet ───────────────┐
│ Sheet1: 〈Job_Database〉                    │◀─ (C) Sheets API
│ Sheet2: 〈Candidate_Pipeline〉              │
│ Sheet3: 〈Interview_Notes〉 …              │
└────────────────────────────────────────────┘
          ▲              ▲
          │ GAS (D)      │ GAS (E)
          │              │
┌────────────────────────────┐  ┌────────────────────────────┐
│ Apps Script **Auto-Upload**│  │ Apps Script **Matching&Scout│
│ • polls Drive → copies PDF │  │ • runBatchScoutMatching()   │
│   to intake bucket         │  │ • runAdvancedMatching()     │
└────────────────────────────┘  └────────────────────────────┘

(A) Auto-Upload Apps Script copies each new PDF from Drive → GCS
(B) Object finalize event triggers Cloud Run pdf_ingest
(C) pdf_ingest updates Job_Database with parsed fields
(D)(E) Spreadsheet-bound Apps Scripts call Cloud Run match_api to rank jobs & draft outreach copy with Gemini

# 2 Repository Layout
| Path / Dir                   | Purpose (who runs it)                                              |
| ---------------------------- | ------------------------------------------------------------------ |
| **`match_api/`**             | Flask + Gunicorn service → `/match`  (Cloud Run **match-service**) |
| **`pdf_ingest/`**            | Fast Function for GCS events       (Cloud Run **pdf-ingest**)      |
| **`apps_script/`**           | GAS **Auto-Upload-to-Google Cloud** (Drive-bound)                  |
| **`gas_matching/`**          | GAS **マッチング＆スカウト**           (Sheet-bound)                         |
| `README.md`                  | ← you’re reading                                                   |
| infra helpers (.gitignore …) | Procfile, requirements, etc.                                       |

apps_script/ と gas_matching/ は clasp clone したまま置いているので
ローカル編集 → clasp push で即 Spreadsheet/Drive に反映できます。

# 3 Cloud Resources
| Type            | Name / ID                               | Notes                    |
| --------------- | --------------------------------------- | ------------------------ |
| **Project**     | `scout-system-automation`               |                          |
| **Bucket**      | `scout-system-pdf-intake-*`             | PDF intake               |
| **Bucket**      | `scout-system-config`                   | prompt txt 等             |
| **Cloud Run**   | `pdf-ingest`                            | 512 MiB / concurrency 1  |
| **Cloud Run**   | `match-service`                         | 512 MiB / concurrency 10 |
| **Apps Script** | *Auto-Upload-to-Google Cloud*           | Drive フォルダに紐付き           |
| **Apps Script** | *マッチング＆スカウト*                            | Sheet に紐付き               |
| **Sheet**       | *Job\_Database* / *Candidate\_Pipeline* | master DB                |
| **SA**          | `pdf-processor-bot@`                    | Cloud Run 実行 & GCS read  |
| **Trigger**     | Eventarc (GCS finalize → pdf\_ingest)   |                          |
| **Build**       | GitHub push → Cloud Build               | Docker build & deploy    |

# 4 4 Development Cycle (Python services)
# edit
vim match_api/main.py

# tests
pytest

# local run
uvicorn match_api.main:app --reload

# commit & push
git add match_api/*
git commit -m "feat(match): better scoring"
git push origin main   # Cloud Build auto-deploys

## Manual deploy (fallback)
gcloud run deploy match-service \
  --source=match_api \
  --region=asia-northeast1 \
  --memory=512Mi --timeout=300

# 5 Secrets / Config
| Name               | Used in              | Hint                            |
| ------------------ | -------------------- | ------------------------------- |
| `PROMPT_GCS_PATH`  | `pdf_ingest/main.py` | path to prompt in config bucket |
| `SPREADSHEET_ID`   | Cloud Run vars       | Job\_Database sheet ID          |
| Gemini server auth | workload identity    | no API key needed               |
| `GEMINI_API_KEY`   | GAS Script Property  | set once via editor             |

# 6 Smoke Test
1. Upload sample.pdf to Drive folder jobs-inbox.
2. Confirm row appears in Job_Database.
3. Spreadsheet → スカウト補助 → 未処理の候補者を一括処理 実行。
4. Subject / body / job picks が自動生成される。

# 7 Ops & Monitoring
- Cloud Run logs – pdf_ingest prints [Start] / [Append] / [Error]
- Cloud Build logs – push builds both services
- GAS logs – Stackdriver; use console.log()
- Alerting – Log-based: severity≥ERROR ・ build FAILURE
- Rollback – Cloud Run keeps last 100 revisions; GAS keeps versions

# 8 Troubleshooting Cheatsheet
| Symptom                            | Likely Cause / Fix                            |
| ---------------------------------- | --------------------------------------------- |
| `Revision failed to start`         | wrong PORT / Procfile → check gunicorn config |
| `403 storage.objects.create` (GAS) | SA lacks *Storage Object Creator* role        |
| Duplicate rows in Sheet            | key normalisation bug                         |
| Gemini timeout                     | increase Cloud Run `--timeout` or add retries |

# 9 Contributing
1. Branch off main (feat/, fix/, chore/).
2. Use Conventional Commits (feat(match): …).
3. PR → GitHub Actions runs lint + tests.
4. Keep docs & README current.


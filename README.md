# Scout System Automation

> **Purpose** – Fully automate the scouting workflow in recruitment: **(1)** extract structured data from job‑post PDFs, **(2)** maintain a clean master DB in Google Sheets, **(3)** auto‑match candidates & draft outreach messages with Gemini.

---

## 1  End‑to‑End Flow

```text
┌────────┐      (A)           ┌────────────┐  Eventarc  ┌─────────────┐
│Recruiter│───upload PDF───▶│GDrive Folder│──────────▶│GCS Bucket   │
└────────┘                   │“jobs‑inbox”│             │pdf‑intake   │
                                                   (B) Cloud Events
                                                        │
                                                        ▼
                                             Cloud Run  service
                                             “my‑first‑function”
                                                        │ Sheets API
                                                        ▼
                                          Google Sheet 〈Job_Database〉
```

(A) Drive upload GN drives Apps Script ⭢ copies file to the GCS bucket.
(B) Bucket **finalize** event triggers *my‑first‑function* which

1. downloads the PDF
2. sends it to **Gemini 1.5 Flash** with `prompt-job-extract.txt`
3. upserts a row in **Job\_Database** (duplicate key = company×position).

---

## 2  Repository Layout (this repo)

| Path                     | Role                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `main.py`                | Cloud Run entrypoint (`process_storage_event`)                         |
| `requirements.txt`       | pinned deps inc. `functions‑framework`                                 |
| `Procfile`               | `web: functions-framework --target process_storage_event --port $PORT` |
| `.gitignore`             | ignore build artefacts & local logs                                    |
| `prompt-job-extract.txt` | extraction prompt (stored in `gs://scout-system-config`)               |

> **Tip**  Keep all infra code here; Drive Apps Script lives in the “jobs‑inbox” folder itself.

---

## 3  Cloud Resources

| Resource            | Name / ID                                                        | Notes                                 |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| **Project**         | `scout-system-automation`                                        |                                       |
| **Bucket**          | `scout-system-pdf-intake-YYYYMMDD`                               | Event source                          |
| **Bucket**          | `scout-system-config`                                            | stores prompt text, etc.              |
| **Cloud Run**       | `my-first-function`                                              | 1 GiB, concurrency 1                  |
| **Apps Script**     | `Drive → GCS uploader`                                           | runs in jobs‑inbox folder             |
| **Sheet**           | `14zSdCGQ9OnPzdiMOjZzQeAYj259JyB5Jk_I19EAG4Y8` / *Job\_Database* |                                       |
| **Service Account** | `pdf-processor-bot@`                                             | Cloud Run exec & GCS read             |
| **Trigger**         | Eventarc → Cloud Run                                             | GCS finalize event                    |
| **Build trigger**   | *pending*                                                        | GitHub push → Cloud Build → Cloud Run |

---

## 4  Local Development Cycle

```bash
# edit code
vim main.py

# run unit tests (if any)
python -m pytest

# commit & push
git add main.py requirements.txt
git commit -m "feat: xxx"
git push origin main   # Cloud Build trigger deploys automatically
```

Manual deploy (fallback):

```bash
gcloud run deploy my-first-function \
  --source=. --region=asia-northeast1 \
  --memory=1Gi --concurrency=1 --timeout=360s
```

---

## 5  Environment / Secrets

| Variable          | Where set          | Description                                  |
| ----------------- | ------------------ | -------------------------------------------- |
| `PROMPT_GCS_PATH` | `main.py` const    | `scout-system-config/prompt-job-extract.txt` |
| `SPREADSHEET_ID`  | `main.py` const    | target Google Sheet                          |
| **Gemini auth**   | Cloud Run SA + IAM | uses workload identity (no API key)          |

> For extra security move those consts to **Cloud Run → Variables & Secrets**.

---

## 6  Smoke Test

### Upload via Drive

1. Place a PDF in the shared Drive folder **jobs‑inbox**.
2. Wait ↪ Apps Script copies PDF to the GCS bucket.

### Upload via CLI (direct to bucket)

```bash
PDF=sample.pdf
BUCKET=scout-system-pdf-intake-20250617

gsutil cp "$PDF" gs://$BUCKET/
```

### Verify

```bash
# Tail Cloud Run logs
gcloud beta run services logs tail my-first-function --region=asia-northeast1
```

You should see:

```
[Start] sample.pdf
[Append] id=123 Software Engineer (Tokyo)
```

and the new row appears in **Job\_Database**.

---

## 7  Operations & Monitoring

* **Cloud Run logs** – main.py prints `[Start] / [Append] / [Update] / [Error]` markers.
* **Cloud Build logs** – each push builds; failures email owners.
* **Alerting** – create Log‑based alert: severity≥ERROR or GCS upload 5xx.
* **Rollbacks** – Cloud Run keeps last 100 revisions; UI → “Manage traffic”.

---

## 8  Troubleshooting Cheatsheet

| Symptom                       | Likely cause                                 | Fix                                       |
| ----------------------------- | -------------------------------------------- | ----------------------------------------- |
| `Revision failed to start`    | Procfile / PORT                              | Ensure `web:` entry & functions‑framework |
| `403 Insufficient Permission` | Apps Script SA lacks `storage.objectCreator` | IAM → bucket role                         |
| Duplicate rows                | canon() mismatch                             | adjust normalisation rules                |
| Timeout from Gemini           | increase `--timeout`, add retry logic        |                                           |

---

## 9  Contributing

1. Fork & branch off `main`.
2. Follow commit lint (`feat|fix|chore: ...`).
3. PR → GitHub Actions runs lint/tests.
4. Write good docs & keep README updated.

---

© 2025 Tsugu Inc. – Maintained by *kokushi @ tsugu.io* & *k.nagase @ tsugu.io*

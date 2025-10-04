# ──────────────────────────────────────────────────────────────
#  main.py  — Cloud Run (Functions Framework) entry-point
#
#   0.  GCS に置いた抽出プロンプトをロード      (PROMPT_GCS_PATH)
#   1.  Drive → GCS にアップされた PDF を受信   (Cloud Storage イベント)
#   2.  Gemini で構造化 JSON を生成（リトライ & サイズ制限）
#   3.  会社名 × ポジション名 をキーに
#        ├ 既存行があれば UPDATE
#        └ 無ければ APPEND（A 列連番を採番）
#   4.  Google スプレッドシートへ反映
# ──────────────────────────────────────────────────────────────
import functions_framework
import os, json, time, unicodedata, re, google.auth
from googleapiclient.discovery import build
from google.cloud import storage
import google.generativeai as genai

# ─────────────────────────────
# 0. 設定
# ─────────────────────────────
PROMPT_GCS_PATH = "scout-system-config/prompt-job-extract.txt"      # プロンプト置き場
SPREADSHEET_ID  = "14zSdCGQ9OnPzdiMOjZzQeAYj259JyB5Jk_I19EAG4Y8"    # スプシ ID
SHEET_NAME      = "Job_Database"                                    # タブ名
PDF_MAX_BYTES   = 2 * 1024 * 1024                                   # 2 MiB 以上はスキップ
MAX_RETRY       = 3                                                 # Gemini 呼び出しリトライ

SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/generative-language",
]

# ─────────────────────────────
# 1. 認証 & クライアント初期化
# ─────────────────────────────
creds, _        = google.auth.default()
creds           = creds.with_scopes(SCOPES)
storage_client  = storage.Client(credentials=creds)
sheets_service  = build("sheets", "v4", credentials=creds)
genai.configure(credentials=creds)
model           = genai.GenerativeModel("gemini-1.5-flash-latest")

# ─────────────────────────────
# 2. プロンプト読み込み（起動時 1 回）
# ─────────────────────────────
_bucket, _blob  = PROMPT_GCS_PATH.split("/", 1)
PROMPT_BASE     = storage_client.bucket(_bucket).blob(_blob).download_as_text()

# ─────────────────────────────
# 3. ユーティリティ
# ─────────────────────────────
def canon(txt: str) -> str:
    """全角→半角・空白削除・lowercase"""
    if not txt: return ""
    txt = unicodedata.normalize("NFKC", txt)
    txt = re.sub(r"\s+", "", txt)
    return txt.lower()

def ask_gemini(pdf: bytes) -> dict:
    """Gemini に JSON 抽出をリトライ付きで依頼"""
    prompt = PROMPT_BASE + "\n\n# 実行\n指示に従い JSON で返してください。"
    for n in range(1, MAX_RETRY + 1):
        try:
            resp = model.generate_content(
                [prompt, {"mime_type": "application/pdf", "data": pdf}]
            )
            return json.loads(resp.text.strip().removeprefix("```json").removesuffix("```"))
        except Exception as e:
            if n == MAX_RETRY:
                raise
            backoff = 2 ** n
            print(f"[Retry {n}] Gemini failed ({e}), sleep {backoff}s")
            time.sleep(backoff)

# ─────────────────────────────
# 4. Cloud Storage → Cloud Run ハンドラ
# ─────────────────────────────
@functions_framework.cloud_event
def process_storage_event(cloud_event):
    try:
        info        = cloud_event.data
        bucket_name = info.get("bucket")
        file_name   = info.get("name")
        if not bucket_name or not file_name:
            print(f"[Skip] invalid event {info}")
            return "Invalid event", 200

        blob = storage_client.bucket(bucket_name).blob(file_name)
        if blob.size and blob.size > PDF_MAX_BYTES:
            print(f"[Skip] {file_name} too large ({blob.size} bytes)")
            return "File too large", 200

        print(f"[Start] {file_name}")
        pdf_bytes = blob.download_as_bytes()

        job = ask_gemini(pdf_bytes)

        # 既存行を読み込む
        sheet  = sheets_service.spreadsheets()
        values = sheet.values().get(
            spreadsheetId=SPREADSHEET_ID, range=f"{SHEET_NAME}!A:C"
        ).execute().get("values", [])
        header, rows = (values[0], values[1:]) if values else ([], [])

        key_map = {
            (canon(r[1]), canon(r[2])): idx + 2      # 1 行目はヘッダー
            for idx, r in enumerate(rows) if len(r) >= 3
        }
        key = (canon(job["company_name"]), canon(job["position_name"]))
        row_idx = key_map.get(key)

        # Job_ID 決定
        if row_idx:
            job["job_id"] = rows[row_idx - 2][0] or "0"
        else:
            ids = [int(r[0]) for r in rows if r and r[0].isdigit()]
            job["job_id"] = str(max(ids, default=0) + 1)

        # 行データ整形
        row = [
            job["job_id"],
            job.get("company_name", ""),
            job.get("position_name", ""),
            job.get("status", "募集中"),
            job.get("job_summary", ""),
            job.get("work_location", ""),
            job.get("salary_range", ""),
            "\n".join(job.get("required_skills", [])),
            "\n".join(job.get("preferred_skills", [])),
            job.get("ideal_candidate_profile", ""),
            "\n".join(job.get("appeal_points", [])),
        ]

        if row_idx:
            sheet.values().update(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_NAME}!A{row_idx}:K{row_idx}",
                valueInputOption="USER_ENTERED",
                body={"values": [row]},
            ).execute()
            print(f"[Update] id={job['job_id']} row={row_idx}")
        else:
            sheet.values().append(
                spreadsheetId=SPREADSHEET_ID,
                range=f"{SHEET_NAME}!A1",
                valueInputOption="USER_ENTERED",
                body={"values": [row]},
            ).execute()
            print(f"[Append] id={job['job_id']}")

        return "OK", 200

    except Exception as e:
        print(f"[Error] {e}")
        return f"Error: {e}", 500

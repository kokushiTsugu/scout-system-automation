# main.py – Cloud Run / Flask（生成もサーバ側に集約 / v1 + 2.5 系 / timeout & fallback）
import os
import re
import json
import time
import functools
from typing import List, Dict, Any

from flask import Flask, request, jsonify

# --- Google Sheets (timeout付きhttplib2で安定化) ---
import google.auth
from googleapiclient.discovery import build
import httplib2
import google_auth_httplib2

# --- Embedding: google-genai v1 client ---
from google import genai as genai_v1

# --- NumPy for similarity ---
import numpy as np


# =========================
# Env / Clients
# =========================
SPREADSHEET_ID = os.getenv("SPREADSHEET_ID", "")
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
creds, _ = google.auth.default(scopes=SCOPES)

# Sheets: per-request ではなく Http 生成時に timeout 指定
_http = google_auth_httplib2.AuthorizedHttp(creds, http=httplib2.Http(timeout=30))
sheets = build("sheets", "v4", http=_http)

# APIキーは GEMINI_API_KEY 優先、なければ GOOGLE_API_KEY
_API_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY", "")
CLIENT = genai_v1.Client(api_key=_API_KEY)

# 生成モデル（既定は 2.5-flash。必要なら ENV で切替）
MODEL_FLASH = os.getenv("MODEL_FLASH", "gemini-2.5-flash")

app = Flask(__name__)


# =========================
# Utilities
# =========================
@functools.lru_cache
def load_jobs() -> List[Dict[str, Any]]:
    """Job_Database!A:K から最大 50 件だけ取得（メモリ節約）"""
    vals = (
        sheets.spreadsheets()
        .values()
        .get(spreadsheetId=SPREADSHEET_ID, range="Job_Database!A:K")
        .execute()
        .get("values", [])
    )
    vals = vals[1:51]  # ヘッダー除外 & 上限
    return [
        dict(
            id=r[0],
            company=r[1],
            title=r[2],
            status=r[3],
            summary=r[4] if len(r) > 4 else "",
            loc=r[5] if len(r) > 5 else "",
            salary=r[6] if len(r) > 6 else "",
        )
        for r in vals
        if len(r) > 6 and r[3] == "募集中"
    ]


@functools.lru_cache(maxsize=1_024)
def _embed_cached(text: str) -> tuple:
    """Embedding API（結果は tuple 化してキャッシュ）"""
    vec = _embed_once(text)
    return tuple(vec)


def embed(text: str) -> np.ndarray:
    return np.array(_embed_cached(text))


def strip_fence(txt: str) -> str:
    """``` で囲まれている場合に中身だけ取り出す"""
    if txt is None:
        return ""
    s = txt.strip()
    if s.startswith("```"):
        s = s.split("```", 1)[1]
        if "```" in s:
            s = s.rsplit("```", 1)[0]
    return s.strip()


# =========================
# Health
# =========================
@app.route("/healthz")
def healthz():
    return "ok", 200


# =========================
# Endpoints
# =========================
@app.route("/match", methods=["POST"])
def match():
    mode = (request.args.get("mode", "scout") or "").lower()
    body = request.get_json(silent=True)
    if not body or "candidate" not in body:
        return jsonify(error="candidate required"), 400

    cand = body["candidate"]
    try:
        if mode == "inmail":
            result = inmail_flow(body)
        elif mode == "scout":
            if body.get("prompt"):
                result = inmail_flow(body)
            else:
                result = scout_flow(cand)
        elif mode == "proposal":
            result = proposal_flow(cand)
        else:
            return jsonify(error="mode must be scout|proposal"), 400
        return jsonify(result), 200
    except ValueError as ve:
        return jsonify(error=str(ve)), 400
    except Exception as e:
        app.logger.exception("match() failed")
        return jsonify(error=str(e)), 500


# =========================
# Flows
# =========================
def scout_flow(cand: dict) -> Dict[str, Any]:
    jobs = load_jobs()

    # 1) embedding 類似度
    c_src = cand.get("linkedin_profile", "")
    c_vec = embed(json.dumps(c_src))
    sims = [(j, float(np.dot(c_vec, embed(j["summary"])))) for j in jobs]
    top20 = sorted(sims, key=lambda x: -x[1])[:20]

    # 2) 2.5 Flash で 2 件 pick（REST v1）
    prompt = f"""
下記候補者 LinkedIn と求人20件から、最もクリック率が高そうな2件だけ JSONで返して。
キーは id,title,company_desc,salary の4項目のみ。
### CAND
{c_src}
### JOBS
{json.dumps([j for j, _ in top20], ensure_ascii=False)}
""".strip()
    txt = strip_fence(_gen_text_v1(prompt, MODEL_FLASH))
    try:
        data = json.loads(txt)
    except json.JSONDecodeError:
        app.logger.warning("Flash JSON parse error: %s …", txt[:200])
        data = []

    # Flash が dict 形式 or list 形式どちらでも拾う
    if isinstance(data, dict):
        positions = data.get("selected_positions", [])[:2]
    elif isinstance(data, list):
        positions = data[:2]
    else:
        positions = []

    # フォールバック：何も取れなかったら類似度 Top2
    if not positions:
        positions = [j for j, _ in top20[:2]]

    # 3) クリック率スコア（簡易）
    click = int(50 + 50 * np.tanh(sum(s for _, s in top20[:2])))

    # 4) 友達申請メッセージをサーバ側で生成（300字以内）
    full_name = (cand.get("name") or "").strip()
    fr_prompt = _build_friend_request_prompt(full_name, positions[:2])
    try:
        note = _gen_text_v1(fr_prompt, MODEL_FLASH, temperature=0.4, max_tokens=320)
        # URL保全 → 体裁正規化（空行除去）
        note = _ensure_url_tail(note, "https://calendly.com/k-nagase-tsugu/_linked-in-fr", 300)
        note = _tidy_note(note)
    except Exception as e:
        app.logger.warning(f"[GEN-FR] fallback local due to {e}")
        # 最終フォールバック：ローカル整形（確実に返す）
        note = _friend_request_local(full_name, positions[:2])
        note = _tidy_note(note)

    return {
        "selected_positions": positions[:2],
        "click_score": click,
        "friend_request_note": note
    }


def proposal_flow(cand: dict) -> Dict[str, Any]:
    jobs = load_jobs()
    must = str(cand.get("must", "")).strip()

    # 1) 年収フィルタ（最低年収のような使い方、ざっくり）
    filtered = jobs
    if must.isdigit():
        filtered = [
            j for j in jobs
            if j["salary"] and j["salary"][:4].isdigit()
            and int(must) <= int(j["salary"][:4])
        ][:50]

    # 2) 2.5 Flash で ID 絞り込み
    flash_p = f"""
候補者履歴書と求人リスト。must条件を満たさない求人は除外し、20件以内に絞ってID配列を返せ
### MUST
{must}
### CAND
{cand.get('resume', '')[:1500]}
### JOBS
{json.dumps(filtered, ensure_ascii=False)}
""".strip()
    keep_ids_json = strip_fence(_gen_text_v1(flash_p, MODEL_FLASH))
    try:
        keep_ids = json.loads(keep_ids_json)
    except Exception:
        app.logger.warning("Flash keep_ids parse error: %s …", keep_ids_json[:200])
        keep_ids = []
    subset = [j for j in filtered if j["id"] in keep_ids][:20]

    # 3) 2.5 Flash でスコアリング（REST v1）
    pro_p = f"""
候補者要約と求人を読み、overall_score,candidate_fit,company_fit を100点満点で付与し JSON配列返却。
### CAND
{cand.get('resume', '')[:2000]}
### JOBS
{json.dumps(subset, ensure_ascii=False)}
""".strip()
    scored_json = strip_fence(_gen_text_v1(pro_p, MODEL_FLASH))
    try:
        scored = json.loads(scored_json)
        scored = sorted(scored, key=lambda x: -x.get("overall_score", 0))[:5]
    except Exception:
        app.logger.warning("Flash scoring parse error: %s …", scored_json[:200])
        scored = subset[:5]
    return {"selected_positions": scored}


def inmail_flow(body: dict) -> Dict[str, Any]:
    """Generate inMail content via Gemini using a pre-built prompt from GAS."""
    prompt = body.get("prompt", "")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt required for inmail flow")

    options = body.get("options") or {}
    temperature = options.get("temperature", 0.4)
    try:
        temperature = float(temperature)
    except Exception:
        temperature = 0.4

    max_output = (
        options.get("maxOutput")
        or options.get("max_output")
        or options.get("max_tokens")
        or options.get("maxTokens")
        or 1024
    )
    try:
        max_output = int(max_output)
    except Exception:
        max_output = 1024

    raw = _gen_text_v1(prompt, MODEL_FLASH, temperature=temperature, max_tokens=max_output)
    clean = strip_fence(raw)
    try:
        parsed = json.loads(clean)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"inmail JSON parse error: {clean[:200]}") from exc

    if not isinstance(parsed, dict):
        raise RuntimeError("inmail response must be a JSON object")

    positions = parsed.get("positions")
    if not isinstance(positions, list) or not positions:
        raise RuntimeError("inmail JSON missing positions array")

    sanitized_positions = []
    for pos in positions:
        if not isinstance(pos, dict):
            continue
        sanitized_positions.append(
            {
                "id": str(pos.get("id") or ""),
                "title": str(pos.get("title") or ""),
                "company_desc": str(pos.get("company_desc") or pos.get("company") or ""),
                "salary": str(pos.get("salary") or ""),
                "appeal_points": (
                    pos.get("appeal_points")
                    if isinstance(pos.get("appeal_points"), list)
                    else (
                        [str(pos.get("appeal_points"))]
                        if pos.get("appeal_points")
                        else []
                    )
                ),
            }
        )

    sanitized_positions = [p for p in sanitized_positions if any([p["title"], p["company_desc"], p["salary"], p["appeal_points"]])]

    if not sanitized_positions:
        raise RuntimeError("inmail JSON positions missing required fields")

    subject = parsed.get("subject")
    intro = parsed.get("intro_sentence") or parsed.get("intro")
    closing = parsed.get("closing_sentence") or parsed.get("closing")

    if not all(isinstance(x, str) and x.strip() for x in [subject, intro, closing]):
        raise RuntimeError("inmail JSON missing subject/intro/closing")

    return {
        "positions": sanitized_positions,
        "subject": subject.strip(),
        "intro_sentence": intro.strip(),
        "closing_sentence": closing.strip(),
    }


# =========================
# Prompt Builders & Formatters
# =========================
def _normalize_salary(s: str) -> str:
  """給与表記を軽く正規化（~, - を en dash に置換 / スペース・カンマ除去）"""
  if not s: return ""
  t = s.replace(" ", "").replace(",", "")
  t = t.replace("~", "–").replace("-", "–")
  return t

def _soft_title(title: str) -> str:
  """職種タイトルの“オブラート化”：固有語や冗長記号を薄めつつ意味は保持。"""
  if not title: return ""
  t = title
  t = re.sub(r'【.*?】', '', t)                        # 先頭の【…】除去
  t = re.sub(r'（.*?）|\(.*?\)', '', t)                # 括弧内除去
  t = re.sub(r'「.*?」', '', t)                        # 全角引用符内を除去
  t = re.sub(r'[/｜|].*$', '', t)                      # 区切り以降（勤務地/出社条件など）を落とす
  t = t.replace("新規事業", "")
  t = t.replace("テクニカルプロダクトマネージャー", "テクニカルPdM")
  t = re.sub(r'\s+', ' ', t).strip(' -｜|/')
  return t.strip()

def _derive_role(title: str, summary: str) -> str:
  """タイトル/サマリから“伝わる役割名”を抽出（優先順マッチ）。見つからなければsoft title。"""
  hay = f"{title} {summary}"
  rules = [
    (r'インサイド.?セールス|Inside\s*Sales|IS\b', 'インサイドセールス'),
    (r'テクニカル.?PdM|プロダクトマネージャ|PdM\b', 'テクニカルPdM'),
    (r'プロダクト.?マネージャ|Product\s*Manager', 'PdM'),
    (r'事業開発|Biz\s*Dev|BD\b', '事業開発'),
    (r'カスタマー.?サクセス|Customer\s*Success|CS\b', 'カスタマーサクセス'),
    (r'マーケティング|Marketing|Growth', 'マーケティング'),
    (r'セールス|営業', 'セールス'),
    (r'ソフトウェア|SWE|エンジニア|バックエンド|フロントエンド|フルスタック', 'ソフトウェアエンジニア'),
    (r'データサイエンティスト|Data\s*Scientist', 'データサイエンティスト'),
    (r'プロジェクトマネージャ|PM\b', 'プロジェクトマネージャ'),
    (r'プロダクトオーナー|PO\b', 'プロダクトオーナー'),
  ]
  for pat, lab in rules:
    if re.search(pat, hay, flags=re.I):
      return lab
  soft = _soft_title(title)
  return soft or ""

def _format_job_line(job: Dict[str, Any]) -> str:
  """◆役割｜給与 を確実に作る（役割名が空でもデフォルトを入れる）"""
  role = _derive_role(job.get("title",""), job.get("summary",""))
  salary = _normalize_salary(job.get("salary",""))
  if not role: role = "コアメンバー"
  return f'◆{role}｜{salary}'

def _ensure_url_tail(text: str, url: str, limit: int = 300) -> str:
  """URLが必ずフルで末尾に残るよう、本文を先にトリムしてから URL を足す。"""
  if not text: return url
  base = text.strip()
  if base.endswith(url): return base[:limit]
  room = max(0, limit - (len(url) + 1))  # 改行分+1
  if len(base) > room:
    base = base[:max(0, room - 1)] + "…"
  return f"{base}\n{url}"

def _tidy_note(text: str) -> str:
  """体裁正規化：連続改行を圧縮し、◆行の直前の空行を削除、見出し直後の空行も削除"""
  if not text: return text
  s = text.strip()
  s = re.sub(r'\n{3,}', '\n\n', s)               # 3つ以上の連続改行 → 2つへ
  s = re.sub(r'(―厳選求人例―)\n\s*\n', r'\1\n', s)  # 見出し直後の空行削除
  s = re.sub(r'\n\s*\n(◆)', r'\n\1', s)          # ◆行直前の空行削除
  return s

def _build_friend_request_prompt(full_name: str, positions: List[Dict[str, Any]]) -> str:
  """構成要素を与え、モデルに“結合だけ”をさせる（役割名はサーバで確定）"""
  last_name = (full_name or "").split()[-1] if full_name else ""
  p1 = positions[0] if positions else {}
  p2 = positions[1] if len(positions) > 1 else None

  job1 = _format_job_line(p1)
  job2 = _format_job_line(p2) if p2 else ""

  intro = (
      f'ハイクラス向け人材紹介会社"TSUGU"代表の服部です。'
      f'{last_name}様のご経歴を拝見し、ぜひご紹介したい求人がございます。'
  )
  calendly = "https://calendly.com/k-nagase-tsugu/_linked-in-fr"

  return f"""
あなたは提供された「構成要素」を、以下の「組み立て手順」に100%従って結合するボットです。余計な語句は一切追加しません。

# 組み立て手順
1.{{greeting}}
2.{{subject}}
3.{{introduction}}
(空行)
4.{{job_section_header}}
5.{{job_line_1}}
6.{{job_line_2}}
(空行)
7.{{closing_line_1}}
8.{{closing_line_2}}
(空行)
9.{{call_to_action}}
10.{{link}}

# 構成要素
{{greeting}}: "{last_name}様"
{{subject}}: "【国内トップ層向け案件紹介】"
{{introduction}}: "{intro}"
{{job_section_header}}: "―厳選求人例―"
{{job_line_1}}: "{job1}"
{{job_line_2}}: "{job2}"
{{closing_line_1}}: "いずれも裁量大きく、事業成長を牽引できるポジションです。"
{{closing_line_2}}: "他にも100社以上の非公開求人を扱っております。"
{{call_to_action}}: "ご興味あれば、面談をお願いいたします。"
{{link}}: "{calendly}"

# 絶対ルール
- 手順・構成要素にない語句や記号、絵文字を追加しない。
- 完成メッセージ本文だけを300文字以内で出力。説明・コードフェンス禁止。
""".strip()

def _friend_request_local(full_name: str, positions: List[Dict[str, Any]]) -> str:
  """最終フォールバック（役割名正規化＆URL保全＆空行正規化）"""
  last_name = (full_name or "").split()[-1] if full_name else ""
  p1 = positions[0] if positions else {}
  p2 = positions[1] if len(positions) > 1 else None
  line1 = _format_job_line(p1)
  line2 = _format_job_line(p2) if p2 else ""
  jobs_block = "\n".join([l for l in [line1, line2] if l.strip()])
  calendly = "https://calendly.com/k-nagase-tsugu/_linked-in-fr"

  prefix = (
      f"{(last_name + '様') if last_name else ''}\n【国内トップ層向け案件紹介】\n"
      f"ハイクラス向け人材紹介会社\"TSUGU\"代表の服部です。ご経歴を拝見し、ぜひご紹介したい求人がございます。\n"
      f"―厳選求人例―\n{jobs_block}\n"
      f"ご興味あれば、面談をお願いいたします。\n"
  )
  return _ensure_url_tail(_tidy_note(prefix), calendly, 300)


# =========================
# Embedding helpers
# =========================
def _to_vec(resp):
    """EmbedContentResponse / dict のどちらでも [float] を返す"""
    # dict 形（旧SDK互換）
    if isinstance(resp, dict):
        if "embedding" in resp:
            emb = resp["embedding"]
            if isinstance(emb, dict) and "values" in emb:
                return emb["values"]
            if isinstance(emb, list):
                return emb
        if "embeddings" in resp and resp["embeddings"]:
            emb0 = resp["embeddings"][0]
            if isinstance(emb0, dict) and "values" in emb0:
                return emb0["values"]
            if isinstance(emb0, list):
                return emb0
    # v1 オブジェクト
    if hasattr(resp, "embeddings") and getattr(resp, "embeddings"):
        emb0 = resp.embeddings[0]
        if hasattr(emb0, "values"):
            return list(emb0.values)
    if hasattr(resp, "embedding") and hasattr(resp.embedding, "values"):
        return list(resp.embedding.values)
    raise ValueError(f"Unexpected embedding response shape: {type(resp)} -> {resp}")

def _embed_once(text: str):
    # v1 Client で contents= フォーマット
    r = CLIENT.models.embed_content(
        model="text-embedding-004",
        contents=[{"role": "user", "parts": [{"text": text}]}],
    )
    return _to_vec(r)


# =========================
# v1 Models helper
# =========================
_LISTED_MODELS = None
def _list_models_v1():
    """このAPIキーで見える v1/v1beta モデル一覧（キャッシュ）"""
    global _LISTED_MODELS
    if _LISTED_MODELS is not None:
        return _LISTED_MODELS

    import requests

    def _fetch(version: str):
        url = f"https://generativelanguage.googleapis.com/{version}/models?key={_API_KEY}"
        resp = requests.get(url, timeout=30)
        if not resp.ok:
            print(f"[MODELS] list {version} failed: {resp.status_code} {resp.text[:300]}")
            return []
        data = resp.json()
        models = data.get("models") or []
        gen = [
            m.get("name", "").split("/")[-1]
            for m in models
            if "generateContent" in (m.get("supportedGenerationMethods") or [])
        ]
        print(f"[MODELS] {version} generateContent-capable: {gen}")
        return models

    models = _fetch("v1")
    if not models:
        models = _fetch("v1beta")

    _LISTED_MODELS = models
    return _LISTED_MODELS

def _pick_model_for_generate():
    """
    ListModels の中から generateContent をサポートするモデルを優先順で選ぶ。
    優先: 2.5 → 2.0 → 1.5 → 1.0
    """
    models = _list_models_v1()
    def ok(m): return "generateContent" in (m.get("supportedGenerationMethods") or [])
    names = [(m.get("name", "").split("/")[-1], m) for m in models if ok(m)]
    order = [
        # 2.5
        "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro",
        # 2.0
        "gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite",
        "gemini-2.0-flash-preview-image-generation",
        # 1.5
        "gemini-1.5-flash-8b-latest", "gemini-1.5-flash-latest",
        "gemini-1.5-flash-002", "gemini-1.5-flash",
        "gemini-1.5-pro-latest", "gemini-1.5-pro-001", "gemini-1.5-pro",
        # 1.0
        "gemini-1.0-pro-latest", "gemini-1.0-pro",
    ]
    for want in order:
        for nm, _ in names:
            if nm == want:
                return nm
    for pref in ["gemini-2.5", "gemini-2.0", "gemini-1.5", "gemini-1.0"]:
        for nm, _ in names:
            if nm.startswith(pref):
                return nm
    if names:
        return names[0][0]
    raise RuntimeError("No model with generateContent is visible for this API key")


# =========================
# v1 Text generation (timeout & fallback)
# =========================
def _gen_text_v1(
    prompt: str,
    model: str = None,
    temperature: float = 0.4,
    max_tokens: int = 512
) -> str:
    """
    v1 REST generateContent。
    モデルは 引数 > 環境 MODEL_FLASH > ListModels > 既知バックアップ の順で試行。
    Timeout時は flash-lite に自動フォールバック。
    """
    import requests

    if not _API_KEY:
        raise RuntimeError("GEMINI_API_KEY/GOOGLE_API_KEY is not set")

    candidates = []
    if model:
        candidates.append(model)
    if MODEL_FLASH and MODEL_FLASH not in candidates:
        candidates.append(MODEL_FLASH)
    try:
        picked = _pick_model_for_generate()
        if picked not in candidates:
            candidates.append(picked)
    except Exception as e:
        print(f"[MODELS] pick failed: {e}")

    for b in [
        "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro",
        "gemini-2.0-flash", "gemini-2.0-flash-001", "gemini-2.0-flash-lite",
        "gemini-1.5-flash-latest", "gemini-1.5-flash-002",
        "gemini-1.5-pro-latest", "gemini-1.5-pro",
    ]:
        if b not in candidates:
            candidates.append(b)

    seen, last = set(), None
    versions = ("v1", "v1beta")
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens}
    }

    def _post_model(model_name: str, version: str):
        url = (
            f"https://generativelanguage.googleapis.com/"
            f"{version}/models/{model_name}:generateContent?key={_API_KEY}"
        )
        return requests.post(url, json=body, timeout=(10, 60))

    def _handle_response(model_name: str, version: str):
        nonlocal last
        r = _post_model(model_name, version)
        if r.status_code in (429, 500, 503):
            time.sleep(0.5)
            r = _post_model(model_name, version)
        if not r.ok:
            last = f"{model_name}@{version} -> {r.status_code} {r.text[:300]}"
            print(f"[GEN] {last}")
            return None, r.status_code == 404
        data = r.json()
        cands = (data.get("candidates") or [])
        if cands:
            parts = (cands[0].get("content") or {}).get("parts") or []
            if parts and isinstance(parts[0], dict) and "text" in parts[0]:
                print(f"[GEN] ok via {model_name}@{version}")
                return parts[0]["text"].strip(), False
        last = f"{model_name}@{version} -> unexpected shape {json.dumps(data)[:300]}"
        print(f"[GEN] {last}")
        return None, False

    def _flash_lite_fallback(primary_version: str):
        order = (primary_version,) + tuple(v for v in versions if v != primary_version)
        for ver in order:
            try:
                text, retry_next = _handle_response("gemini-2.5-flash-lite", ver)
                if text:
                    return text
                if retry_next:
                    continue
            except requests.exceptions.Timeout:
                print(f"[GEN] gemini-2.5-flash-lite@{ver} -> Timeout")
                continue
        return None

    for mdl in [c for c in candidates if not (c in seen or seen.add(c))]:
        for version in versions:
            try:
                text, retry_next = _handle_response(mdl, version)
                if text:
                    return text
                if retry_next:
                    continue  # 該当モデルの別バージョンを試す
                break  # 404 以外のエラーは次のモデルへ
            except requests.exceptions.Timeout:
                if mdl != "gemini-2.5-flash-lite":
                    print(f"[GEN] {mdl}@{version} -> Timeout. fallback to flash-lite")
                    fallback_text = _flash_lite_fallback(version)
                    if fallback_text:
                        return fallback_text
                    last = f"flash-lite fallback failed after timeout ({mdl}@{version})"
                    print(f"[GEN] {last}")
                    continue
                last = f"{mdl}@{version} -> Timeout"
                print(f"[GEN] {last}")
                break
        else:
            continue
    raise RuntimeError(f"REST v1 generateContent failed. last={last}; tried={candidates}")


# =========================
# Debug endpoint
# =========================
def _debug_models_v1():
    """ListModels のうち generateContent 対応モデル名一覧を返す"""
    try:
        models = _list_models_v1()
        gen = [
            m.get("name", "").split("/")[-1]
            for m in models
            if "generateContent" in (m.get("supportedGenerationMethods") or [])
        ]
        return {"generateContent": gen}, 200
    except Exception as e:
        return {"error": str(e)}, 500


# 二重登録で落ちないように、add_url_rule で endpoint 名を固定・例外も握る
try:
    app.add_url_rule("/debug/models", endpoint="debug_models_v1",
                     view_func=_debug_models_v1, methods=["GET"])
except Exception as _e:
    print(f"[DEBUG] route /debug/models already set or failed: {_e}")


# =========================
# Error handler
# =========================
@app.errorhandler(Exception)
def _app_error(e):
    import traceback, sys
    tb = "".join(traceback.format_exception(*sys.exc_info()))
    print(tb)
    try:
        return jsonify({"error": str(e)}), 500
    except Exception:
        return {"error": str(e)}, 500


# =========================
# Local debug
# =========================
if __name__ == "__main__":
    app.run("0.0.0.0", port=8080, debug=True)

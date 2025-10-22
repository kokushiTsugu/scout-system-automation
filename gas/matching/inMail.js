/* =====================================================================
 * スカウト自動化スクリプト v2025-06-19 (COO面談対応版)
 * ---------------------------------------------------------------------
 * 【主な変更点】
 * - 宛名を「姓」のみに自動抽出
 * - 紹介ポジションのフォーマットを目標スタイルに変更
 * - プロンプトを Few-shot 形式に刷新し、文章の質を向上
 * ===================================================================== */

// ===== Feature toggle =====
const USE_MATCH_API = true; // false で従来（Gemini直叩き）へフォールバック

// ===== Match API endpoint =====
const MATCH_API_BASE = (function() {
  const base = (typeof MATCH_URL_FR_ONLY === 'string' && MATCH_URL_FR_ONLY)
    ? MATCH_URL_FR_ONLY.split('?')[0]
    : null;
  return base || 'https://match-api-650488873290.asia-northeast1.run.app/match';
})();
const MATCH_API_URL_INMAIL = MATCH_API_BASE + '?mode=inmail';

// ===== Logging / Build Tag =====
const BUILD_TAG_INMAIL = 'inMail via match-api v2025-10-21';
function _rid(){ return Utilities.getUuid(); }
function _log(...args){ console.log(`[${BUILD_TAG_INMAIL}]`, ...args); }

/* ===== 1. 固定値 ===== */
const SHEET_JOBS   = 'Job_Database';
const SHEET_CANDS  = 'Candidate_Pipeline';
const MAX_BATCH    = 15;

const PER_ITEM_INTERVAL_MS = 1800;
const DEADLINE_MS = 8 * 60 * 1000;
const PROFILE_MAX_CHARS = 6000;
const JOB_CATALOG_MAX_JOBS = 40;
const JOB_CATALOG_MAX_CHARS = 60000;

function rateLimitSleep(baseMs){
  const jitter = Math.floor(Math.random() * 400); // 0〜399ms → 1.8〜2.2秒程度
  Utilities.sleep(baseMs + jitter);
}

function clampText(value, maxChars) {
  const text = String(value == null ? '' : value);
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)) + '…';
}

function normalizeProfileText(profile) {
  const original = String(profile == null ? '' : profile);
  const normalized = original
    .replace(/\r\n?/g, '\n')
    .replace(/[\u3000\t]+/g, ' ')
    .trim();
  const clamped = clampText(normalized, PROFILE_MAX_CHARS);
  return {
    text: clamped,
    truncated: normalized.length > PROFILE_MAX_CHARS,
    originalLength: original.length,
    normalizedLength: normalized.length,
  };
}

function shrinkJobForPrompt(job, perFieldLimit) {
  const limit = perFieldLimit || 400;
  const result = {};
  Object.keys(job || {}).forEach(key => {
    const value = job[key];
    if (typeof value === 'string') {
      result[key] = clampText(value, limit);
    } else if (Array.isArray(value)) {
      result[key] = value.slice(0, 4).map(item => (
        typeof item === 'string' ? clampText(item, Math.floor(limit / 2)) : item
      ));
    } else {
      result[key] = value;
    }
  });
  return result;
}

function prepareCatalogForPrompt(catalog) {
  const maxJobs = JOB_CATALOG_MAX_JOBS;
  const maxChars = JOB_CATALOG_MAX_CHARS;
  const subset = catalog.slice(0, maxJobs);
  let truncated = subset.length < catalog.length;
  let arrayForPrompt = subset.map(job => Object.assign({}, job));
  let payload = JSON.stringify(arrayForPrompt);

  if (payload.length > maxChars) {
    arrayForPrompt = subset.map(job => shrinkJobForPrompt(job, 320));
    payload = JSON.stringify(arrayForPrompt);
    truncated = true;
  }

  while (payload.length > maxChars && arrayForPrompt.length > 1) {
    arrayForPrompt.pop();
    payload = JSON.stringify(arrayForPrompt);
    truncated = true;
  }

  if (payload.length > maxChars && arrayForPrompt.length === 1) {
    arrayForPrompt = [shrinkJobForPrompt(arrayForPrompt[0], 200)];
    payload = JSON.stringify(arrayForPrompt);
  }

  return {
    list: arrayForPrompt,
    payload,
    truncated,
    kept: arrayForPrompt.length,
    approxChars: payload.length,
  };
}

function createWatchdog(){
  const start = Date.now();
  return function guard(){
    if (Date.now() - start > DEADLINE_MS) {
      throw new Error('timeout watchdog');
    }
  };
}

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// テスト手順メモ:
// 1. 対象配列を 1 件に絞り単発実行 → RID/ログを Apps Script Executions で確認。
// 2. 問題なければ 5 件 → 10 件と段階的に拡大（処理間隔は自動で 1.8〜2.2 秒）。
// 3. 必要に応じて PER_ITEM_INTERVAL_MS を 2000 などへ調整してリリース。

function postMatchApiWithBackoff(url, payload, headers, maxRetries = 6) {
  let attempt = 0;
  while (true) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    const body = res.getContentText();

    if (code === 200) return JSON.parse(body || '{}');

    if (code === 429) {
      const headerSource = res.getAllHeaders ? res.getAllHeaders() : (res.getHeaders ? res.getHeaders() : null);
      const retryHeader = headerSource && (headerSource['Retry-After'] || headerSource['retry-after']);
      let ms = retryHeader ? Math.ceil(parseFloat(retryHeader) * 1000) : 0;
      if (!ms) {
        const m = body.match(/retry in ([\d.]+)s/i);
        if (m) ms = Math.ceil(parseFloat(m[1]) * 1000);
      }
      if (!ms) ms = Math.min(30000, 500 * Math.pow(2, attempt));
      _log(`429 -> sleep ${ms}ms (attempt=${attempt})`);
      Utilities.sleep(ms);
    } else if (code >= 500 && code < 600) {
      if (attempt >= maxRetries) throw new Error(`match-api 5xx(${code}) after retries: ${body}`);
      const ms = Math.min(30000, 500 * Math.pow(2, attempt));
      _log(`5xx(${code}) -> sleep ${ms}ms (attempt=${attempt})`);
      Utilities.sleep(ms);
    } else {
      _log('error resp', String(body).slice(0, 500));
      throw new Error(`match-api Error ${code}: ${body}`);
    }
    attempt++;
    if (attempt > maxRetries) throw new Error(`match-api Retry exceeded: ${body}`);
  }
}

function adaptMatchApiInMailResponse(res){
  if (res == null) throw new Error('match-api empty response');

  let rawText = '';
  let payload = null;

  const trySetFrom = value => {
    if (value == null) return false;
    if (typeof value === 'string') {
      rawText = value.trim();
      try {
        payload = JSON.parse(rawText);
      } catch (e) {
        // ignore JSON parse failure; keep rawText for caller
      }
      return true;
    }
    if (typeof value === 'object') {
      payload = value;
      rawText = JSON.stringify(value);
      return true;
    }
    return false;
  };

  if (typeof res === 'string') {
    trySetFrom(res);
  } else if (typeof res === 'object') {
    const order = [
      res.result?.json,
      res.result?.text,
      res.result?.body,
      res.response?.json,
      res.response?.text,
      res.data,
      res.raw,
      res.text,
    ];
    for (const candidate of order) {
      if (trySetFrom(candidate)) break;
    }
    if (!rawText && !payload) {
      if (!trySetFrom(res)) {
        trySetFrom(res.result);
      }
    }
  }

  if (!rawText) {
    if (payload) {
      rawText = JSON.stringify(payload);
    } else {
      throw new Error('match-api response missing text payload');
    }
  }

  if (!payload) {
    try {
      payload = JSON.parse(rawText);
    } catch (e) {
      throw new Error('match-api response is not valid JSON');
    }
  }

  return { rawText, payload };
}

function normalizeInMailPayload(payload, rawText) {
  const seen = [];
  const queue = [];

  const enqueue = value => {
    if (value == null) return;
    queue.push(value);
  };

  const parseString = text => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    const withoutFence = trimmed.startsWith('```')
      ? trimmed.replace(/^```[a-zA-Z0-9_+-]*\n?/, '').replace(/```$/, '').trim()
      : trimmed;
    try {
      return JSON.parse(withoutFence);
    } catch (e) {
      return null;
    }
  };

  const convertSelectedToInMail = obj => {
    if (!obj || typeof obj !== 'object') return null;
    const selected = Array.isArray(obj.selected_positions) ? obj.selected_positions : null;
    if (!selected || !selected.length) return null;

    const pick = keys => {
      for (const key of keys) {
        const val = obj[key];
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
      return '';
    };

    const subject = pick(['subject', 'inmail_subject']);
    const intro = pick(['intro_sentence', 'inmail_intro', 'intro']);
    const closing = pick(['closing_sentence', 'inmail_closing', 'closing']);

    const positions = selected.map(p => ({
      id: String(p?.id || p?.job_id || ''),
      title: String(p?.title || p?.job_title || ''),
      company_desc: String(p?.company_desc || p?.company || ''),
      salary: String(p?.salary || p?.annual_salary || ''),
      appeal_points: Array.isArray(p?.appeal_points)
        ? p.appeal_points
        : (p?.appeal_points ? [String(p.appeal_points)] : []),
    })).filter(pos => pos.title || pos.company_desc || pos.salary || pos.appeal_points.length);

    if (positions.length && subject && intro && closing) {
      return {
        positions,
        subject,
        intro_sentence: intro,
        closing_sentence: closing,
      };
    }
    return null;
  };

  enqueue(payload);
  enqueue(rawText);

  while (queue.length) {
    const current = queue.shift();
    let obj = null;

    if (typeof current === 'string') {
      obj = parseString(current);
      if (!obj) continue;
    } else if (typeof current === 'object') {
      if (seen.indexOf(current) >= 0) continue;
      seen.push(current);
      obj = current;
    } else {
      continue;
    }

    if (!obj || typeof obj !== 'object') continue;

    if (Array.isArray(obj.positions) && obj.positions.length) {
      return obj;
    }

    const converted = convertSelectedToInMail(obj);
    if (converted) return converted;

    const nestedKeys = ['result', 'data', 'payload', 'response', 'friend_request_note', 'note', 'body', 'text', 'json', 'message', 'raw'];
    for (const key of nestedKeys) {
      if (obj[key] != null) {
        enqueue(obj[key]);
      }
    }
  }

  return null;
}

function runBatchScoutMatching() {
  return withScriptLock(() => _runBatchScoutMatching());
}

/* ===== 2. 補助ユーティリティ ===== */
function compactJobCatalog(jobs) {
  const squeeze = (txt, limit) => {
    if (!txt) return '';
    const flat = String(txt).replace(/[\s\u3000]+/g, ' ').trim();
    if (!limit) return flat;
    return flat.length <= limit ? flat : flat.slice(0, limit - 1) + '…';
  };

  return jobs.map(job => ({
    id      : job.id,
    company : job.company,
    title   : job.title,
    salary  : squeeze(job.salary, 60),
    summary : squeeze(job.summary, 280),
    location: squeeze(job.location, 60),
    must    : squeeze(job.must, 220),
    plus    : squeeze(job.plus, 180),
    person  : squeeze(job.person, 120),
    appeal  : squeeze(job.appeal, 160),
  }));
}

/* ===== 3. メイン処理 (修正版) ===== */
function _runBatchScoutMatching() {
  const ui        = SpreadsheetApp.getUi();
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const jobSheet  = ss.getSheetByName(SHEET_JOBS);
  const candSheet = ss.getSheetByName(SHEET_CANDS);

  /* 3-1. 募集中求人を JSON 配列化 */
  const jobJson = jobSheet.getDataRange().getValues()
    .slice(1)
    .filter(r => r[3] === '募集中')
    .map(r => ({
      id      : r[0],
      company : r[1],
      title   : r[2],
      salary  : r[6] || '応相談',
      summary : r[4],
      location: r[5],
      must    : r[7],
      plus    : r[8],
      person  : r[9],
      appeal  : r[10],
    }));

  if (!jobJson.length) {
    ui.alert('募集中求人がありません');
    return;
  }

  const compactCatalog = compactJobCatalog(jobJson);
  const catalogForPrompt = prepareCatalogForPrompt(compactCatalog);
  const jobCatalogPayload = catalogForPrompt.payload;
  const jobCatalogForApi = catalogForPrompt.list;

  /* 3-2. 候補者ループ */
  const rows    = candSheet.getDataRange().getValues();
  let   handled = 0;
  const RID = _rid();
  const guard = createWatchdog();

  _log('start', { RID, jobs: jobJson.length, rows: rows.length, promptJobs: jobCatalogForApi.length, catalogChars: jobCatalogPayload.length });
  if (catalogForPrompt.truncated) {
    _log('catalog truncated', { RID, kept: catalogForPrompt.kept, total: compactCatalog.length, approxChars: catalogForPrompt.approxChars });
  }

  for (let i = 1; i < rows.length && handled < MAX_BATCH; i++) {
    guard();
    if (rows[i][2]) continue;
    const rowIdx = i + 1;
    try {
      candSheet.getRange(rowIdx, 3).setValue('処理中…');

      const fullName = rows[i][0];
      const profile  = rows[i][1];

      // ★ 姓名の間のスペースで分割し、姓を取得
      const lastName = fullName.split(/[\\s　]/)[0]; // ← 変数は残してOK

      const profileMeta = normalizeProfileText(profile);
      const profileForPrompt = profileMeta.text;
      if (profileMeta.truncated) {
        _log('profile truncated', {
          RID,
          row: rowIdx,
          originalChars: profileMeta.originalLength,
          normalizedChars: profileMeta.normalizedLength,
          keptChars: profileForPrompt.length,
        });
      }
      const prompt  = buildPrompt('{姓}', profileForPrompt, jobCatalogPayload);
      _log('prompt stats', {
        RID,
        row: rowIdx,
        promptChars: prompt.length,
        profileChars: profileForPrompt.length,
        catalogChars: jobCatalogPayload.length,
      });
      let aiText;
      let data;

      if (USE_MATCH_API) {
        const headers = {};
        const body = {
          rid: RID,
          prompt,
          candidate: {
            name: fullName,
            last_name: lastName,
            profile: profileForPrompt,
          },
          jobCatalog: jobCatalogForApi,
          options: { locale: 'ja-JP', maxOutput: 1024, temperature: 0.4 },
        };
        _log('request keys', Object.keys(body));
        const json = postMatchApiWithBackoff(MATCH_API_URL_INMAIL, body, headers, 6);
        const adapted = adaptMatchApiInMailResponse(json);
        const normalized = normalizeInMailPayload(adapted.payload, adapted.rawText);
        const rootKeys = adapted.payload && typeof adapted.payload === 'object'
          ? Object.keys(adapted.payload)
          : [];
        if (!normalized || !Array.isArray(normalized.positions) || !normalized.positions.length) {
          throw new Error(`match-api payload missing positions (rootKeys=${rootKeys.join(',') || 'none'})`);
        }
        const safePositions = normalized.positions.map(p => ({
          id: p?.id || '',
          title: p?.title || '',
          company_desc: p?.company_desc || p?.company || '',
          salary: p?.salary || '',
          appeal_points: Array.isArray(p?.appeal_points) ? p.appeal_points : [],
        }));
        const subject = typeof normalized.subject === 'string' ? normalized.subject : '';
        const intro = typeof normalized.intro_sentence === 'string' ? normalized.intro_sentence : '';
        const closing = typeof normalized.closing_sentence === 'string' ? normalized.closing_sentence : '';
        if (!subject || !intro || !closing) {
          throw new Error(`match-api payload missing text fields (subject=${!!subject}, intro=${!!intro}, closing=${!!closing})`);
        }
        const sanitized = {
          positions: safePositions,
          subject,
          intro_sentence: intro,
          closing_sentence: closing,
        };
        aiText = JSON.stringify(sanitized);
        data = sanitized;
      } else {
        aiText  = callGemini(prompt);
        data    = JSON.parse(aiText);
      }

      /* 3-3. 本文パーツ整形 & 生成 */

      // ❶ ポジションブロック
      const positionsForBody = data.positions
        .map(p => `◆ ${p.company_desc}
　${p.title}（年収 ${p.salary}）
${p.appeal_points.map(pt => `　${pt}`).join('\n')}`
        ).join('\n\n');

      // ❷ intro / closing 内の実名を {姓} へ強制置換
      const safeIntro   = data.intro_sentence.replaceAll(lastName, '{姓}');
      const safeClosing = data.closing_sentence.replaceAll(lastName, '{姓}');

      /* 3-4. 本文生成 (目標スタイルに変更) */
      const body =
`{姓} 様

はじめまして。ハイクラス転職支援の TSUGU ${YOUR_NAME}と申します。

${safeIntro}

▼ご紹介可能な案件例
────────────────────────
${positionsForBody}

${safeClosing}

ご興味ございましたら、弊社 COO ${COO_NAME} より 20〜30 分で
ポジション詳細と市場動向をご説明いたします。

▼下記リンクよりご都合の良い日時をお選びください
${CALENDLY_URL}

どうぞよろしくお願いいたします。
――――――――――――――
${YOUR_NAME} ｜${YOUR_COMPANY}`; // ← 署名のスペースを調整

      /* 3-5. シート反映 */
      const posListForSheet = data.positions
        .map(p => `${p.id} - ${p.title}`)
        .join('\n');

      candSheet.getRange(rowIdx, 4, 1, 4).setValues([[
        posListForSheet,
        data.subject,
        body,
        aiText
      ]]);

      candSheet.getRange(rowIdx, 3).setValue('処理完了');
    } catch (err) {
      candSheet.getRange(rowIdx, 3).setValue('エラー');
      candSheet.getRange(rowIdx, 7).setValue(String(err).slice(0, 500));
      _log('error', { RID, row: rowIdx, message: String(err).slice(0, 200) });
    }
    handled++;
    if (USE_MATCH_API && i < rows.length - 1 && handled < MAX_BATCH) {
      rateLimitSleep(PER_ITEM_INTERVAL_MS);
    }
  }
  _log('finish', { RID, handled });
  ui.alert(`今回 ${handled} 名を処理しました。`);
}

/* ===== 4. プロンプトビルダー (改善版) ===== */
function buildPrompt(lastName, profile, jobListJson) {
  return `
あなたは、日本で活動する、超一流のハイクラス専門リクルーターです。
候補者の経歴を深く理解し、単なるポジション紹介ではなく「キャリアの新たな可能性を提示する、心を動かす一通」を作成してください。
最終的な出力は、後述の JSON スキーマに適合する **有効な JSON** のみです（コードフェンスや説明文は一切不要）。

# 厳守すべきルール
1. **呼称統一**: 候補者の呼称は必ず「{姓} 様」とする。
2. **過去所属企業の除外**: 候補者の過去在籍企業と同名の求人は必ず除外する。
3. **企業名の秘匿**: 本文・求人サマリーでは実社名を伏せ、代わりに魅力的な企業概要 (company_desc) を用いる。
4. **COO面談への誘導**: クロージングは必ず「弊社 COO ${COO_NAME} との 20〜30 分面談」へ繋げる。

# 作成ステップ
1. **候補者分析**: 経歴書から、候補者の専門性、具体的な実績、強みを深く理解する。
2. **求人選定**: 求人一覧の中から、候補者の経験とキャリア志向に最もマッチする求人を最大「2件」まで厳選する。
3. **JSON項目作成**: 以下の指示に従い、各項目を生成する。
    - **positions**:
        - 厳選した求人ごとに作成する。
        - **company_desc**: 「グローバル Commerce Media プラットフォーム」「国内リテールメディア立ち上げ企業」のように、事業内容が分かる魅力的な表現にする (25字以内)。
        - **title**: 求人の役職名をそのまま記載。
        - **salary**: 求人票の給与情報を記載。
        - **appeal_points**: 候補者の経歴に響くような訴求ポイントを「2点」抽出する。箇条書きの「・」を文頭に付ける。
    - **subject**: 「【限定スカウト】No.1求人のcompany_desc のポジションのご案内」という形式で作成する。
    - **intro_sentence**: 候補者の経歴から最も特筆すべき実績（在籍企業名＋具体的な役割）を引用し、「…してこられたご経歴に強く惹かれ、限定スカウトをお送りいたしました。」という自然で簡潔な一文を作成する。
    - **closing_sentence**: 「上記以外にも「広告×データ領域でのBizDev」「外資SaaSの日本ローンチ」など、{姓} 様のご志向に沿うポストを複数ご用意しています。」のように、紹介案件以外にも魅力的な選択肢があることを示唆する一文を作成する。

# お手本（このフォーマットとトーンを参考にしてください）
{
  "positions": [
    {
      "id": "JOB-001",
      "title": "シニアアカウントストラテジスト",
      "company_desc": "グローバル Commerce Media プラットフォーム",
      "salary": "800–1,100 万円",
      "appeal_points": [
        "・大手リテール＆ブランド向けにフルファネル施策を設計",
        "・CDP／データクリーンルーム連携など新機能導入を推進"
      ]
    },
    {
      "id": "JOB-002",
      "title": "アカウントディレクター",
      "company_desc": "国内リテールメディア立ち上げ企業",
      "salary": "750–1,000 万円",
      "appeal_points": [
        "・小売DX案件を起点に、広告在庫設計〜運用体制構築を統括",
        "・売上 KPI と広告体験の両立をリード"
      ]
    }
  ],
  "subject": "【限定スカウト】グローバル Commerce Media プラットフォームのポジションのご案内",
  "intro_sentence": "Criteo と楽天の双方でエンタープライズ広告主を担当され、リテール／ブランド横断の運用・分析・提案をリードしてこられたご経歴に強く惹かれ、限定スカウトをお送りいたしました。",
  "closing_sentence": "上記以外にも「広告×データ領域でのBizDev」「外資SaaSの日本ローンチ」など、{姓} 様のご志向に沿うポストを複数ご用意しています。"
}

# JSON スキーマ (この形式で出力してください)
{
  "positions": [
    {
      "id": "",
      "title": "",
      "company_desc": "",
      "salary": "",
      "appeal_points": []
    }
  ],
  "subject": "",
  "intro_sentence": "",
  "closing_sentence": ""
}

# 候補者情報
氏名: {姓} 様
PROFILE:
${profile}

# 求人一覧(JSON)
${jobListJson}
`;
}

/* ===== 5. Gemini 呼び出し (リトライ機能付き) ===== */
function callGemini(prompt) {
  const MAX_RETRIES = 3;    // 最大で3回まで試行する
  const RETRY_DELAY_MS = 5000; // 再試行までに5秒待つ

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const resp = UrlFetchApp.fetch(`${GEMINI_EP}?key=${GEMINI_KEY}`, {
        method : 'post',
        contentType : 'application/json',
        payload : JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4 }
        }),
        muteHttpExceptions: true,
      });

      const status = resp.getResponseCode();
      const body   = resp.getContentText();

      // 429 (rate limit) の場合、サーバ指定時間だけ待機して再試行
      if (status === 429) {
        if (i < MAX_RETRIES - 1) {
          const waitMs = parseRetryWait_(resp, body);
          console.warn(`Gemini API 429エラー。${(waitMs / 1000).toFixed(1)}秒後に再試行します... (${i + 1}/${MAX_RETRIES})`);
          Utilities.sleep(waitMs);
          continue;
        }
      }

      // 503エラーの場合、少し待ってから再試行する
      if (status === 503) {
        if (i < MAX_RETRIES - 1) { // 最後の試行でなければ
          console.log(`Gemini API 503エラー。${RETRY_DELAY_MS / 1000}秒後に再試行します... (${i + 1}/${MAX_RETRIES})`);
          Utilities.sleep(RETRY_DELAY_MS);
          continue; // ループの先頭に戻って再試行
        }
      }

      // 503以外のAPIエラー
      if (status !== 200) {
        throw new Error(`Gemini API Error: ${status} ${body}`);
      }

      // 正常に成功した場合
      const j   = JSON.parse(body);
      let  out  = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!out) throw new Error('Gemini応答が空: ' + body.slice(0, 200));

      if (out.startsWith('```')) {
        out = out.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
      }
      return out; // ★ 成功したら、ここで結果を返して関数を終了

    } catch (e) {
      console.error(`callGeminiでエラー発生: ${e.message}`);
      if (i < MAX_RETRIES - 1) {
        Utilities.sleep(RETRY_DELAY_MS); // ネットワークエラーなどでも待機
      } else {
        throw e; // 最終的に失敗した場合はエラーをスローする
      }
    }
  }
}

function parseRetryWait_(resp, body) {
  const headers = resp.getAllHeaders && resp.getAllHeaders();
  const retryAfter = headers && (headers['Retry-After'] || headers['retry-after']);
  if (retryAfter) {
    const sec = Number(retryAfter);
    if (!Number.isNaN(sec) && sec > 0) {
      return Math.max(1000, Math.ceil(sec * 1000));
    }
  }

  const match = /retry in\s+([0-9.]+)s/i.exec(body || '');
  if (match) {
    const sec = Number(match[1]);
    if (!Number.isNaN(sec) && sec > 0) {
      return Math.max(1000, Math.ceil(sec * 1000));
    }
  }

  // デフォルトは15秒待機
  return 15000;
}

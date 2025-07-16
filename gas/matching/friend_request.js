/* =====================================================================
 * Friend_Request - v2025-07-15 (Standalone Fix)
 * 役割：300文字以内の友達申請メッセージ生成（単体機能）
 * ===================================================================== */

// ---- この機能で使う固定値 ----
const SHEET_FR_ONLY     = 'Friend_Request';
const COL_NOTE_FR_ONLY  = 4;
const COL_STAT_FR_ONLY  = 5;
const COL_RAW_FR_ONLY   = 6;
const FR_BATCH_MAX_ONLY = 15;

const MATCH_URL_FR_ONLY     = 'https://match-service-650488873290.asia-northeast1.run.app/match?mode=scout';
const SA_EMAIL_FR_ONLY      = '650488873290-compute@developer.gserviceaccount.com';

const BYTE_LIMIT_FR_ONLY    = 22000;
const RETRY_MAX_FR_ONLY     = 3;


/* ---- メイン処理 ---- */
function runFriendRequest() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_FR_ONLY);
  if (!sheet) { ui.alert(`シート「${SHEET_FR_ONLY}」が見つかりません`); return; }

  const rows = sheet.getDataRange().getValues();
  let done = 0;

  for (let i = 1; i < rows.length && done < FR_BATCH_MAX_ONLY; i++) {
    if (rows[i][COL_STAT_FR_ONLY - 1]) continue;
    const R = i + 1;
    const name = String(rows[i][0] || '').trim();
    const prof = String(rows[i][1] || '').trim();

    try {
      sheet.getRange(R, COL_STAT_FR_ONLY).setValue('処理中…');

      const match = safeFetchMatch_FR_(prof);
      const top2 = (match.selected_positions || []).slice(0, 2);
      if (!top2.length) throw new Error('適合求人なし');

      // ★★★ 改善されたプロンプトを呼び出す ★★★
      const note = callGemini_FR_(buildFRPrompt_FR_(name, top2));

      sheet.getRange(R, COL_NOTE_FR_ONLY).setValue(note);
      sheet.getRange(R, COL_RAW_FR_ONLY).setValue(JSON.stringify(match));
      sheet.getRange(R, COL_STAT_FR_ONLY).setValue('処理完了');
    } catch (e) {
      sheet.getRange(R, COL_STAT_FR_ONLY).setValue('エラー');
      sheet.getRange(R, COL_RAW_FR_ONLY).setValue(String(e).slice(0, 300));
      console.warn(`FriendRequest row ${R}:`, e);
    }
    done++;
  }
  ui.alert(`${done} 名を処理しました`);
}

/**
 * 友達申請メッセージ用プロンプト生成（最終FIX版）
 * GAS が組み立てた「部品」を指示どおり結合させるだけ
 */
function buildFRPrompt_FR_(fullName, pos) {
  const lastName = fullName.split(/[\s　]/).pop() || fullName;      // 姓を安全抽出

  /* ── 部品を作る ── */
  const p1 = pos[0];
  const jobLine1 = `◆${p1.title}｜${p1.salary}`;
  let jobLine2 = '';
  if (pos[1]) {
    const p2 = pos[1];
    jobLine2 = `◆${p2.title}｜${p2.salary}`;
  }
  const calendlyUrl = 'https://calendly.com/k-nagase-tsugu/30min';
  const intro = `ハイクラス向け人材紹介会社"TSUGU"代表の服部です。${lastName}様のご経歴を拝見し、ぜひご紹介したい求人がございます。`;

  /* ── AI への手順書プロンプト ── */
  return `
あなたは提供された「構成要素」を、以下の「組み立て手順」に 100% 従って結合するボットです。余計な語句は一切追加しません。

# 組み立て手順
1.{greeting}
2.{subject}
3.{introduction}
(空行)
4.{job_section_header}
5.{job_line_1}
6.{job_line_2}
(空行)
7.{closing_line_1}
8.{closing_line_2}
(空行)
9.{call_to_action}
10.{link}

# 構成要素
{greeting}: "${lastName}様"
{subject}: "【国内トップ層向け案件紹介】"
{introduction}: "${intro}"
{job_section_header}: "―厳選求人例―"
{job_line_1}: "${jobLine1}"
{job_line_2}: "${jobLine2}"
{closing_line_1}: "いずれも裁量大きく、事業成長を牽引できるポジションです。"
{closing_line_2}: "他にも100社以上の非公開求人を扱っております。"
{call_to_action}: "ご興味あれば、面談をお願いいたします。"
{link}: "${calendlyUrl}"

# 絶対ルール
- 手順・構成要素にない語句や記号、絵文字を追加しない。
- 完成メッセージ本文だけを 300 文字以内で出力。説明・コードフェンス禁止。
`.trim();
}


/* ---- このファイル専用のヘルパー関数群 ---- */
// 元のコードのロジックを維持し、このファイル内で完結させるための部品です。

function safeFetchMatch_FR_(profileTxt) {
  /* ① ラップ後の bytes を計測して 32 kB 未満になるまで縮める */
  const wrap = t => JSON.stringify({ candidate: { linkedin_profile: { text: t } } });
  let txt = profileTxt;
  while (Utilities.newBlob(wrap(txt)).getBytes().length > 32000) {
    txt = txt.slice(0, Math.floor(txt.length * 0.6));   // 40 % カット
  }

  /* ② 共通オプション */
  const base = {
    method: 'post',
    contentType: 'application/json',
    payload: wrap(txt)
  };

  /* ③ 3 回リトライ (rate-limit / 500 のみ) */
  for (let i = 0; i < RETRY_MAX_FR_ONLY; i++) {
    const idTok = generateIdToken_FR_(SA_EMAIL_FR_ONLY, MATCH_URL_FR_ONLY);
    try {
      const res = UrlFetchApp.fetch(
        MATCH_URL_FR_ONLY,
        { ...base, headers: { Authorization: `Bearer ${idTok}` }, muteHttpExceptions: true }
      );
      if (res.getResponseCode() >= 400) {
        throw new Error(`Match API ${res.getResponseCode()}: ${res.getContentText().slice(0,120)}`);
      }
      return JSON.parse(res.getContentText());
    } catch (e) {
      if (i < RETRY_MAX_FR_ONLY - 1 && /rate limit|500/.test(String(e))) {
        Utilities.sleep(1500 * (i + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Match API 再試行上限');
}


function generateIdToken_FR_(sa, aud) {
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateIdToken`;
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ audience: aud, includeEmail: true }),
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` }
  });
  return JSON.parse(res).token;
}

function callGemini_FR_(prompt) {
  const GEMINI_KEY_FR = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const GEMINI_EP_FR  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent';

  const resp = UrlFetchApp.fetch(`${GEMINI_EP_FR}?key=${GEMINI_KEY_FR}`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4 }
    }),
    muteHttpExceptions: true,
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error(`Gemini API Error: ${resp.getResponseCode()} ${resp.getContentText()}`);
  }
  const j = JSON.parse(resp.getContentText());
  let out = j.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!out) throw new Error('Gemini応答が空');
  if (out.startsWith('```')) {
    out = out.replace(/^```[\s\S]*?\n/, '').replace(/```$/, '').trim();
  }
  return out;
}